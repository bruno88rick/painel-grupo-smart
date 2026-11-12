# Consumidor de decisões do Suporte (Agente de Suporte RN Sports)

Script: `consumidor_suporte.py` (Python 3, só biblioteca padrão, autocontido). Lê as decisões `modulo=suporte` que o Bruno grava no painel, confere cada uma contra `Rascunhos-painel.csv` e grava o recibo em `recibos/<decision_id>.json`. Não chama o Zendesk: quem envia é o agente. Contrato: `docs/contrato-suporte.md`.

## Configurar (uma vez)

Copie `config.suporte.example.json` para `config.suporte.json` na mesma pasta do script. Já vem com os ids de `decisoes.csv`, `recibos/` e `Rascunhos-painel.csv`. O `gws` precisa estar autenticado no Drive do Bruno.

## Ciclo do agente

1. Planejar: `python3 consumidor_suporte.py --plano`
   Imprime JSON com `acoes`. Decisões com versão velha, estado errado ou comentário inválido já recebem recibo `rejeitado` (aparecem em `rejeitadas`).
2. Executar cada ação no Zendesk:
   - `enviar_resposta`: enviar `texto` como resposta pública no chamado `id_chamado`, exatamente como está.
   - `refazer`: reescrever o rascunho seguindo `texto` (o pedido do Bruno).
   - `recusar`: não enviar; registrar `motivo` na nota interna.
3. Confirmar cada ação feita: `python3 consumidor_suporte.py --confirmar <decision_id> <link>`
   - aprovar: `<link>` obrigatório (link do chamado ou da resposta no Zendesk). Linha vira `enviado em ...`.
   - refazer: `<link>` pode ser `""`. Linha vira `ajuste pedido em ...`. Com `--novo-texto novo.txt`, o script também grava a nova versão (versao+1, `aguardando_aprovo`) com esse texto.
   - recusar: `<link>` pode ser `""`. Linha vira `recusado em ...: <motivo>`.

Sem gravar nada: acrescente `--teste` (sozinho, `--teste` faz o plano).

## Códigos de saída

- 0: ok. 1: ficou pendência (rode o mesmo comando de novo). 3: erro de dado ou argumento; leia a mensagem, nada foi gravado.
- 2: erro de autenticação no Drive. Pare tudo e peça para reconectar o Google Drive; não tente de novo antes.

## Segurança

- Só aplica se o hash da linha atual for igual ao da decisão e o estado começar por `aguardando_aprovo`. Senão o recibo é `rejeitado` com `versão desatualizada` (ou o motivo).
- Nunca reescreve `decisoes.csv`. Em `Rascunhos-painel.csv` só muda a linha da decisão (e acrescenta a nova versão no refazer).
- Ledger local (`ledger-suporte.json`) grava cada fase antes do recibo: `planejada` → `confirmando` → `rascunho_atualizado` → `recibo_criado`. Se cair no meio, rodar `--confirmar` de novo só completa o que falta.
- Recibo que já existe não é refeito. Se o create der erro, o script confere se o arquivo existe antes de tentar de novo.
