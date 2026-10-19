export type Usage = {
  model: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export type Step = {
  content: string
  status: 'pending' | 'in_progress' | 'completed' | 'stopped'
  usage: Usage[]
  tools: string[]
}

export type Item = {
  id: number
  label: string
  text: string
  status: 'waiting' | 'running' | 'done'
  steps: Step[]
  usage: Usage[]
  outcome?: 'answer' | 'aborted' | 'refusal' | 'error'
  durationMs?: number
  live?: string
  liveInfo?: string
  // Id da tarefa em andamento quando este pedido foi enviado no meio do turno (o Claude o lê no mesmo turno).
  foldedInto?: number
  // Chamadas que o servidor executou dentro da requisição (ex.: advisor) e cujos tokens a API não separa.
  unmeasured?: number
}

declare module 'claude-code' {
  interface PluginState {
    'fila-de-tarefas': { items: Item[]; frame: number; pinned: string[] }
  }
}
