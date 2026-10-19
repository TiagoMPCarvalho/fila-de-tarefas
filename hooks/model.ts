import type { Bg, Item, Step, Usage } from '../types'

// Lógica pura da fila: formatação, custo por modelo e espelho do plano do Claude.

export type ApiUsage = {
  model: string
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

export const clip = (text: string, max: number): string => {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? one.slice(0, max - 1) + '…' : one
}

// O app embrulha texto colado (<pasted_content id="…">…</pasted_content>) e injeta avisos do sistema: isso não é
// o pedido, só ocupa a linha. Os avisos do sistema saem inteiros (com o conteúdo); do texto colado e dos /comandos sai só
// o invólucro, e o conteúdo fica. HTML de verdade no texto fica como está.
const NOISE = /<(system-reminder|local-command-[a-z]+|command-[a-z]+)\b[^>]*>[\s\S]*?<\/\1>/gi
const WRAPPERS = /<\/?(?:pasted_content|system-reminder|local-command-[a-z]+|command-[a-z]+)\b[^>]*>/gi

export const tidy = (raw: string): string => raw.replace(NOISE, ' ').replace(WRAPPERS, ' ').replace(/\s+/g, ' ').trim() || raw.trim()

export const num = (n: number): string => {
  if (n >= 999_950) return `${(n / 1e6).toFixed(1).replace('.', ',')}M`.replace(',0M', 'M')
  if (n >= 1000) return `${(n / 1e3).toFixed(1).replace('.', ',')}k`.replace(',0k', 'k')
  return String(Math.round(n))
}

export const secs = (ms: number): string => {
  const s = Math.round(ms / 1000)
  return s >= 60 ? `${Math.floor(s / 60)}min ${s % 60}s` : `${s}s`
}

export const modelName = (id: string): string => {
  const s = id.replace(/^claude-/, '').replace(/\[.*\]$/, '').replace(/-\d{8}$/, '')
  const m = /^([a-z]+)-(\d+)(?:-(\d+))?$/.exec(s)
  return m ? `${m[1]} ${m[2]}${m[3] ? '.' + m[3] : ''}` : s
}

export const tokensOf = (u: Usage): number => u.input + u.output + u.cacheRead + u.cacheWrite

// "Tokens" do título: o que foi realmente processado de novo (entrada + saída + cache gravado).
// O cache lido (o contexto relido a cada requisição) domina o total, então vai à parte: "(+210k cache)".
const novos = (u: Usage): number => u.input + u.output + u.cacheWrite

// Peso de cada modelo na porcentagem: tokens novos; só se não houver nenhum, vale o total com cache.
const weigher = (list: Usage[]): { w: (u: Usage) => number; all: number; isNew: boolean } => {
  const isNew = list.some(u => novos(u) > 0)
  const w = isNew ? novos : tokensOf
  return { w, all: list.reduce((s, u) => s + w(u), 0), isNew }
}

export const addUsage = (list: Usage[], u: ApiUsage): Usage[] => {
  const add = {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
  }
  const k = list.findIndex(x => x.model === u.model)
  if (k < 0) return [...list, { model: u.model, ...add }]
  return list.map((x, j) =>
    j === k
      ? { ...x, input: x.input + add.input, output: x.output + add.output, cacheRead: x.cacheRead + add.cacheRead, cacheWrite: x.cacheWrite + add.cacheWrite }
      : x,
  )
}

const share = (n: number, all: number): string => {
  const p = Math.round((n / all) * 100)
  return p === 0 ? '<1' : String(p)
}

// Segunda linha de cada tarefa: "opus 5.5 70% · sonnet 5.5 30% · 18,2k tokens (+210k cache)".
// Sem custo medido, não há linha. `unmeasured`: chamadas do servidor (advisor) que a API não separa.
export const costLine = (list: Usage[], unmeasured = 0): string | undefined => {
  const { w, all, isNew } = weigher(list)
  if (all <= 0) return undefined
  const parts = [...list].sort((a, b) => w(b) - w(a)).map(u => `${modelName(u.model)} ${share(w(u), all)}%`)
  const cache = list.reduce((s, u) => s + u.cacheRead, 0)
  let line = `${parts.join(' · ')} · ${num(all)} tokens`
  if (isNew && cache > 0) line += ` (+${num(cache)} cache)`
  if (unmeasured > 0) line += ` · advisor×${unmeasured} sem medição`
  return line
}

// Detalhe para o cartão do "i": uma linha por modelo, com a quebra dos quatro contadores.
export const costDetail = (list: Usage[], unmeasured = 0): string[] => {
  const { w, all } = weigher(list)
  if (all <= 0) return []
  const lines = [...list]
    .sort((a, b) => w(b) - w(a))
    .map(
      u =>
        `${modelName(u.model)} ${share(w(u), all)}% · ${num(w(u))} novos (entrada ${num(u.input)}, saída ${num(u.output)}, cache gravado ${num(u.cacheWrite)}) · cache lido ${num(u.cacheRead)}`,
    )
  if (unmeasured > 0) lines.push(`advisor×${unmeasured}: tokens do servidor não separados pela API (podem faltar aqui)`)
  return lines
}

// Mensagem enviada com um turno rodando: o Claude a lê no mesmo turno (sem `wait`), então não entra na fila.
export const isFolded = (e: { turnId?: string; wait?: boolean }, running: Item | undefined): boolean =>
  running !== undefined && e.turnId !== undefined && e.wait !== true

export type Plan = {
  items?: { content?: unknown; status?: unknown }[]
  advance?: unknown
  done?: unknown
  start?: unknown
}

const asStatus = (s: unknown): Step['status'] => (s === 'completed' || s === 'in_progress' ? s : 'pending')

const setStatus = (steps: Step[], k: number, status: Step['status']): Step[] =>
  steps.map((s, j) => (j === k ? { ...s, status } : s))

// Espelha o que o Claude faz no cartão de plano (update_plan / TodoWrite): lista inteira, advance, done e start (base 1).
export const applyPlan = (old: Step[], plan: Plan): Step[] => {
  let steps = old
  if (Array.isArray(plan.items)) {
    steps = plan.items.map(x => {
      const content = String(x.content ?? '')
      const keep = old.find(o => o.content === content)
      return { content, status: asStatus(x.status), usage: keep?.usage ?? [], tools: keep?.tools ?? [] }
    })
  }
  if (Array.isArray(plan.done)) {
    for (const d of plan.done) if (typeof d === 'number' && steps[d - 1]) steps = setStatus(steps, d - 1, 'completed')
  }
  if (typeof plan.start === 'number' && steps[plan.start - 1]) steps = setStatus(steps, plan.start - 1, 'in_progress')
  if (plan.advance === true) {
    const cur = steps.findIndex(s => s.status === 'in_progress')
    if (cur >= 0) steps = setStatus(steps, cur, 'completed')
    const next = steps.findIndex(s => s.status === 'pending')
    if (next >= 0) steps = setStatus(steps, next, 'in_progress')
  }
  return steps
}

export const planKind = (tool: string): 'plan' | 'wrap' | 'todo' | undefined => {
  if (/^mcp__.+__update_plan$/.test(tool)) return 'plan'
  if (/^mcp__.+__wrap_up$/.test(tool)) return 'wrap'
  if (tool === 'TodoWrite') return 'todo'
  return undefined
}

export const progress = (steps: Step[]): { done: number; total: number } => ({
  done: steps.filter(s => s.status === 'completed').length,
  total: steps.length,
})

// Estado salvo por uma versão anterior pode não ter steps/usage.
export const fresh = (i: Item): Item => ({ ...i, steps: i.steps ?? [], usage: i.usage ?? [], text: i.text ?? i.label })

export const nextId = (list: Item[]): number => list.reduce((m, i) => Math.max(m, i.id), 0) + 1

export const toolLabel = (tool: string, a: Record<string, unknown>): { label: string; info?: string } => {
  const s = (k: string): string => (typeof a[k] === 'string' ? (a[k] as string) : '')
  const base = (p: string): string => p.split(/[\\/]/).pop() || p
  const file = s('file_path') || s('notebook_path') || s('path')
  switch (tool) {
    case 'Bash':
      return { label: `Bash: ${clip(s('command'), 48)}`, info: [s('description'), s('command')].filter(Boolean).join('\n') }
    case 'Agent':
    case 'Task':
      return { label: `Agente${s('subagent_type') ? ' ' + s('subagent_type') : ''}: ${clip(s('description') || s('prompt'), 40)}`, info: s('prompt') }
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { label: `${tool} ${base(file)}`, info: file }
    case 'Grep':
    case 'Glob':
      return { label: `${tool} ${clip(s('pattern'), 40)}`, info: [s('pattern'), s('path')].filter(Boolean).join('\n') }
    case 'WebFetch':
      return { label: `WebFetch ${clip(s('url'), 44)}`, info: s('url') }
    case 'WebSearch':
      return { label: `WebSearch ${clip(s('query'), 44)}`, info: s('query') }
    default: {
      const name = tool.startsWith('mcp__') ? tool.split('__').slice(2).join('__') || tool : tool
      return { label: name }
    }
  }
}

const counts = (names: string[]): string =>
  Object.entries(
    names.reduce<Record<string, number>>((m, n) => {
      m[n] = (m[n] ?? 0) + 1
      return m
    }, {}),
  )
    .map(([n, c]) => (c > 1 ? `${n}×${c}` : n))
    .join(' · ')

export const itemInfo = (i: Item, pos: number): string[] => {
  const p = progress(i.steps)
  const lines = [`Pedido: ${clip(i.text, 400)}`]
  if (i.status === 'waiting' && i.foldedInto !== undefined) lines.push('Estado: enviado durante a tarefa (lido no mesmo turno)')
  else if (i.status === 'waiting') lines.push(`Estado: em espera (#${pos})`)
  else if (i.status === 'running') lines.push('Estado: em andamento')
  else if (i.status === 'background') lines.push(`Estado: o Claude já respondeu; segue em segundo plano (${bgSummary(i.bg ?? [])})`)
  else lines.push(`Estado: ${i.outcome === undefined || i.outcome === 'answer' ? 'concluído' : 'interrompido'}${i.durationMs ? ' em ' + secs(i.durationMs) : ''}`)
  if (p.total > 0) lines.push(`Plano: ${p.done}/${p.total} etapas`)
  return [...lines, ...costDetail(i.usage, i.unmeasured)]
}

export const stepInfo = (s: Step, n: number): string[] => {
  const lines = [`Etapa ${n}: ${clip(s.content, 400)}`]
  const estado = { completed: 'concluída', in_progress: 'em andamento', stopped: 'interrompida aqui', pending: 'pendente' }
  lines.push(`Estado: ${estado[s.status]}`)
  if (s.tools.length) lines.push(`Ferramentas: ${counts(s.tools)}`)
  return [...lines, ...costDetail(s.usage)]
}

export const liveInfo = (text: string): string[] => text.split('\n').slice(0, 8).map(l => clip(l, 160))

// ---------- Segundo plano e mensagens que não são pedidos seus ----------

// O app e o Claude injetam mensagens como se fossem prompts (aviso de tarefa em segundo plano, mensagem de agente).
// Não são pedidos seus: não entram na fila, só atualizam o trabalho em segundo plano.
const MACHINE_KINDS = new Set(['task-notification', 'peer', 'peer-send-message', 'projects-relay', 'coordinator', 'observer', 'observer-activity', 'auto-continuation'])
// Só as marcas que SEMPRE são de máquina. <system-reminder> e <local-command-*> podem vir antes de um pedido de verdade
// (logo depois de um /comando), então não entram aqui: o tidy só tira o invólucro delas.
const MACHINE_TEXT = /^\s*<(?:task-notification|agent-message|teammate-message)\b/i

export const isMachine = (kind: string | undefined, raw: string): boolean =>
  (kind !== undefined && MACHINE_KINDS.has(kind)) || MACHINE_TEXT.test(raw)

export type Notice = { id?: string; status: 'done' | 'failed' }

// <task-notification><task-id>b721ngssn</task-id><status>completed</status>…
export const parseNotice = (raw: string): Notice => {
  const id = /<task-id>\s*([^<\s]+)\s*<\/task-id>/i.exec(raw)?.[1]
  const st = /<status>\s*([^<\s]+)\s*<\/status>/i.exec(raw)?.[1]?.toLowerCase() ?? ''
  return { id, status: /fail|error|kill|cancel|stop/.test(st) ? 'failed' : 'done' }
}

// Id que a ferramenta devolve ao iniciar um comando em segundo plano ("… running in background with ID: bwxfxbc2w").
export const parseBgId = (text: string): string | undefined => /\b(?:ID|id|task[_ -]?id)\s*[:=]\s*["']?([A-Za-z0-9_-]{6,})/.exec(text)?.[1]

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

export const bgRunning = (list: Bg[]): Bg[] => list.filter(b => b.status === 'running')

// "2 agentes, 1 comando"
export const bgSummary = (list: Bg[]): string => {
  const run = bgRunning(list)
  const agents = run.filter(b => b.kind === 'agent').length
  const cmds = run.length - agents
  return [agents > 0 ? plural(agents, 'agente', 'agentes') : '', cmds > 0 ? plural(cmds, 'comando', 'comandos') : ''].filter(Boolean).join(', ')
}

// Dá baixa num trabalho em segundo plano. Se era o último e o Claude já tinha respondido, o pedido termina.
// Sem id conhecido, um aviso de comando baixa o mais antigo que ainda roda (agentes só pelo id exato).
export const settleBg = (i: Item, id: string | undefined, status: 'done' | 'failed', anyCmd: boolean): Item => {
  const bg = i.bg ?? []
  let k = id === undefined ? -1 : bg.findIndex(b => b.id === id)
  if (k < 0 && anyCmd) k = bg.findIndex(b => b.kind === 'cmd' && b.status === 'running' && b.guess === true)
  if (k < 0) return i
  const next = bg.map((b, j) => (j === k ? { ...b, status } : b))
  const pending = next.some(b => b.status === 'running')
  if (i.status === 'background' && !pending) {
    return { ...i, bg: next, status: 'done', outcome: 'answer', live: undefined, liveInfo: undefined }
  }
  return { ...i, bg: next }
}

export const addBgUsage = (i: Item, id: string, u: ApiUsage): Item => {
  const bg = i.bg ?? []
  return { ...i, bg: bg.map(b => (b.id === id ? { ...b, usage: addUsage(b.usage, u) } : b)) }
}

// Qual pedido volta a rodar quando chega o aviso de segundo plano: o que está em segundo plano; senão o último concluído.
export const resumeTarget = (list: Item[]): number => {
  const top = (i: Item) => i.foldedInto === undefined
  let k = list.findLastIndex(i => i.status === 'background')
  if (k < 0) k = list.findLastIndex(i => top(i) && i.status === 'done' && (i.bg ?? []).length > 0)
  if (k < 0) k = list.findLastIndex(i => top(i) && i.status === 'done')
  return k
}

export const bgInfo = (b: Bg): string[] => [
  `${b.kind === 'agent' ? 'Agente' : 'Comando'}: ${clip(b.label, 400)}`,
  `Estado: ${b.status === 'running' ? 'rodando' : b.status === 'done' ? 'concluído' : 'falhou ou foi interrompido'}`,
  ...costDetail(b.usage),
]
