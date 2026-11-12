# Consumidor de decisões de anúncios

Script do Gestor de Tráfego que lê as decisões `modulo=anuncios` gravadas pelo Painel Grupo Smart, entrega ao agente a lista do que fazer na Meta e, só depois que o agente confirma, atualiza `Propostas.csv` e grava o recibo em `recibos/<decision_id>.json`. Mesmo desenho dos consumidores de Suporte, E-mails, Finanças e Investimentos. Contrato completo: [docs/contrato-propostas.md](../docs/contrato-propostas.md).

Duas fases:

1. `--plano`: lê `decisoes.csv` (nunca reescreve), lista `recibos/`, baixa `Propostas.csv` e confere cada decisão sem recibo (item, `tipo_item`, hash do snapshot da linha atual, estado, `comentario` e verba). Imprime em JSON as ações para o agente. Não grava recibo de ação nem mexe em `Propostas.csv`. Decisão com versão velha ou inválida recebe na hora o recibo `rejeitado` com o motivo (não há nada para o agente executar).
2. `--confirmar <decision_id> [--link URL]`: depois que o agente executou a ação na Meta. Confere a decisão de novo contra a linha atual, grava o ledger, atualiza só aquela linha em `Propostas.csv` (as outras ficam byte a byte iguais) e cria o recibo `aplicado` (com o link, se veio).

Ações do `--plano`:

| Decisão | Ação | Mudança em `Propostas.csv` no `--confirmar` |
| --- | --- | --- |
| post aprovar | `programar_post` (contas, horário, mídias na ordem, legenda escolhida, hashtags) | `estado=aprovado`, `legenda_escolhida`; horário novo sobe `versao` |
| post refazer | `refazer_post` | `estado=ajuste` |
| post recusar | `registrar_recusa_post` | `estado=recusado` |
| campanha aprovar | `criar_campanha` (verba, período, público, plano) | `estado=aprovado`; verba menor sobe `versao` |
| campanha refazer | `refazer_campanha` | `estado=ajuste` |
| campanha recusar | `registrar_recusa_campanha` | `estado=encerrado` |
| campanha pausar | `pausar_campanha_meta` | `estado=pausado` |

Cada ação traz `decision_id`, `item_id`, `decisao`, `snapshot_hash`, `motivo` (o texto que irá no recibo) e, quando o plano roda de novo antes da confirmação, `ja_planejada: true`.

O que ele nunca faz: publicar, chamar a API da Meta, aumentar verba, reescrever `decisoes.csv`, apagar arquivos.

## Requisitos

- Python 3.8+ (só biblioteca padrão).
- CLI `gws` autenticado no Google Drive do Bruno.

## Configuração

```bash
cp consumidor/config.example.json consumidor/config.json
```

| Chave | O que é |
| --- | --- |
| `decisoes_fileId` | id de `decisoes.csv` no Drive |
| `recibos_folderId` | id da pasta `recibos/` |
| `propostas_fileId` | id de `Propostas.csv`. Enquanto estiver `PREENCHER`, o `--plano` avisa e sai sem fazer nada (código 0); o `--confirmar` sai com 3 |
| `pasta_trabalho` | pasta local onde o `gws` roda (cwd); downloads e uploads usam caminhos relativos a ela |
| `ledger_path` | ledger de fases (JSON local, padrão `ledger-anuncios.json`); guarde entre execuções |
| `gws_bin` | executável do gws (padrão `gws`) |

Caminhos relativos na config são resolvidos a partir da pasta do arquivo de config. `config.json`, `trabalho/`, o ledger e `acoes-anuncios.json` estão em `consumidor/.gitignore`. A chave antiga `acoes_path` é ignorada.

## Como rodar

```bash
python3 consumidor/consumidor_anuncios.py --plano                                  # JSON com as ações
python3 consumidor/consumidor_anuncios.py --confirmar <decision_id> [--link URL]   # depois de agir na Meta
python3 consumidor/consumidor_anuncios.py --teste                                  # plano sem gravar nada
python3 consumidor/consumidor_anuncios.py --confirmar <decision_id> --teste        # mostra o que mudaria
```

Opções: `--config <caminho>` (padrão `consumidor/config.json`), `--teste` (só leitura: não grava Drive, ledger nem recibo; sozinho equivale a `--plano --teste`), `--ledger <caminho>`. Sem `--plano` nem `--confirmar`, roda o `--plano`. `--dry-run` continua aceito como apelido de `--teste` e avisa no stderr que está obsoleto.

Códigos de saída (iguais aos dos outros consumidores):

| Código | Significado |
| --- | --- |
| 0 | tudo certo (ou nada a fazer; ou o recibo já existia no `--confirmar`) |
| 1 | ficou pendência: recibo não criado, falha ao atualizar `Propostas.csv`, `Propostas.csv` mudou durante a execução ou confirmação incompleta. Rode de novo |
| 2 | erro de autenticação no Drive (401, 403, invalid_grant, unauthenticated ou exit 2 do gws). Parou tudo; reconectar o Drive |
| 3 | config, argumento ou arquivo fora do contrato (cabeçalho diferente, config sem ids, decisão inexistente, versão desatualizada no `--confirmar`, decisão rejeitada no plano, `--acoes`) |

## Migração do fluxo antigo

Até esta versão o script rodava sem flags (ou com `--dry-run`), aplicava a decisão em `Propostas.csv`, gravava o recibo e só então entregava as ações em `acoes-anuncios.json` (`--acoes`). Ou seja, o recibo dizia "aplicado" antes de o agente agir na Meta. Agora:

| Antes | Agora |
| --- | --- |
| `consumidor_anuncios.py` (aplica tudo e grava recibo) | `--plano` (só lista) e, para cada ação feita na Meta, `--confirmar <decision_id>` |
| `--dry-run` | `--teste` (`--dry-run` ainda funciona, com aviso) |
| `--acoes <arquivo>` / `acoes_path` / `acoes-anuncios.json` | removido: as ações saem no JSON do `--plano` (stdout). Para guardar em arquivo: `--plano > acoes-anuncios.json`. Passar `--acoes` sai com 3 e uma mensagem |

O ledger continua no mesmo arquivo. Entradas antigas são lidas assim: fase `recebida` rejeitada vira recibo rejeitado no próximo `--plano`; fase `recebida` ou `propostas_atualizada` com `Propostas.csv` já atualizado ganha o recibo no próximo `--plano`, que devolve as ações antigas com `legado: true` para o agente executar (sem `--confirmar`, porque o recibo já existe); `recebida` sem o upload feito é descartada e a decisão é avaliada do zero.

## Segurança e idempotência

- Sem segredos no código nem na config: a autenticação é do `gws`.
- Ledger de fases por decisão, gravado de forma atômica antes de cada passo: `planejada` (no plano) → `confirmando` (já com o `hash_depois` previsto, antes do upload) → `propostas_atualizada` → `recibo_criado`. Rejeitadas: `rejeitada` → `recibo_criado`.
- Idempotência: `--confirmar` de uma decisão que já tem recibo responde `ja_existia` e não grava nada. O `--plano` não lista decisões com recibo.
- Retomada: se a execução cair depois do upload de `Propostas.csv`, o próximo `--confirmar` vê que a linha já tem o `hash_depois` e só cria o recibo, sem reaplicar. Se caiu antes do upload, refaz a confirmação do zero. Enquanto isso o `--plano` mostra a decisão em `pendentes`.
- Antes de cada upload de `Propostas.csv` o script confere o md5 no Drive; se alguém mudou o arquivo no meio, para sem gravar (código 1).
- Se a proposta mudou entre o plano e a confirmação (hash diferente), o `--confirmar` não grava nada e sai com 3; se o agente já agiu na Meta, corrija `Propostas.csv` à mão.
- Recibo com criação ambígua (erro ou timeout no create): lista `recibos/` pelo nome `<decision_id>.json`. Se existe, considera feito; se não existe, fica pendente (rode `--confirmar` de novo, que lista antes de criar). Dois recibos com o mesmo nome: não cria outro e registra aviso.
- Decisão com `id` repetido em `decisoes.csv`: só a primeira vale, as outras saem em `ignoradas`. Mesma versão (item + hash) já planejada ou aplicada por outra decisão: recibo rejeitado "decisão duplicada". Uma decisão rejeitada não bloqueia outra sobre a mesma versão.

## Testes

```bash
python3 -m unittest discover -s consumidor
```

`test_consumidor_anuncios.py` usa um `gws` simulado (Drive em memória que confere caminhos relativos ao cwd) e o fixture `test/fixtures/anuncios/Propostas.csv`. Cobre plano, confirmar, `--teste` sem escrita, o apelido `--dry-run`, idempotência, retomada após queda, versão velha, ledger antigo, auth (2) e contrato (3). O teste de vetores regrava `consumidor/vetores_hash.json`, que o painel em JS confere.

## Suporte

`consumidor_suporte.py` faz o mesmo para as decisões `modulo=suporte` (Agente de Suporte RN Sports), contra `Rascunhos-painel.csv`. Contrato: [docs/contrato-suporte.md](../docs/contrato-suporte.md). Guia curto do agente: [README_suporte.md](README_suporte.md).

```bash
cp consumidor/config.suporte.example.json consumidor/config.suporte.json
python3 consumidor/consumidor_suporte.py --plano                          # JSON com as ações
python3 consumidor/consumidor_suporte.py --confirmar <decision_id> <link>  # depois de agir no Zendesk
python3 consumidor/consumidor_suporte.py --teste                          # plano sem gravar nada
```

- `--plano` devolve `enviar_resposta` (com o texto exato do rascunho), `refazer` e `recusar`, e grava recibo `rejeitado` para versão desatualizada, estado diferente de `aguardando_aprovo` ou comentário inválido.
- `--confirmar` atualiza o estado da linha (`enviado ...`, `ajuste ...` ou `recusado ...`; com `--novo-texto` no refazer acrescenta a versão seguinte) e grava o recibo `aplicado` com o link.
- Não chama o Zendesk. Mesmo padrão do consumidor de anúncios: gws com cwd e caminhos relativos, ledger de fases antes do recibo, recibo duplicado e create ambíguo tratados, código 2 em erro de autenticação.
- Testes: `python3 -m unittest discover consumidor` (o hash usa o vetor do contrato e os 7 hashes do fixture calculados com `canonicoResposta` de `src/Lib.gs`).
