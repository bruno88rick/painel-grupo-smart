# Contrato do módulo Suporte RN Sports: Rascunhos-painel.csv, decisões e recibos

Fonte da verdade para o painel e para o Agente de Suporte RN Sports. O painel só lê o Drive; quem responde no Zendesk é o agente.

Fluxo: o agente escreve o rascunho no Zendesk (nota interna) e uma linha em `Rascunhos-painel.csv` → o painel mostra a fila "Respostas para aprovar" → o Bruno decide e o painel grava uma linha em `decisoes.csv` → o agente aplica no Zendesk e grava `recibos/<decision_id>.json` → o painel mostra processado ou recusado.

Enquanto `SUPORTE_INTEGRADO` estiver `false` em `src/Lib.gs` (`CHAVES`), os botões ficam desligados com o aviso "o agente ainda não lê estas decisões" e o servidor recusa gravar. A chave só vira `true` quando o agente ler as decisões.

## Rascunhos-painel.csv (novo)

Pasta: a mesma do ledger do Suporte (ao lado de `Chamados.csv`, `Respostas.csv` e `Alerts.csv`). Escrito só pelo agente. Enquanto o arquivo não existir, a fila fica vazia e os rascunhos aparecem na lista "Rascunhos só no Zendesk" (lida de `Respostas.csv`).

Cabeçalho exato:

```
id_chamado,versao,evento,tipo,cliente_primeiro_nome,pedido_resumo,rascunho_texto,estado,zendesk_link,prazo_evento,atualizado_em
```

| Campo | Regra |
| --- | --- |
| `id_chamado` | id do chamado no Zendesk (o mesmo de `Chamados.csv`) |
| `versao` | inteiro; sobe a cada rascunho novo do mesmo chamado. Linhas antigas podem ficar; o painel usa a maior versão |
| `evento` | nome do evento como em `Chamados.csv` (ex.: `2ª Trilha Runners (13/12)`) |
| `tipo` | o mesmo de `Chamados.csv` (`cancelamento_reembolso`, `troca_percurso`, `correcao_dados`, `informacao_evento`, `parceria`, `outros`...) |
| `cliente_primeiro_nome` | só o primeiro nome |
| `pedido_resumo` | até 280 caracteres. **Sem CPF, e-mail, telefone ou data de nascimento** |
| `rascunho_texto` | o texto inteiro que irá ao cliente, com quebras de linha (campo entre aspas; aspas internas dobradas) |
| `estado` | texto livre, classificado pelo começo: `aguardando_aprovo...`, `aprovado...`, `ajuste...`, `recusado...`, `enviado...`. O painel mostra o texto inteiro. Só `aguardando_aprovo` aceita decisão |
| `zendesk_link` | `https://<conta>.zendesk.com/agent/tickets/<id>` (vazio se não houver) |
| `prazo_evento` | `aaaa-mm-dd`. Vazio: o painel tenta a data entre parênteses no nome do evento, ex. `(14/11)` |
| `atualizado_em` | ISO 8601 com `-03:00`. Não entra no hash |

Arquivo em UTF-8, linhas com CRLF ou LF.

## Texto canônico e hash

Para cada campo: texto (vazio se ausente) → trocar `\r\n` e `\r` por `\n` → tirar espaços das pontas (regra do `String.prototype.trim()` do JS). Juntar com U+001F (␟). SHA-256 do UTF-8, hex minúsculo.

```
resposta␟id_chamado␟versao␟evento␟tipo␟cliente_primeiro_nome␟pedido_resumo␟rascunho_texto␟estado␟zendesk_link␟prazo_evento
```

Vetor (conferido em `test/v3-suporte.test.js`):

| Campo | Valor |
| --- | --- |
| id_chamado, versao | `645`, `1` |
| evento, tipo | `2ª Trilha Runners (13/12)`, `correcao_dados` |
| cliente_primeiro_nome | `Carlos` |
| pedido_resumo | `Pede para corrigir a data.` |
| rascunho_texto | `Olá, Carlos!\n\nSó falta o ano.` |
| estado | `aguardando_aprovo` |
| zendesk_link | `https://exemplo.zendesk.com/agent/tickets/645` |
| prazo_evento | `2026-12-13` |
| **hash** | `dd235ce26ee191ea3e4bfe51281998d4857e85c240793b97f0f9144e2c2c5a94` |

Python: `"\u001f".join(["resposta"] + [norm(l[c]) for c in CAMPOS])`, com o mesmo `norm` de `docs/contrato-propostas.md` (trim do JS, não `str.strip()`).

## Decisão (linha em decisoes.csv)

Mesmo arquivo e mesmo cabeçalho dos outros módulos; o agente filtra por `modulo=suporte`.

```
id,quando,modulo,item_id,tipo_item,versao,arte_fileId,snapshot_hash,decisao,comentario,origem
```

| Campo | Valor |
| --- | --- |
| `modulo` | `suporte` |
| `item_id` | `resposta:<id_chamado>` |
| `tipo_item` | `resposta` |
| `versao` | versão exibida |
| `arte_fileId` | vazio |
| `snapshot_hash` | hash da linha exibida |
| `decisao` | `aprovar` (aprovar e enviar como está), `refazer` (pedir ajuste), `recusar` |
| `origem` | `painel` |

`comentario`: pares `chave=valor` separados por `;` (mesma regra de `docs/contrato-propostas.md`). Aqui só existe `texto`, sempre o último, e pode conter `;` e `=`. Quebras de linha viram espaço.

| Decisão | comentario |
| --- | --- |
| aprovar | vazio |
| refazer | `texto=<o que mudar>`, obrigatório |
| recusar | `texto=<motivo>` opcional |

O servidor recusa (e não grava): chave desligada, item que não existe mais, estado diferente de `aguardando_aprovo`, hash diferente do atual (o agente mudou o rascunho depois que a tela carregou), decisão repetida para a mesma versão e `refazer` sem texto.

## O que o agente faz

| Decisão | No Zendesk | Em Rascunhos-painel.csv |
| --- | --- | --- |
| aprovar | envia o rascunho como resposta pública, sem mudar o texto | `estado=enviado ...` |
| refazer | reescreve o rascunho com o pedido | nova linha com `versao+1` e `estado=aguardando_aprovo` |
| recusar | não envia; registra o motivo na nota interna | `estado=recusado ...` |

Antes de aplicar, o agente recalcula o hash da linha atual. Se for diferente do `snapshot_hash` da decisão, não aplica e grava recibo `rejeitado` com motivo `versão desatualizada`.

## Recibo (recibos/<decision_id>.json)

Mesma pasta e formato dos outros módulos. Escrito só pelo agente, imutável.

```json
{
  "decision_id": "D-20261112-150000-abcdef12",
  "snapshot_hash": "dd235ce26ee191ea3e4bfe51281998d4857e85c240793b97f0f9144e2c2c5a94",
  "resultado": "aplicado",
  "motivo": "resposta enviada no chamado 645",
  "link": "https://exemplo.zendesk.com/agent/tickets/645",
  "processado_em": "2026-11-12T16:00:00-03:00",
  "agente": "Agente de Suporte RN Sports"
}
```

## Outras telas do módulo (só leitura)

- **Rascunhos só no Zendesk:** chamados abertos (`status` começando por `open`, `pending`, `new` ou `hold`) cuja última linha em `Respostas.csv` tem `aprovado` começando por `pendente` e que não estão em `Rascunhos-painel.csv`.
- **Abertos por evento e por tipo**, **parados há mais de 24 h** (maior data entre `criado_em`, `primeira_resposta_em`, `rascunho_em`, `aprovado_em`, `respondido_em`).
- **Alertas Now e Today** de `Alerts.csv` (os 10 mais recentes; `delivery_state=superseded` aparece como substituído).
- **Primeira resposta na semana:** mediana em horas entre `criado_em` e `primeira_resposta_em` (ou `respondido_em`), só quando a data tem hora. Respostas só com data ficam fora da conta e são contadas à parte.
