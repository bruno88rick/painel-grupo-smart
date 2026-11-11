# SPEC: Painel Grupo Smart v1 (pedido P-20261111-1)

Pedido do Bruno (11/11/2026, via Teammate Builder): painel visual para aprovar os designs e posts dos agentes, ver arte, detalhes e estado, começando pelos dados do Agente de Design, e que depois receba outros módulos.

## Escopo v1
- Apps Script Web App, executa como o Bruno, acesso só do Bruno. Código no repo privado `painel-grupo-smart`.
- Configuração única em `painel-fontes.json` (pasta `painel-grupo-smart` do Drive).
- Cache de 5 minutos e botão "Atualizar agora".
- Telas: Início, Designs, Posts, Biblioteca e produtos.
- Ações: Aprovar e Pedir ajuste, só em `entregue`, gravando em `decisoes.csv`.
- Tema claro e escuro, selos com texto, aviso por fonte quebrada.

## v1.1 (decisões versionadas, pedido do Teammate Builder em 11/11)
- Cada decisão leva `tipo_item`, `versao`, `arte_fileId` e `snapshot_hash` da versão exibida; o servidor recusa versão velha, estado inválido e decisão repetida.
- Recibos imutáveis em `recibos/<decision_id>.json`, escritos só pelos agentes; o painel mostra processado ou recusado.
- `decisoes.csv` sem `processado_em`; só o painel acrescenta linhas.
- "Publicado" só com link; horário vencido sem link vira "Aguardando confirmação".

## Fontes (módulo design)
- `pedidos-de-arte.csv` (pedidos e estados), `produtos.csv` (catálogo).
- Ledger do Design: `Artes.csv` (versões), `Posts.csv`, `Midia.csv`, `Checkpoints.csv`.
- Pasta de criativos: `post-*.md` (legenda, contas, horário).

## Critérios de aceite
- P-20261111-02 e P-20261111-03 aparecem em "Artes para aprovar" (dados de 11/11).
- A-20261109-01..05 aparecem como Refazer, sem contar como parados em 11/11.
- Decisão grava uma linha e o cartão passa a "Enviado, aguardando o agente" até existir o recibo.
- Decisão com hash velho não grava nada e a tela avisa.
- Arquivo ausente ou CSV quebrado mostra aviso e o resto funciona.
- Sem rolagem lateral a 390 px; capturas a 390 px e no desktop, claro e escuro.

## Fora do v1
- Processar as decisões (fica com o Agente de Design, ligado pelo Teammate Builder).
- Módulos além do Design.
