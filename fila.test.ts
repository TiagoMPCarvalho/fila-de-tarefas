import { test, expect } from 'claude-code/testing'

import { addUsage, applyPlan, costLine, isFolded, isMachine, modelName, num, parseBgId, parseNotice, tidy } from './hooks/model'

const PANE = { plugin: 'fila-de-tarefas', component: 'Pane', props: {} as never, requestId: 'fila-de-tarefas' } as const
const BAND = { plugin: 'fila-de-tarefas', component: 'AbovePrompt', props: { hasSurvey: false } as never } as const

const usage = (model: string, input: number, output: number) => ({
  model,
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
})

const PLAN = 'mcp__ccd_turn__update_plan'

test('formatação: modelo, tokens e custo por modelo', () => {
  expect(modelName('claude-opus-5-5')).toBe('opus 5.5')
  expect(modelName('claude-sonnet-4-20250514')).toBe('sonnet 4')
  expect(num(999)).toBe('999')
  expect(num(1000)).toBe('1k')
  expect(num(12_345)).toBe('12,3k')
  expect(num(2_500_000)).toBe('2,5M')
  expect(costLine([])).toBeUndefined()
  const list = addUsage(addUsage([], usage('claude-opus-5-5', 100, 50)), usage('claude-sonnet-5-5', 50, 25))
  expect(costLine(list)).toBe('opus 5.5 67% · sonnet 5.5 33% · 225 tokens')
})

test('cache lido não infla o título: vai entre parênteses; só cache ainda conta', () => {
  const withCache = addUsage([], { ...usage('claude-opus-5-5', 1000, 500), cache_read_input_tokens: 200_000, cache_creation_input_tokens: 500 })
  expect(costLine(withCache)).toBe('opus 5.5 100% · 2k tokens (+200k cache)')
  expect(costLine(addUsage([], { ...usage('m', 0, 0), cache_read_input_tokens: 4000 }))).toBe('m 100% · 4k tokens')
  expect(costLine(withCache, 2)).toContain('advisor×2 sem medição')
})

test('mensagem enviada no meio do turno é "dobrada" no turno; com wait ela espera a vez', () => {
  const running = { id: 1, label: 'a', text: 'a', status: 'running' as const, steps: [], usage: [] }
  expect(isFolded({ turnId: 't1' }, running)).toBe(true)
  expect(isFolded({ turnId: 't1', wait: true }, running)).toBe(false)
  expect(isFolded({}, running)).toBe(false)
  expect(isFolded({ turnId: 't1' }, undefined)).toBe(false)
})

test('plano: lista, advance, done e start (base 1)', () => {
  let s = applyPlan([], { items: [{ content: 'a', status: 'in_progress' }, { content: 'b', status: 'pending' }, { content: 'c', status: 'pending' }] })
  expect(s.map(x => x.status)).toEqual(['in_progress', 'pending', 'pending'])
  s = applyPlan(s, { advance: true })
  expect(s.map(x => x.status)).toEqual(['completed', 'in_progress', 'pending'])
  s = applyPlan(s, { done: [2], start: 3 })
  expect(s.map(x => x.status)).toEqual(['completed', 'completed', 'in_progress'])
  // Reenviar a lista com o mesmo texto preserva o custo já medido da etapa.
  const withCost = s.map((x, k) => (k === 0 ? { ...x, usage: addUsage([], usage('m', 1, 1)) } : x))
  const again = applyPlan(withCost, { items: [{ content: 'a', status: 'completed' }] })
  expect(again[0]?.usage.length).toBe(1)
})

test('fila: espera, corre e conclui, com posição', async ($, on) => {
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: 'ok' }))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const texto = async () => JSON.stringify(await ui.drawn()).replace(/","/g, '')

  await $.prompt.submit({ text: 'primeiro pedido' })
  await $.prompt.submit({ text: 'segundo pedido' })
  expect(await texto()).toContain('#1 primeiro pedido')
  expect(await texto()).toContain('#2 segundo pedido')

  await $.turn.start({ text: 'primeiro pedido', turnId: 't1' })
  const a = await texto()
  expect(a).toContain('primeiro pedido')
  expect(a).not.toContain('#1 primeiro')
  expect(a).toContain('#1 segundo pedido')

  await $.turn.complete({ reason: 'answer', answer: '', turnId: 't1', durationMs: 1, isAborted: false } as never)
  expect(await texto()).toContain('✓ primeiro pedido')
})

test('plano do Claude vira sub-itens da tarefa e cada etapa mostra o custo por modelo', async ($, on) => {
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: 'ok' }))
  on('tool.call', () => ({ result: {}, text: 'ok', ref: 0, isReadOnly: true }) as never)
  let model = 'claude-opus-5-5'
  on('turn.step', async function* (_$, e) {
    yield { kind: 'stop', stopReason: 'end_turn', usage: usage(model, 100, 50) } as never
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: usage(model, 100, 50) } as never
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const texto = async () => JSON.stringify(await ui.drawn()).replace(/","/g, '')
    const step = async (turnId: string, index: number) => {
      for await (const _ of $.turn.step({ turnId, index, model, messageCount: 1 })) void _
    }

    await $.prompt.submit({ text: 'implementar a fila' })
    await $.turn.start({ text: 'implementar a fila', turnId: `t-${surface}` })
    await $.tool.call({
      tool: PLAN,
      items: [
        { content: 'Ler o mod atual', status: 'in_progress' },
        { content: 'Implementar', status: 'pending' },
      ],
    } as never)
    const plano = await texto()
    expect(plano).toContain('├')
    expect(plano).toContain('└')
    expect(plano).toContain('Ler o mod atual')
    expect(plano).toContain('Implementar')

    await step(`t-${surface}`, 0)
    model = 'claude-sonnet-5-5'
    await step(`t-${surface}`, 1)
    const custo = await texto()
    // Tarefa e etapa em andamento acumulam os dois modelos: 150 + 150 tokens, metade para cada.
    expect(custo).toContain('opus 5.5 50% · sonnet 5.5 50% · 300 tokens')

    await $.tool.call({ tool: PLAN, advance: true } as never)
    const feito = await texto()
    expect(feito).toContain('✓ Ler o mod atual')

    await $.turn.complete({ reason: 'answer', answer: '', turnId: `t-${surface}`, durationMs: 4000, isAborted: false } as never)
    const fim = await texto()
    expect(fim).toContain('✓ implementar a fila')
    expect(fim).toContain('300 tokens')
    await ui.unmount()
    model = 'claude-opus-5-5'
  }
})

test('sem tokens medidos não há linha de custo', async ($, on) => {
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  await $.prompt.submit({ text: 'pedido sem custo' })
  await $.turn.start({ text: 'pedido sem custo', turnId: 'tz' })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const t = JSON.stringify(await ui.drawn())
  expect(t).toContain('pedido sem custo')
  expect(t).not.toContain('tokens')
})

test('o "i" abre os detalhes ao clicar, fecha ao clicar de novo e só um fica aberto', async ($, on) => {
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  await $.prompt.submit({ text: 'primeiro pedido com detalhes' })
  await $.prompt.submit({ text: 'segundo pedido com detalhes' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const raw = async () => JSON.stringify(await ui.drawn())
    expect(await raw()).not.toContain('"key":"d-t1"')
    await ui.press({ key: 'b-t1' })
    const aberto = await raw()
    expect(aberto).toContain('"key":"d-t1"')
    expect(aberto).toContain('Pedido: primeiro pedido com detalhes')
    expect(aberto).toContain('Estado: em espera (#1)')
    // Abrir outro fecha o anterior.
    await ui.press({ key: 'b-t2' })
    const outro = await raw()
    expect(outro).toContain('"key":"d-t2"')
    expect(outro).not.toContain('"key":"d-t1"')
    // Clicar de novo no aberto fecha.
    await ui.press({ key: 'b-t2' })
    expect(await raw()).not.toContain('"key":"d-t2"')
    await ui.unmount()
  }
})

test('mensagem enviada no meio do turno não fica esperando para sempre', async ($, on) => {
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: 'ok' }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const texto = async () => JSON.stringify(await ui.drawn()).replace(/","/g, '')

  await $.prompt.submit({ text: 'tarefa A' })
  await $.turn.start({ text: 'tarefa A', turnId: 'tA' })
  await $.prompt.submit({ text: 'mensagem B no meio', turnId: 'tA' } as never)
  const meio = await texto()
  // Entra sob a tarefa que a lê, não como posição na fila.
  expect(meio).toContain('↪ mensagem B no meio')
  expect(meio).not.toContain('#1 mensagem B')

  await $.turn.complete({ reason: 'answer', answer: '', turnId: 'tA', durationMs: 5, isAborted: false } as never)
  const fim = await texto()
  expect(fim).toContain('✓ tarefa A')
  expect(fim).not.toContain('◦')

  // Uma continuação sem texto não toma o lugar de um pedido que espera a vez.
  await $.prompt.submit({ text: 'tarefa C' })
  await $.turn.start({ text: '', turnId: 'tX' })
  const cont = await texto()
  expect(cont).toContain('(continuação)')
  expect(cont).toContain('#1 tarefa C')
})

test('o que for interrompido fica vermelho, com a etapa em que parou', async ($, on) => {
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: 'ok' }))
  on('tool.call', () => ({ result: {}, text: 'ok', ref: 0, isReadOnly: true }) as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const texto = async () => JSON.stringify(await ui.drawn()).replace(/","/g, '')
    await $.prompt.submit({ text: `parar no meio ${surface}` })
    await $.turn.start({ text: `parar no meio ${surface}`, turnId: `p-${surface}` })
    await $.tool.call({
      tool: PLAN,
      items: [
        { content: `Etapa feita ${surface}`, status: 'completed' },
        { content: `Etapa cortada ${surface}`, status: 'in_progress' },
        { content: `Etapa que nem começou ${surface}`, status: 'pending' },
      ],
    } as never)
    await $.turn.complete({ reason: 'aborted', answer: '', turnId: `p-${surface}`, durationMs: 9, isAborted: true } as never)
    const t = await texto()
    expect(t).toContain(`✗ parar no meio ${surface}`)
    expect(t).toContain(`✗ Etapa cortada ${surface}`)
    expect(t).not.toContain(`Etapa que nem começou ${surface}`)
    expect(t).toContain('"color":"red')
    await ui.unmount()
  }
})

test('o "i" não usa hover nem cartão flutuante (nada absoluto no painel nem na faixa)', async ($, on) => {
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  await $.prompt.submit({ text: 'pedido sem cartão' })
  await $.turn.start({ text: 'pedido sem cartão', turnId: 'tc' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ ...PANE, surface })
    const t = JSON.stringify(await pane.drawn())
    expect(t).toContain('"label":"ⓘ"')
    expect(t).not.toContain('"position":"absolute"')
    expect(t).not.toContain('"hover"')
    await pane.unmount()
    const band = await $.ui.mount({ ...BAND, surface })
    expect(JSON.stringify(await band.drawn())).not.toContain('ⓘ')
    await band.unmount()
  }
})

test('rótulo sem o invólucro de texto colado: só o pedido ocupa a linha', async ($, on) => {
  expect(tidy('<pasted_content id="1b64"> Em algum momento do jogo </pasted_content>')).toBe('Em algum momento do jogo')
  // Avisos do sistema saem inteiros; HTML de verdade no pedido fica.
  expect(tidy('<system-reminder>aviso</system-reminder> corrija o <div> do menu')).toBe('corrija o <div> do menu')
  // Só invólucro, sem nada dentro: cai no texto original em vez de ficar vazio.
  expect(tidy('<pasted_content id="x"></pasted_content>')).toBe('<pasted_content id="x"></pasted_content>')

  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  const raw = '<pasted_content id="1b64"> Em algum momento do jogo</pasted_content>'
  await $.prompt.submit({ text: raw })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const antes = JSON.stringify(await ui.drawn())
  expect(antes).toContain('#1 Em algum momento do jogo')
  expect(antes).not.toContain('pasted_content')
  // O turno que começa com o texto cru encontra o mesmo item (não cria um duplicado).
  await $.turn.start({ text: raw, turnId: 'tp' })
  const depois = JSON.stringify(await ui.drawn())
  expect(depois).toContain('Em algum momento do jogo')
  expect(depois).not.toContain('pasted_content')
  expect(depois).not.toContain('(continuação)')
})

test('a faixa acima do campo mostra só a tarefa principal e o que está pensando', async ($, on) => {
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: 'ok' }))
  on('tool.call', () => ({ result: {}, text: 'ok', ref: 0, isReadOnly: true }) as never)
  on('turn.step', async function* (_$, e) {
    yield { kind: 'stop', stopReason: 'end_turn', usage: usage('claude-opus-5-5', 100, 50) } as never
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: usage('claude-opus-5-5', 100, 50) } as never
  })
  await $.prompt.submit({ text: 'tarefa principal' })
  await $.prompt.submit({ text: 'tarefa que espera' })
  await $.turn.start({ text: 'tarefa principal', turnId: 'tb' })
  await $.tool.call({ tool: PLAN, items: [{ content: 'Etapa um', status: 'in_progress' }, { content: 'Etapa dois', status: 'pending' }] } as never)
  for await (const _ of $.turn.step({ turnId: 'tb', index: 0, model: 'claude-opus-5-5', messageCount: 1 })) void _
  await $.tool.call({ tool: 'Edit', file_path: 'C:/x/register.tsx', old_string: 'a', new_string: 'b' } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ ...BAND, surface })
    const t = JSON.stringify(await band.drawn())
    expect(t).toContain('tarefa principal')
    expect(t).toContain('↳ Edit register.tsx')
    // Plano, custo, fila e ⓘ ficam só no painel.
    for (const fora of ['Etapa um', 'Etapa dois', 'tokens', 'tarefa que espera', 'ⓘ', '#1']) expect(t).not.toContain(fora)
    await band.unmount()
  }

  // Sem tarefa rodando, a faixa some.
  await $.turn.complete({ reason: 'answer', answer: '', turnId: 'tb', durationMs: 3, isAborted: false } as never)
  // (o motor do teste não tem faixa própria: o mod passou a vez com next(e), e é isso que a falha abaixo mostra)
  let cedeu = false
  try {
    await $.ui.mount({ ...BAND, surface: 'terminal' })
  } catch (err) {
    cedeu = /no implementation for ui.render/.test(String(err))
  }
  expect(cedeu).toBe(true)
})

const NOTE = (id: string, status = 'completed') =>
  `<task-notification><task-id>${id}</task-id><status>${status}</status></task-notification>`

const heads = (t: string) => (t.match(/"key":"e-t[0-9]+"/g) ?? []).length

test('avisos de segundo plano e mensagens de agente não são pedidos', () => {
  expect(isMachine('task-notification', 'qualquer coisa')).toBe(true)
  expect(isMachine('peer', 'oi')).toBe(true)
  expect(isMachine(undefined, '<agent-message from="a0b0c9a1ddbfb3e1c">relatório</agent-message>')).toBe(true)
  expect(isMachine(undefined, NOTE('b721ngssn'))).toBe(true)
  // O que o usuário digita (inclusive texto colado) continua sendo pedido.
  expect(isMachine('composer', 'faça o vídeo')).toBe(false)
  expect(isMachine(undefined, '<pasted_content id="1b64"> Em algum momento</pasted_content>')).toBe(false)
  expect(parseNotice(NOTE('b721ngssn'))).toEqual({ id: 'b721ngssn', status: 'done' })
  expect(parseNotice(NOTE('x123456', 'failed')).status).toBe('failed')
  expect(parseBgId('Command running in background with ID: bwxfxbc2w. Output is being written to: C:/x')).toBe('bwxfxbc2w')
  expect(parseBgId('sem id aqui')).toBeUndefined()
})

test('mensagens de máquina não entram na fila', async ($, on) => {
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await $.prompt.submit({ text: 'tarefa real' })
  await $.prompt.submit({ text: '<agent-message from="a0b0c9a1ddbfb3e1c">relatório do agente</agent-message>' })
  await $.prompt.submit({ text: NOTE('nenhum0001') })
  const t = JSON.stringify(await ui.drawn())
  expect(heads(t)).toBe(1)
  expect(t).toContain('#1 tarefa real')
  expect(t).not.toContain('agent-message')
  expect(t).not.toContain('task-notification')
})

test('comando em segundo plano mantém o pedido em andamento até o aviso de que terminou', async ($, on) => {
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: 'ok' }))
  on('tool.call', () => ({ result: {}, text: 'Command running in background with ID: bg12345678. Output is being written to: x', ref: 0, isReadOnly: true }) as never)
  on('turn.step', async function* (_$, e) {
    yield { kind: 'stop', stopReason: 'end_turn', usage: usage('claude-opus-5-5', 100, 50) } as never
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: usage('claude-opus-5-5', 100, 50) } as never
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const texto = async () => JSON.stringify(await ui.drawn())

  await $.prompt.submit({ text: 'renderizar o vídeo' })
  await $.turn.start({ text: 'renderizar o vídeo', turnId: 'r1' })
  await $.tool.call({ tool: 'Bash', command: 'node render.js', description: 'Renderizar o vídeo', run_in_background: true } as never)
  await $.turn.complete({ reason: 'answer', answer: '', turnId: 'r1', durationMs: 5, isAborted: false } as never)

  // O Claude respondeu, mas o render segue rodando: não pode aparecer como concluído.
  const rodando = await texto()
  expect(rodando).not.toContain('✓ renderizar o vídeo')
  expect(rodando).toContain('renderizar o vídeo')
  expect(rodando).toContain('$ Renderizar o vídeo')
  const faixa = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const f = JSON.stringify(await faixa.drawn())
  expect(f).toContain('renderizar o vídeo')
  expect(f).toContain('em segundo plano: 1 comando')

  // Chega o aviso (sessão parada): não vira pedido, e o pedido termina.
  await $.prompt.submit({ text: NOTE('bg12345678') })
  const fim = await texto()
  expect(fim).toContain('✓ renderizar o vídeo')
  expect(heads(fim)).toBe(1)

  // O turno que o aviso dispara continua o MESMO pedido: volta a rodar e os tokens se somam nele.
  await $.turn.start({ text: NOTE('bg12345678'), turnId: 'r2' })
  for await (const _ of $.turn.step({ turnId: 'r2', index: 0, model: 'claude-opus-5-5', messageCount: 1 })) void _
  const retomado = await texto()
  expect(heads(retomado)).toBe(1)
  expect(retomado).not.toContain('✓ renderizar o vídeo')
  expect(retomado).toContain('150 tokens')
  await $.turn.complete({ reason: 'answer', answer: '', turnId: 'r2', durationMs: 3, isAborted: false } as never)
  const final = await texto()
  expect(heads(final)).toBe(1)
  expect(final).toContain('✓ renderizar o vídeo')
})

test('subagente em segundo plano: aparece rodando, soma os tokens e termina', async ($, on) => {
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: 'ok' }))
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'ag-1' }) as never)
  on('turn.step', async function* (_$, e) {
    yield { kind: 'stop', stopReason: 'end_turn', usage: usage('claude-sonnet-5-5', 100, 50) } as never
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: usage('claude-sonnet-5-5', 100, 50) } as never
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const texto = async () => JSON.stringify(await ui.drawn())

  await $.prompt.submit({ text: 'conferir os quadros do vídeo' })
  await $.turn.start({ text: 'conferir os quadros do vídeo', turnId: 'a0' })
  await $.agent.spawn({ tool_use_id: 'tu1', prompt: 'conferir quadros', description: 'Conferir os quadros', subagentType: 'Explore' } as never)
  await $.turn.complete({ reason: 'answer', answer: '', turnId: 'a0', durationMs: 2, isAborted: false } as never)
  const rodando = await texto()
  expect(rodando).toContain('🤖 Conferir os quadros')
  expect(rodando).not.toContain('✓ conferir os quadros do vídeo')

  // O loop do subagente gasta tokens: contam no subagente e no pedido.
  for await (const _ of $.turn.step({ turnId: 'a1', index: 0, model: 'claude-sonnet-5-5', messageCount: 1, agentId: 'ag-1' } as never)) void _
  expect(await texto()).toContain('sonnet 5.5 100% · 150 tokens')

  // Quando o subagente termina, o pedido termina junto.
  await $.turn.complete({ reason: 'answer', answer: '', turnId: 'a1', durationMs: 4, isAborted: false, agentId: 'ag-1' } as never)
  const fim = await texto()
  expect(fim).toContain('✓ conferir os quadros do vídeo')
  expect(heads(fim)).toBe(1)
})

test('pedido de verdade logo depois de um /comando não é tratado como mensagem de máquina', async ($, on) => {
  const real =
    '<local-command-caveat>Caveat: as mensagens abaixo foram de um comando local.</local-command-caveat> <command-name>/fila</command-name> pergunta real do usuário'
  expect(isMachine(undefined, real)).toBe(false)
  expect(tidy(real)).toBe('pergunta real do usuário')

  on('prompt.submit', (_$, e) => ({ text: e.text }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await $.prompt.submit({ text: real })
  const t = JSON.stringify(await ui.drawn())
  expect(heads(t)).toBe(1)
  expect(t).toContain('#1 pergunta real do usuário')
  expect(t).not.toContain('Caveat')
})

test('a descrição do subagente não é trocada pelo prompt dele', async ($, on) => {
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'ag-9' }) as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await $.prompt.submit({ text: 'tarefa com agente' })
  await $.turn.start({ text: 'tarefa com agente', turnId: 'g0' })
  await $.agent.spawn({ tool_use_id: 'tu9', prompt: 'prompt enorme e interno do agente', description: 'Descrição curta', subagentType: 'Explore' } as never)
  // O loop do subagente começa DEPOIS do spawn, com o prompt dele como texto.
  await $.turn.start({ text: 'prompt enorme e interno do agente', turnId: 'g1', agentId: 'ag-9' } as never)
  const t = JSON.stringify(await ui.drawn())
  expect(t).toContain('🤖 Descrição curta')
  expect(t).not.toContain('prompt enorme')
})

test('um aviso sozinho não sequestra o próximo pedido seu', async ($, on) => {
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: 'ok' }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const texto = async () => JSON.stringify(await ui.drawn())
  await $.prompt.submit({ text: 'pedido antigo' })
  await $.turn.start({ text: 'pedido antigo', turnId: 'w0' })
  await $.turn.complete({ reason: 'answer', answer: '', turnId: 'w0', durationMs: 1, isAborted: false } as never)
  // Chega um aviso com a sessão parada, mas nenhum turno nasce dele.
  await $.prompt.submit({ text: NOTE('sem-turno-1') })
  // O pedido seguinte é seu: tem de rodar como pedido novo, não retomar o antigo.
  await $.prompt.submit({ text: 'pedido novo' })
  await $.turn.start({ text: 'pedido novo', turnId: 'w1' })
  const t = await texto()
  expect(heads(t)).toBe(2)
  expect(t).toContain('✓ pedido antigo')
  expect(t).toContain('pedido novo')
  expect(t).not.toContain('#1 pedido novo')
})

test('aviso com id desconhecido não fecha um comando rastreado; sem id real, vale o palpite', async ($, on) => {
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: 'ok' }))
  let backgroundTaskId: string | undefined = 'real000001'
  on('tool.call', () => ({ result: backgroundTaskId ? { backgroundTaskId } : {}, text: 'started', ref: 0, isReadOnly: true }) as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const texto = async () => JSON.stringify(await ui.drawn())

  // Comando que o próprio app mandou para segundo plano (sem run_in_background no pedido): o id real vem no registro.
  await $.prompt.submit({ text: 'rodar testes longos' })
  await $.turn.start({ text: 'rodar testes longos', turnId: 'u0' })
  await $.tool.call({ tool: 'Bash', command: 'npm test', description: 'Rodar os testes' } as never)
  await $.turn.complete({ reason: 'answer', answer: '', turnId: 'u0', durationMs: 1, isAborted: false } as never)
  expect(await texto()).toContain('$ Rodar os testes')
  expect(await texto()).not.toContain('✓ rodar testes longos')

  // Aviso de outro id (um agente, um comando que não rastreamos): o comando continua rodando.
  await $.prompt.submit({ text: NOTE('outro-id-999') })
  expect(await texto()).not.toContain('✓ rodar testes longos')
  // O aviso do id certo encerra.
  await $.prompt.submit({ text: NOTE('real000001') })
  expect(await texto()).toContain('✓ rodar testes longos')

  // Sem id real em lugar nenhum (só run_in_background): o id é palpite, e um aviso desconhecido baixa esse comando.
  backgroundTaskId = undefined
  await $.prompt.submit({ text: 'rodar outro comando' })
  await $.turn.start({ text: 'rodar outro comando', turnId: 'u1' })
  await $.tool.call({ tool: 'Bash', command: 'node x.js', description: 'Outro comando', run_in_background: true } as never)
  await $.turn.complete({ reason: 'answer', answer: '', turnId: 'u1', durationMs: 1, isAborted: false } as never)
  expect(await texto()).not.toContain('✓ rodar outro comando')
  await $.prompt.submit({ text: NOTE('id-que-nao-conheco') })
  expect(await texto()).toContain('✓ rodar outro comando')
})
