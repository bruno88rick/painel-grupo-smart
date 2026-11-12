# Consumidor de decisões de E-mails (Gestor de E-mails)

Script: `consumidor_emails.py` (Python 3, só biblioteca padrão, autocontido). Lê as decisões `modulo=emails` que o Bruno grava no painel, confere cada uma contra `Movimentos.csv` e `Pendencias.csv` e grava o recibo em `recibos/<decision_id>.json`. Não lê, não move e não responde e-mails: quem faz isso é o agente. Contrato: `docs/contrato-emails.md`.

## Configurar (uma vez)

Copie `config.emails.example.json` para `config.emails.json` na mesma pasta do script e troque os `PREENCHER` pelos ids do Drive (estão no `painel-fontes.json` do painel, módulo `emails`):

| Chave | O que é |
| --- | --- |
| `decisoes_fileId`, `recibos_folderId` | `decisoes.csv` e a pasta `recibos/` (já preenchidos) |
| `movimentos_fileId` | `Movimentos.csv` do ledger do Gestor de E-mails |
| `pendencias_fileId` | `Pendencias.csv` |
| `pasta_trabalho`, `ledger_path` | pasta local do `gws` e o ledger local (relativos à config) |

O `gws` precisa estar autenticado no Drive do Bruno.

## Ciclo do agente

1. Planejar: `python3 consumidor_emails.py --plano`
   Imprime JSON com `acoes`. Decisões com versão velha, estado errado ou comentário inválido já recebem recibo `rejeitado` (aparecem em `rejeitadas`).
2. Executar cada ação:

   | Ação (decisão do painel) | Campos | O que o agente faz |
   | --- | --- | --- |
   | `mover_grupo` (`aprovar` em `grupo:<conta>\|<pasta>`) | `conta`, `pasta`, `message_ids`, `linhas` (cada uma com `lote` e `emails`), `emails` (total), `motivo` (comentário do Bruno), `lotes_antigos` | move para `pasta` os e-mails de cada `message_id`; linha de lote (`icloud:lote-...`) = os e-mails daquele lote no Mac |
   | `recusar_grupo` (`recusar`) | os mesmos, mais `texto` | não move nada |
   | `marcar_resolvida` (`resolvida` em `pendencia:<message_id>`) | `message_id`, `conta`, `texto` | nada no e-mail |
   | `pedir_rascunho` (`pedir_rascunho`) | `message_id`, `conta`, `texto` (o pedido) | prepara o rascunho no Mac e anota em `Rascunhos.csv`, como já faz |

3. Confirmar cada ação feita: `python3 consumidor_emails.py --confirmar <decision_id>` (opcional `--link URL`, vai no recibo).
   - Desde a v3.2.0 a coluna `estado` recebe só o valor estrito; a data e o texto vão no recibo (`motivo`).
   - `mover_grupo`: cada linha do grupo vira `movido`. Lotes mais antigos do mesmo destino (fora do hash, ver abaixo) viram `substituído` (o recibo cita a decisão).
   - `recusar_grupo`: cada linha vira `recusado`.
   - `marcar_resolvida`: `estado=fechada` e `fechado_em=<data>`.
   - `pedir_rascunho`: `rascunho=sim <data>`; a pendência continua `aberta`. `Rascunhos.csv` não é tocado pelo script.

Sem gravar nada: acrescente `--teste` (sozinho, `--teste` faz o plano).

## O que vale para o hash

Igual ao painel (`src/Lib.gs`): o grupo junta as linhas `proposto`/`aguardando novo sim` (última por `message_id`) de cada `conta`+`pasta`; se houver mais de um lote do mesmo destino, só o de `proposto_em` mais recente entra no hash e na ação. Pendência: a última linha do `message_id`, todas as colunas do contrato.

## Códigos de saída

- 0: ok. 1: ficou pendência (rode o mesmo comando de novo). 3: erro de dado, configuração ou argumento; leia a mensagem, nada foi gravado.
- 2: erro de autenticação no Drive. Pare tudo e peça para reconectar o Google Drive; não tente de novo antes.

## Segurança

- Só aplica se o hash atual for igual ao `snapshot_hash` da decisão e o estado aceitar a decisão. Senão o recibo é `rejeitado` (`versão desatualizada` ou o motivo). Se o agente rodar `--confirmar` numa decisão que ficou velha, sai com 3 e não grava nada.
- Nunca reescreve `decisoes.csv`. No CSV só mudam as linhas da decisão; o resto fica byte a byte.
- Ledger local (`ledger-emails.json`) grava cada fase antes do recibo: `planejada` → `confirmando` → `arquivo_atualizado` → `recibo_criado`. Se cair no meio, rodar `--confirmar` de novo só completa o que falta. Antes de subir, confere se o arquivo mudou no Drive durante a execução.
- Recibo que já existe não é refeito.
