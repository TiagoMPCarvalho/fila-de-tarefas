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

// Trabalho que segue rodando depois que o Claude termina de responder: subagente ou comando em segundo plano.
export type Bg = {
  id: string
  kind: 'agent' | 'cmd'
  label: string
  status: 'running' | 'done' | 'failed'
  usage: Usage[]
  // Comando cujo id real não veio na resposta da ferramenta: usa o id da chamada e só então vale o palpite "o mais antigo".
  guess?: boolean
}

export type Item = {
  id: number
  label: string
  text: string
  // 'background': o Claude já respondeu, mas ainda há subagente ou comando rodando para este pedido.
  status: 'waiting' | 'running' | 'background' | 'done'
  steps: Step[]
  usage: Usage[]
  bg?: Bg[]
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
