import { atom, read, update } from 'claude-code'
import type { Elements, Register } from 'claude-code'

import type { Bg, Item, Step } from '../types'
import {
  addBgUsage,
  addUsage,
  applyPlan,
  bgInfo,
  bgRunning,
  bgSummary,
  clip,
  costLine,
  fresh,
  isFolded,
  isMachine,
  itemInfo,
  liveInfo,
  nextId,
  parseBgId,
  parseNotice,
  planKind,
  resumeTarget,
  settleBg,
  stepInfo,
  tidy,
  toolLabel,
} from './model'
import type { Notice, Plan } from './model'

const PANE = 'fila-de-tarefas'
const MAX_ITEMS = 30
const MAX_TOOLS = 60
const MAX_BG = 60

const items = atom({ plugin: 'fila-de-tarefas', key: 'items' } as const, [] as Item[])
const frame = atom({ plugin: 'fila-de-tarefas', key: 'frame' } as const, 0)
const pinned = atom({ plugin: 'fila-de-tarefas', key: 'pinned' } as const, [] as string[])

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

type Tags = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>

// A tarefa que está sendo trabalhada: a que roda agora ou, se o Claude já respondeu, a que segue em segundo plano.
const activeIndex = (list: Item[]): number => {
  const run = list.findIndex(i => i.status === 'running')
  return run >= 0 ? run : list.findLastIndex(i => i.status === 'background')
}

const patch = (k: number, fn: (i: Item) => Item) => (list: Item[]) => (k < 0 ? list : list.map((i, j) => (j === k ? fn(fresh(i)) : i)))

// Aplica fn à tarefa que está rodando agora (a única; as demais ficam como estão).
const onRunning = (fn: (i: Item) => Item) => (list: Item[]) => patch(list.findIndex(i => i.status === 'running'), fn)(list)

const onActive = (fn: (i: Item) => Item) => (list: Item[]) => patch(activeIndex(list), fn)(list)

// Dono de um subagente: o pedido em cujo segundo plano ele consta; senão o que está ativo.
const onAgent = (agentId: string, fn: (i: Item) => Item) => (list: Item[]) => {
  const owner = list.findLastIndex(i => (i.bg ?? []).some(b => b.id === agentId))
  return patch(owner >= 0 ? owner : activeIndex(list), fn)(list)
}

// Entra no segundo plano do pedido ativo ou, se já consta, só atualiza. O rótulo só muda quando `relabel`: a descrição que
// o Claude deu ao subagente vale mais que o texto do prompt dele (que chega no turn.start, às vezes antes do spawn).
const upsertBg = (i: Item, b: Bg, relabel = false): Item => {
  const bg = i.bg ?? []
  const k = bg.findIndex(x => x.id === b.id)
  if (k < 0) return { ...i, bg: [...bg, b].slice(-MAX_BG) }
  return { ...i, bg: bg.map((x, j) => (j === k ? { ...x, label: relabel ? b.label || x.label : x.label, status: b.status } : x)) }
}

// Aviso de que um trabalho em segundo plano terminou: dá baixa no pedido dono, pelo id. Só se o id não bater com nenhum
// conhecido é que vale o palpite "o comando mais antigo", e só entre comandos cujo id real nunca veio (`guess`).
const settleAny = (list: Item[], n: Notice): Item[] => {
  let k = n.id === undefined ? -1 : list.findIndex(i => (i.bg ?? []).some(b => b.id === n.id))
  if (k < 0) k = list.findIndex(i => (i.bg ?? []).some(b => b.kind === 'cmd' && b.status === 'running' && b.guess === true))
  return patch(k, i => settleBg(i, n.id, n.status, true))(list)
}

type Ctx = {
  t: Tags
  frame: number
  pins: string[]
  toggle: (key: string) => void
}

// "ⓘ" ao lado do item (só no painel): clicar abre os detalhes logo abaixo, clicar de novo fecha.
// Sem hover nem cartão flutuante: o detalhe entra no fluxo da lista, então nada fica cortado e o clique funciona em
// qualquer superfície.
const Info = (c: Ctx, key: string) => {
  const { Text, Button } = c.t
  return [
    <Text key={`sp-${key}`}> </Text>,
    <Button key={`b-${key}`} plain dimColor label="ⓘ" onPress={() => c.toggle(key)} />,
  ]
}

const Detail = (c: Ctx, key: string, lines: () => string[]) => {
  const { Box, Text } = c.t
  if (!c.pins.includes(key)) return null
  return (
    <Box key={`d-${key}`} flexDirection="column" paddingLeft={2}>
      {lines().map(l => (
        <Text dimColor>{l}</Text>
      ))}
    </Box>
  )
}

// Uma linha de título (máx. 1) + uma linha de custo (só se houver tokens medidos).
const Entry = (
  c: Ctx,
  o: { key: string; prefix: string; costPrefix: string; glyph: string; color?: string; dim?: boolean; label: string; cost?: string; info?: () => string[] },
) => {
  const { Box, Text } = c.t
  return (
    <Box key={`e-${o.key}`} flexDirection="column">
      <Box>
        {o.prefix !== '' && <Text dimColor>{o.prefix}</Text>}
        <Text color={o.color} dimColor={o.dim} wrap="truncate-end">{`${o.glyph} ${o.label}`}</Text>
        {o.info && Info(c, o.key)}
      </Box>
      {o.cost && (
        <Box>
          <Text dimColor wrap="truncate-end">{`${o.costPrefix}${o.cost}`}</Text>
        </Box>
      )}
      {o.info && Detail(c, o.key, o.info)}
    </Box>
  )
}

const spin = (c: Ctx): string => FRAMES[c.frame % FRAMES.length] ?? '⠋'

const stepGlyph = (c: Ctx, s: Step): string =>
  s.status === 'completed' ? '✓' : s.status === 'in_progress' ? spin(c) : s.status === 'stopped' ? '✗' : '○'

const branch = (last: boolean) => ({ prefix: last ? '  └ ' : '  ├ ', costPrefix: last ? '      ' : '  │   ' })

// Sub-item do plano do Claude: ├ / └ , glifo de estado, custo na linha de baixo.
const StepRow = (c: Ctx, i: Item, s: Step, n: number, last: boolean) =>
  Entry(c, {
    key: `s${i.id}.${n}`,
    ...branch(last),
    glyph: stepGlyph(c, s),
    color: s.status === 'in_progress' ? 'yellow' : s.status === 'completed' ? 'green' : s.status === 'stopped' ? 'red' : undefined,
    dim: s.status === 'pending' || s.status === 'completed',
    label: s.content,
    cost: costLine(s.usage),
    info: () => stepInfo(s, n + 1),
  })

// Trabalho em segundo plano (subagente ou comando) ligado ao pedido.
const BgRow = (c: Ctx, i: Item, b: Bg, n: number, last: boolean) =>
  Entry(c, {
    key: `g${i.id}.${n}`,
    ...branch(last),
    glyph: b.status === 'running' ? spin(c) : b.status === 'done' ? '✓' : '✗',
    color: b.status === 'running' ? 'yellow' : b.status === 'done' ? 'green' : 'red',
    dim: b.status === 'done',
    label: `${b.kind === 'agent' ? '🤖 ' : '$ '}${b.label}`,
    cost: costLine(b.usage),
    info: () => bgInfo(b),
  })

// Mensagem enviada no meio do turno: aparece sob a tarefa que a leu.
const FoldedRow = (c: Ctx, k: Item, bad: boolean) =>
  Entry(c, {
    key: `f${k.id}`,
    prefix: '  ',
    costPrefix: '',
    glyph: '↪',
    color: bad ? 'red' : undefined,
    dim: !bad,
    label: k.label,
    info: () => itemInfo(k, 0),
  })

const Task = (c: Ctx, i: Item, pos: number, kids: Item[]) => {
  const { Box, Text } = c.t
  const run = i.status === 'running'
  const active = run || i.status === 'background'
  const bad = i.status === 'done' && i.outcome !== undefined && i.outcome !== 'answer'
  const head = Entry(c, {
    key: `t${i.id}`,
    prefix: '',
    costPrefix: '  ',
    glyph: active ? spin(c) : i.status === 'waiting' ? '◦' : bad ? '✗' : '✓',
    color: active ? 'yellow' : bad ? 'red' : i.status === 'done' ? 'green' : undefined,
    dim: !run && !bad,
    label: i.status === 'waiting' ? `#${pos} ${i.label}` : i.label,
    cost: costLine(i.usage, i.unmeasured),
    info: () => itemInfo(i, pos),
  })
  const folded = kids.map(k => FoldedRow(c, k, bad))

  if (!active) {
    // Interrompida: fica vermelha, com a etapa em que parou logo abaixo.
    const stopped = bad ? i.steps.map((s, n) => ({ s, n })).filter(x => x.s.status === 'stopped') : []
    if (folded.length === 0 && stopped.length === 0) return head
    return (
      <Box key={`task-${i.id}`} flexDirection="column">
        {head}
        {folded}
        {stopped.map((x, k) => StepRow(c, i, x.s, x.n, k === stopped.length - 1))}
      </Box>
    )
  }

  // Ativa: plano do Claude como sub-itens e, depois, o segundo plano (só o que roda ou falhou; o concluído vira uma linha).
  const steps = i.steps
  const cur = steps.findIndex(s => s.status === 'in_progress')
  const bgAll = i.bg ?? []
  const bgShown = bgAll.map((b, n) => ({ b, n })).filter(x => x.b.status !== 'done')
  const bgDone = bgAll.length - bgShown.length
  const total = steps.length + bgShown.length + (bgDone > 0 ? 1 : 0)

  const liveRow = (prefix: string) =>
    run && i.live ? (
      <Box key={`l${i.id}`} flexDirection="column">
        <Box>
          <Text dimColor>{prefix}</Text>
          <Text color="yellow" dimColor wrap="truncate-end">{`↳ ${i.live}`}</Text>
          {i.liveInfo && Info(c, `l${i.id}`)}
        </Box>
        {i.liveInfo && Detail(c, `l${i.id}`, () => liveInfo(i.liveInfo ?? ''))}
      </Box>
    ) : null

  return (
    <Box key={`task-${i.id}`} flexDirection="column">
      {head}
      {folded}
      {steps.map((s, n) => {
        const last = n === total - 1
        return (
          <Box key={`sw-${i.id}.${n}`} flexDirection="column">
            {StepRow(c, i, s, n, last)}
            {n === cur && liveRow(last ? '      ' : '  │   ')}
          </Box>
        )
      })}
      {bgShown.map((x, k) => BgRow(c, i, x.b, x.n, steps.length + k === total - 1))}
      {bgDone > 0 && (
        <Text dimColor color="green">{`  └ ✓ ${bgDone} em segundo plano concluído${bgDone === 1 ? '' : 's'}`}</Text>
      )}
      {(cur < 0 || steps.length === 0) && liveRow('  ')}
    </Box>
  )
}

const view = (c: Ctx, list: Item[]) => {
  const { Box } = c.t
  const rows = list.map(fresh)
  const ids = new Set(rows.map(r => r.id))
  // Mensagens lidas no meio de um turno aparecem sob a tarefa; sem a tarefa na lista, valem como itens próprios.
  const isKid = (r: Item) => r.foldedInto !== undefined && ids.has(r.foldedInto)
  // Itens antigos que eram avisos de máquina (estado salvo por versões anteriores) não aparecem mais.
  const top = rows.filter(r => !isKid(r) && !isMachine(undefined, r.text))
  let wait = 0
  const dones = top.filter(i => i.status === 'done').slice(-10)
  const shown = top.filter(i => i.status !== 'done' || dones.includes(i))
  return (
    <Box flexDirection="column">
      {shown.map(i => Task(c, i, i.status === 'waiting' ? ++wait : 0, rows.filter(r => r.foldedInto === i.id)))}
    </Box>
  )
}

const toggleKey = ($: Parameters<typeof update>[0], key: string) =>
  update($, pinned, p => (p.includes(key) ? [] : [key]))

export const register: Register = on => {
  // Chegou aviso/mensagem de máquina (não é pedido seu): o próximo turno é continuação, não um pedido novo.
  let wake = false

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'fila', description: 'Abrir o painel da fila de tarefas' })
    void $.ui.open({ id: PANE, title: 'Fila de tarefas' })
    // Animação local do spinner: não envolve o modelo, logo não gasta tokens.
    $.clock.every(150, async () => {
      const list = await read($, items)
      if (list.some(i => i.status === 'running' || i.status === 'background')) await update($, frame, n => (n + 1) % FRAMES.length)
    })
    // Rede de segurança: se um evento de fim de subagente se perder, o roster da sessão diz quem já terminou.
    $.clock.every(3000, async () => {
      const list = await read($, items)
      if (!list.some(i => (i.bg ?? []).some(b => b.kind === 'agent' && b.status === 'running'))) return
      const roster = new Map((await $.agent.list()).map(a => [a.id, a.status]))
      await update($, items, l =>
        l.map(i => {
          let cur = fresh(i)
          for (const b of cur.bg ?? []) {
            const s = roster.get(b.id)
            if (b.kind === 'agent' && b.status === 'running' && (s === 'completed' || s === 'failed' || s === 'killed')) {
              cur = settleBg(cur, b.id, s === 'completed' ? 'done' : 'failed', false)
            }
          }
          return cur
        }),
      )
    })
    return next(e)
  })

  on('command.run', { command: 'fila' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: 'Fila de tarefas' })
    return { text: opened.isPlaced ? 'Painel da fila aberto.' : 'Painel pedido, mas esta janela não o desenhou: ' + opened.reason }
  })

  on('prompt.submit', async ($, e, next) => {
    if (isMachine(e.origin?.kind, e.text)) {
      // Aviso de tarefa em segundo plano, mensagem de agente etc.: não entra na fila, só atualiza o segundo plano.
      // Se já há um turno rodando, o aviso entra nele; só vira continuação quando a sessão estava parada.
      wake = !(await read($, items)).some(i => i.status === 'running')
      if (/<task-notification/i.test(e.text)) await update($, items, list => settleAny(list, parseNotice(e.text)))
      return next(e)
    }
    // Um pedido de verdade desfaz qualquer "continuação" pendente: o próximo turno é dele.
    wake = false
    const text = tidy(e.text)
    if (!e.command && !e.isMeta && text) {
      await update($, items, list => {
        const running = list.find(i => i.status === 'running')
        const parent = isFolded(e, running) ? running?.id : undefined
        const item: Item = { id: nextId(list), label: clip(text, 60), text, status: 'waiting', steps: [], usage: [], foldedInto: parent }
        return [...list, item].slice(-MAX_ITEMS)
      })
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) {
      // Subagente: entra (ou volta) no segundo plano do pedido ativo, com a descrição que o Claude deu.
      const id = e.agentId
      await update($, items, onAgent(id, i => upsertBg(i, { id, kind: 'agent', label: clip(e.text, 60), status: 'running', usage: [] })))
      return next(e)
    }
    const machine = wake || isMachine(undefined, e.text)
    wake = false
    await update($, items, list => {
      if (list.some(i => i.status === 'running')) return list
      if (machine) {
        // Continuação por aviso de segundo plano: o mesmo pedido volta a rodar (e os tokens seguem nele).
        const k = resumeTarget(list)
        if (k >= 0) return patch(k, i => ({ ...i, status: 'running', outcome: undefined, live: undefined, liveInfo: undefined }))(list)
        const text = '(continuação)'
        return [...list, { id: nextId(list), label: text, text, status: 'running' as const, steps: [], usage: [] }].slice(-MAX_ITEMS)
      }
      const typed = tidy(e.text)
      // Um turno sem texto (continuação) nunca toma o lugar de um pedido que está esperando a vez.
      const own = (i: Item) => i.status === 'waiting' && i.foldedInto === undefined
      const exact = typed ? list.findIndex(i => own(i) && i.text === typed) : -1
      const k = exact >= 0 ? exact : typed ? list.findIndex(own) : -1
      if (k >= 0) return list.map((i, j) => (j === k ? { ...fresh(i), status: 'running' as const } : i))
      const text = typed || '(continuação)'
      return [...list, { id: nextId(list), label: clip(text, 60), text, status: 'running' as const, steps: [], usage: [] }].slice(-MAX_ITEMS)
    })
    return next(e)
  })

  // Subagente criado: vira trabalho do pedido ativo (rodando em primeiro ou em segundo plano).
  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    const id = typeof result === 'object' && result !== null ? (result as { agentId?: string }).agentId : undefined
    if (id !== undefined) {
      await update($, items, onActive(i => upsertBg(i, { id, kind: 'agent', label: clip(e.description || e.prompt, 60), status: 'running', usage: [] }, true)))
    }
    return result
  }).catch(($, e, next) => next(e))

  // Cada requisição ao modelo (de qualquer agente) devolve os tokens reais, por modelo.
  on('turn.step', async function* ($, e, next) {
    const who = e.agentId ? '🤖 ' : ''
    await update($, items, onRunning(i => ({ ...i, live: `${who}pensando…`, liveInfo: undefined })))
    const stream = next(e)
    let talking = false
    for await (const chunk of stream) {
      if (chunk.kind === 'text' && !talking) {
        talking = true
        await update($, items, onRunning(i => ({ ...i, live: `${who}respondendo…`, liveInfo: undefined })))
      } else if (chunk.kind === 'stop' && chunk.usage) {
        const u = chunk.usage
        const charge = (i: Item): Item => {
          const k = i.status === 'running' ? i.steps.findIndex(s => s.status === 'in_progress') : -1
          const charged = { ...i, usage: addUsage(i.usage, u), steps: k < 0 ? i.steps : i.steps.map((s, j) => (j === k ? { ...s, usage: addUsage(s.usage, u) } : s)) }
          return e.agentId ? addBgUsage(charged, e.agentId, u) : charged
        }
        await update($, items, e.agentId ? onAgent(e.agentId, charge) : onRunning(charge))
      }
      yield chunk
    }
    const result = await stream.result
    // O advisor roda dentro da requisição e a API não separa os tokens dele: conta a chamada, sem inventar custo.
    const server = result.serverToolUses?.length ?? 0
    if (server > 0) await update($, items, onActive(i => ({ ...i, unmeasured: (i.unmeasured ?? 0) + server })))
    return result
  })

  on('tool.call', async ($, e, next) => {
    const args = e as unknown as Record<string, unknown>
    const kind = planKind(e.tool)
    if (kind === undefined) {
      const { label, info } = toolLabel(e.tool, args)
      const who = e.agentId ? '🤖 ' : ''
      await update(
        $,
        items,
        onRunning(i => {
          const k = i.steps.findIndex(s => s.status === 'in_progress')
          return {
            ...i,
            live: who + label,
            liveInfo: info,
            steps: k < 0 ? i.steps : i.steps.map((s, j) => (j === k ? { ...s, tools: [...s.tools, e.tool].slice(-MAX_TOOLS) } : s)),
          }
        }),
      )
    }
    const result = await next(e)
    const denied = typeof result === 'object' && result !== null && 'deny' in result
    // Comando em segundo plano (pedido por `run_in_background` ou mandado para lá pelo próprio app): o pedido segue
    // "em andamento" mesmo depois do Claude responder. O id real vem no registro da ferramenta (`backgroundTaskId`);
    // o texto é só reserva, e sem id nenhum vale o da chamada, marcado como palpite.
    if (e.tool === 'Bash' && !denied && typeof result === 'object' && result !== null) {
      const rec = (result as { result?: { backgroundTaskId?: unknown } }).result
      const real = typeof rec?.backgroundTaskId === 'string' && rec.backgroundTaskId !== '' ? rec.backgroundTaskId : undefined
      const asked = args.run_in_background === true
      if (real !== undefined || asked) {
        const found = real ?? parseBgId(String((result as { text?: unknown }).text ?? ''))
        const label = clip(String(args.description || args.command || 'comando'), 60)
        const bg: Bg = { id: found ?? e.tool_use_id, kind: 'cmd', label, status: 'running', usage: [], guess: found === undefined || undefined }
        await update($, items, onActive(i => upsertBg(i, bg)))
      }
    }
    // O cartão de plano do Claude vira os sub-itens da tarefa que está rodando.
    if (kind !== undefined && e.agentId === undefined && !denied) {
      const plan: Plan = kind === 'todo' ? { items: args.todos as Plan['items'] } : (args as Plan)
      await update(
        $,
        items,
        onRunning(i => ({
          ...i,
          steps: kind === 'wrap' ? i.steps.map(s => ({ ...s, status: 'completed' as const })) : applyPlan(i.steps, plan),
        })),
      )
    }
    return result
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      // Fim do loop de um subagente: dá baixa nele (falhou se foi interrompido ou deu erro).
      const id = e.agentId
      await update($, items, onAgent(id, i => settleBg(i, id, e.reason === 'answer' ? 'done' : 'failed', false)))
      return next(e)
    }
    const bad = e.reason !== 'answer'
    await update($, items, list => {
      const run = list.find(i => i.status === 'running')
      return list.map(i => {
        if (run === undefined) return i
        // Mensagens lidas durante o turno terminam junto com ele (e ficam vermelhas se ele foi interrompido).
        if (i.status === 'waiting' && i.foldedInto === run.id) return { ...fresh(i), status: 'done' as const, outcome: e.reason }
        if (i.id !== run.id) return i
        const r = fresh(i)
        // O Claude terminou de responder, mas há subagente ou comando ainda rodando: o pedido NÃO está concluído.
        const stillWorking = !bad && bgRunning(r.bg ?? []).length > 0
        return {
          ...r,
          status: stillWorking ? ('background' as const) : ('done' as const),
          outcome: stillWorking ? undefined : e.reason,
          durationMs: (r.durationMs ?? 0) + e.durationMs,
          live: undefined,
          liveInfo: undefined,
          // Interrompido ou com erro: a etapa em andamento fica marcada onde parou.
          steps: bad ? r.steps.map(s => (s.status === 'in_progress' ? { ...s, status: 'stopped' as const } : s)) : r.steps,
          // Sem medição passo a passo (módulo recarregado no meio), vale o total do turno.
          usage: r.usage.length > 0 || !e.usage ? r.usage : addUsage([], e.usage),
        }
      })
    })
    return next(e)
  })

  // Faixa acima do campo de digitação: só a tarefa principal e o que está sendo pensado/feito agora (2 linhas).
  // Plano, custo, fila e detalhes ficam só no painel "Fila de tarefas".
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, items)
    const k = activeIndex(list)
    if (e.props.hasSurvey || k < 0) return next(e)
    const it = fresh(list[k] as Item)
    const f = await read($, frame)
    const { Box, Text } = $.ui.resolve(e)
    const live = it.status === 'background' ? `em segundo plano: ${bgSummary(it.bg ?? [])}` : it.live
    return (
      <Box flexDirection="column">
        <Text color="yellow" dimColor={it.status === 'background'} wrap="truncate-end">{`${FRAMES[f % FRAMES.length] ?? '⠋'} ${it.label}`}</Text>
        {live && (
          <Text color="yellow" dimColor wrap="truncate-end">{`  ↳ ${live}`}</Text>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const list = await read($, items)
    const f = await read($, frame)
    const pins = await read($, pinned)
    const ctx: Ctx = { t: $.ui.resolve(e) as Tags, frame: f, pins, toggle: key => void toggleKey($, key) }
    if (list.length === 0) {
      const { Text } = ctx.t
      return <Text dimColor>Sem tarefas ainda.</Text>
    }
    return view(ctx, list)
  })
}
