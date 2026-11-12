# Contrato do módulo E-mails: leitura, decisões e recibos

Fonte da verdade para o painel e para o Gestor de E-mails. O painel só lê os arquivos que o agente já mantém no ledger (Movimentos, Pendencias, Rascunhos e Alerts). Nenhum arquivo novo é pedido ao agente.

Privacidade: o conteúdo dos e-mails fica só no Mac. O painel mostra apenas conta, pasta, motivo, remetente, assunto, chegou_em e estado. Nunca corpo nem anexos.

Enquanto `EMAILS_INTEGRADO` estiver `false` em `src/Lib.gs` (`CHAVES`), os botões ficam desligados com o aviso "o agente ainda não lê estas decisões" e o servidor recusa gravar. A chave só vira `true` quando o agente ler as decisões.

## Como o painel lê os arquivos atuais

| Arquivo | Uso |
| --- | --- |
| `Movimentos.csv` | `message_id,conta,pasta,motivo,proposto_em,estado`. Linhas repetidas do mesmo `message_id`: vale a última do arquivo. `estado` é texto livre, classificado pelo começo: `proposto` e `aguardando novo sim` = esperando o sim; `movido`; `recusado`; `fora da entrada` / `já fora da entrada`; `substituído`. O texto inteiro aparece na tela |
| `Pendencias.csv` | `message_id,conta,remetente,assunto,chegou_em,motivo,precisa_resposta,rascunho,estado,fechado_em`. Última linha por `message_id`. `estado` pelo começo: `aberta`, `fechada`, `duplicado`, `saiu da entrada`. Só `aberta` aceita decisão |
| `Alerts.csv` | os 10 mais recentes por `created_at`, todos os tiers |
| `Rascunhos.csv` | lista quando houver linhas, com remetente e assunto da pendência do mesmo `message_id` |

Lotes do Mac (`<conta>:lote-<data>|<Pasta>`): o número de e-mails sai do começo do `motivo` (`13 e-mails por regras no Mac`). Se houver mais de um lote esperando o sim para a mesma conta e pasta, vale o de `proposto_em` mais recente; os mais antigos aparecem como observação e ficam fora da contagem e do hash.

## Itens e hash

Texto canônico igual ao dos outros módulos: cada campo (vazio se ausente) com `\r\n` e `\r` trocados por `\n` e espaços das pontas tirados (trim do JS); campos unidos com U+001F (␟); SHA-256 do UTF-8, hex minúsculo.

### Grupo de movimentação (`tipo_item=grupo`)

Um grupo por `conta` + `pasta`, com as linhas que esperam o sim (sem os lotes antigos). `item_id` = `grupo:<conta>|<pasta>`, ex. `grupo:Exchange|Promoções`. `versao` vazia.

```
grupo␟conta␟pasta␟(para cada linha, em ordem de message_id: message_id␟motivo␟proposto_em␟estado)
```

A ordem é a comparação simples de caracteres do `message_id` (a mesma de `sorted()` no Python). Um e-mail a mais, a menos ou com motivo diferente muda o hash.

Vetor (conferido em `test/v3-emails.test.js`): conta `Exchange`, pasta `Promoções`, linhas `outlook:BBB==` (`Loja Exemplo: oferta · propaganda`) e `outlook:AAA==` (`Farmácia Um: oferta do dia · propaganda`), ambas com `proposto_em=2026-11-12T14:05-03:00` e `estado=proposto`:

```
grupo␟Exchange␟Promoções␟outlook:AAA==␟Farmácia Um: oferta do dia · propaganda␟2026-11-12T14:05-03:00␟proposto␟outlook:BBB==␟Loja Exemplo: oferta · propaganda␟2026-11-12T14:05-03:00␟proposto
hash 9cc59d468cdcef97f4881b196623e989e1581b45ba1ce6081183a28dee67b91f
```

### Pendência (`tipo_item=pendencia`)

`item_id` = `pendencia:<message_id>`. `versao` vazia.

```
pendencia␟message_id␟conta␟remetente␟assunto␟chegou_em␟motivo␟precisa_resposta␟rascunho␟estado␟fechado_em
```

Vetor: `outlook:CCC==`, `Exchange`, `Banco Exemplo`, `Fatura fechou, débito em 18/11`, `2026-11-11T00:21-03:00`, `deixar saldo até 17/11`, `não`, vazio, `aberta`, vazio → `bdf8107628140b1d049193d35a8f187d86a4d471be497409ae3b340e7fb23b44`.

## Decisão (linha em decisoes.csv)

Mesmo arquivo e cabeçalho; o agente filtra por `modulo=emails`. `arte_fileId` vazio, `origem=painel`.

| tipo_item | decisao | comentario |
| --- | --- | --- |
| grupo | `aprovar` (mover o grupo inteiro) | `texto=...` opcional |
| grupo | `recusar` (deixar onde está) | `texto=<motivo>` opcional |
| pendencia | `resolvida` (marcar como resolvida) | `texto=...` opcional |
| pendencia | `pedir_rascunho` (preparar resposta no Mac) | `texto=<o que dizer>` opcional |

O servidor recusa (e não grava): chave desligada, item que não existe mais, estado que não aceita a decisão, hash diferente do atual e decisão repetida para o mesmo hash.

## O que o agente faz

| Decisão | Na caixa | No ledger |
| --- | --- | --- |
| aprovar | move as linhas do grupo (e o lote do Mac) | `estado=movido <data>` em cada linha |
| recusar | não move | `estado=recusado <data> (<motivo>)` |
| resolvida | nada no e-mail | `estado=fechada`, `fechado_em` |
| pedir_rascunho | prepara o rascunho no Mac | linha em `Rascunhos.csv`; `rascunho` da pendência |

Antes de aplicar, o agente recalcula o hash do grupo ou da pendência. Se for diferente do `snapshot_hash`, não aplica e grava recibo `rejeitado` com motivo `versão desatualizada`. Recibo em `recibos/<decision_id>.json`, mesmo formato dos outros módulos, com `agente: "Gestor de E-mails"`.
