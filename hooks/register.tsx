import { atom, read, update } from 'claude-code'
import type { Elements, Register } from 'claude-code'

import type { Item, Step } from '../types'
import {
  addUsage,
  applyPlan,
  clip,
  costLine,
  fresh,
  isFolded,
  itemInfo,
  liveInfo,
  nextId,
  planKind,
  stepInfo,
  tidy,
  toolLabel,
} from './model'
import type { Plan } from './model'

const PANE = 'fila-de-tarefas'
const MAX_ITEMS = 30
const MAX_TOOLS = 60

const items = atom({ plugin: 'fila-de-tarefas', key: 'items' } as const, [] as Item[])
const frame = atom({ plugin: 'fila-de-tarefas', key: 'frame' } as const, 0)
const pinned = atom({ plugin: 'fila-de-tarefas', key: 'pinned' } as const, [] as string[])

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

type Tags = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>

// Aplica fn à tarefa que está rodando agora (a única; as demais ficam como estão).
const onRunning = (fn: (i: Item) => Item) => (list: Item[]) => list.map(i => (i.status === 'running' ? fn(fresh(i)) : i))

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

// Sub-item do plano do Claude: ├ / └ , glifo de estado, custo na linha de baixo.
const StepRow = (c: Ctx, i: Item, s: Step, n: number, last: boolean) =>
  Entry(c, {
    key: `s${i.id}.${n}`,
    prefix: last ? '  └ ' : '  ├ ',
    costPrefix: last ? '      ' : '  │   ',
    glyph: stepGlyph(c, s),
    color: s.status === 'in_progress' ? 'yellow' : s.status === 'completed' ? 'green' : s.status === 'stopped' ? 'red' : undefined,
    dim: s.status === 'pending' || s.status === 'completed',
    label: s.content,
    cost: costLine(s.usage),
    info: () => stepInfo(s, n + 1),
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
  const bad = i.status === 'done' && i.outcome !== undefined && i.outcome !== 'answer'
  const head = Entry(c, {
    key: `t${i.id}`,
    prefix: '',
    costPrefix: '  ',
    glyph: run ? spin(c) : i.status === 'waiting' ? '◦' : bad ? '✗' : '✓',
    color: run ? 'yellow' : bad ? 'red' : i.status === 'done' ? 'green' : undefined,
    dim: i.status !== 'running' && !bad,
    label: i.status === 'waiting' ? `#${pos} ${i.label}` : i.label,
    cost: costLine(i.usage, i.unmeasured),
    info: () => itemInfo(i, pos),
  })
  const folded = kids.map(k => FoldedRow(c, k, bad))

  if (!run) {
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

  // Em andamento: plano do Claude como sub-itens, todos (o painel tem a lista inteira).
  const steps = i.steps
  const cur = steps.findIndex(s => s.status === 'in_progress')

  const liveRow = (prefix: string) =>
    i.live ? (
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
        const last = n === steps.length - 1
        return (
          <Box key={`sw-${i.id}.${n}`} flexDirection="column">
            {StepRow(c, i, s, n, last)}
            {n === cur && liveRow(last ? '      ' : '  │   ')}
          </Box>
        )
      })}
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
  const top = rows.filter(r => !isKid(r))
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
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'fila', description: 'Abrir o painel da fila de tarefas' })
    void $.ui.open({ id: PANE, title: 'Fila de tarefas' })
    // Animação local do spinner: não envolve o modelo, logo não gasta tokens.
    $.clock.every(150, async () => {
      const list = await read($, items)
      if (list.some(i => i.status === 'running')) await update($, frame, n => (n + 1) % FRAMES.length)
    })
    return next(e)
  })

  on('command.run', { command: 'fila' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: 'Fila de tarefas' })
    return { text: opened.isPlaced ? 'Painel da fila aberto.' : 'Painel pedido, mas esta janela não o desenhou: ' + opened.reason }
  })

  on('prompt.submit', async ($, e, next) => {
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
    if (e.agentId === undefined) {
      await update($, items, list => {
        if (list.some(i => i.status === 'running')) return list
        const typed = tidy(e.text)
        // Um turno sem texto (continuação) nunca toma o lugar de um pedido que está esperando a vez.
        const own = (i: Item) => i.status === 'waiting' && i.foldedInto === undefined
        const exact = typed ? list.findIndex(i => own(i) && i.text === typed) : -1
        const k = exact >= 0 ? exact : typed ? list.findIndex(own) : -1
        if (k >= 0) return list.map((i, j) => (j === k ? { ...fresh(i), status: 'running' as const } : i))
        const text = typed || '(continuação)'
        return [...list, { id: nextId(list), label: clip(text, 60), text, status: 'running' as const, steps: [], usage: [] }].slice(-MAX_ITEMS)
      })
    }
    return next(e)
  })

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
        await update(
          $,
          items,
          onRunning(i => {
            const k = i.steps.findIndex(s => s.status === 'in_progress')
            return {
              ...i,
              usage: addUsage(i.usage, u),
              steps: k < 0 ? i.steps : i.steps.map((s, j) => (j === k ? { ...s, usage: addUsage(s.usage, u) } : s)),
            }
          }),
        )
      }
      yield chunk
    }
    const result = await stream.result
    // O advisor roda dentro da requisição e a API não separa os tokens dele: conta a chamada, sem inventar custo.
    const server = result.serverToolUses?.length ?? 0
    if (server > 0) await update($, items, onRunning(i => ({ ...i, unmeasured: (i.unmeasured ?? 0) + server })))
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
    // O cartão de plano do Claude vira os sub-itens da tarefa que está rodando.
    const denied = typeof result === 'object' && result !== null && 'deny' in result
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
    if (e.agentId === undefined) {
      const bad = e.reason !== 'answer'
      await update($, items, list => {
        const run = list.find(i => i.status === 'running')
        return list.map(i => {
          if (run === undefined) return i
          // Mensagens lidas durante o turno terminam junto com ele (e ficam vermelhas se ele foi interrompido).
          if (i.status === 'waiting' && i.foldedInto === run.id) return { ...fresh(i), status: 'done' as const, outcome: e.reason }
          if (i.id !== run.id) return i
          const r = fresh(i)
          return {
            ...r,
            status: 'done' as const,
            outcome: e.reason,
            durationMs: e.durationMs,
            live: undefined,
            liveInfo: undefined,
            // Interrompido ou com erro: a etapa em andamento fica marcada onde parou.
            steps: bad ? r.steps.map(s => (s.status === 'in_progress' ? { ...s, status: 'stopped' as const } : s)) : r.steps,
            // Sem medição passo a passo (módulo recarregado no meio), vale o total do turno.
            usage: r.usage.length > 0 || !e.usage ? r.usage : addUsage([], e.usage),
          }
        })
      })
    }
    return next(e)
  })

  // Faixa acima do campo de digitação: só a tarefa principal e o que está sendo pensado/feito agora (2 linhas).
  // Plano, custo, fila e detalhes ficam só no painel "Fila de tarefas".
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, items)
    const run = list.find(i => i.status === 'running')
    if (e.props.hasSurvey || run === undefined) return next(e)
    const f = await read($, frame)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Text color="yellow" wrap="truncate-end">{`${FRAMES[f % FRAMES.length] ?? '⠋'} ${run.label}`}</Text>
        {run.live && (
          <Text color="yellow" dimColor wrap="truncate-end">{`  ↳ ${run.live}`}</Text>
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
