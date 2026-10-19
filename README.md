# fila-de-tarefas

Plugin pro Claude Code que mostra o que você pediu e o que o Claude está fazendo. Tem um painel "Fila de tarefas" e uma faixa em cima do campo de digitação.

O painel lista os pedidos (esperando, rodando, concluídos). O plano que o Claude monta vira sub-itens do pedido que está rodando, e embaixo de cada item aparece quanto de token foi gasto e em qual modelo. Se você interrompe no meio, o pedido e a etapa em que parou ficam em vermelho. Mensagem enviada com o Claude já trabalhando aparece embaixo da tarefa que a leu, com uma seta.

A faixa de cima mostra só duas linhas: o pedido que está rodando e o que o Claude está fazendo agora ("pensando…", "Edit menu.tsx").

```
⠋ Arrumar o menu do jogo…  ⓘ
  opus 5.5 70% · sonnet 5.5 30% · 18,2k tokens (+210k cache)
  ├ ✓ Ler o código  ⓘ
  │   opus 5.5 100% · 6k tokens
  ├ ⠋ Mexer no menu  ⓘ
  │   ↳ Edit menu.tsx
  └ ○ Testar
◦ #1 próximo pedido
```

O ⓘ abre um resumo do item (pedido, estado, plano e tokens por modelo). Passando o mouse no painel ele abre um cartão; clicando, os detalhes ficam fixos embaixo do item.

## Instalar

No terminal do Claude Code:

```
/plugin install fila-de-tarefas --marketplace TiagoMPCarvalho/fila-de-tarefas
```

Ou direto no shell:

```
claude plugin install fila-de-tarefas --marketplace TiagoMPCarvalho/fila-de-tarefas
```

Ele pergunta se pode adicionar o marketplace (responde `y`) e depois o escopo (o `user` vale pras próximas sessões também).

No app desktop o `/plugin` não roda. Lá é o + ao lado do campo de digitação, depois Plugins, Add marketplace com `TiagoMPCarvalho/fila-de-tarefas` e Add plugin.

Instalado, o painel abre com `/fila`.

## Como os números são contados

A porcentagem por modelo e o total usam entrada + saída + cache gravado. O cache lido (o contexto que o Claude relê a cada requisição) é bem maior que o resto e dominaria a conta, então aparece à parte, entre parênteses. O advisor roda dentro da requisição e a API não separa os tokens dele, por isso aparece como `advisor×N sem medição` em vez de um número.

O custo de uma etapa do plano é o que foi gasto enquanto ela estava em andamento. Quando o Claude avança o plano no meio de uma requisição, uma parte pode cair na etapa anterior.

## Limites

O painel só aparece onde a janela desenha painéis. Se o `/fila` responder que a janela não o desenhou, é isso.

Foi visto funcionando no app desktop. No terminal puro só passou pelos testes.

## Testes

```
claude plugin validate .
claude plugin test .
```
