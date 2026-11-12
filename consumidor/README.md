# Consumidor de decisões de anúncios

Script do Gestor de Tráfego que lê as decisões `modulo=anuncios` gravadas pelo Painel Grupo Smart, aplica em `Propostas.csv` e responde com um recibo em `recibos/<decision_id>.json`. Contrato completo: [docs/contrato-propostas.md](../docs/contrato-propostas.md).

O que ele faz:

- Lê `decisoes.csv` (nunca reescreve) e lista `recibos/` no Drive.
- Processa só decisões `modulo=anuncios` que ainda não têm recibo.
- Para cada uma: confere item, `tipo_item`, hash do snapshot da linha atual, estado, `comentario` e verba. Se tudo bate, atualiza a linha em `Propostas.csv` (as outras linhas ficam byte a byte iguais) e cria o recibo `aplicado`. Senão cria o recibo `rejeitado` com o motivo.
- Grava a lista de ações para o agente em `acoes-anuncios.json` (programar post, criar campanha, pausar na Meta, refazer, registrar recusa).

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
| `propostas_fileId` | id de `Propostas.csv`. Enquanto estiver `PREENCHER`, o script avisa e sai sem fazer nada (código 0) |
| `pasta_trabalho` | pasta local onde o `gws` roda (cwd); downloads e uploads usam caminhos relativos a ela |
| `ledger_path` | ledger de fases (JSON local); guarde entre execuções |
| `acoes_path` | onde gravar as ações para o agente |
| `gws_bin` | executável do gws (padrão `gws`) |

Caminhos relativos na config são resolvidos a partir da pasta do arquivo de config. `config.json`, `trabalho/`, ledger e ações estão no `.gitignore`.

## Como rodar

```bash
python3 consumidor/consumidor_anuncios.py --config consumidor/config.json --dry-run   # só mostra
python3 consumidor/consumidor_anuncios.py --config consumidor/config.json             # aplica
```

Opções: `--dry-run` (não grava nada: nem Drive, nem ledger, nem ações), `--ledger <caminho>`, `--acoes <caminho>`.

Códigos de saída:

| Código | Significado |
| --- | --- |
| 0 | tudo certo (ou nada a fazer) |
| 1 | ficou pendência: recibo não criado, falha ao atualizar `Propostas.csv` ou `Propostas.csv` mudou durante a execução. Rode de novo |
| 2 | erro de autenticação no Drive (401, 403, invalid_grant, unauthenticated). Parou tudo; reconectar o Drive |
| 3 | config ou arquivo fora do contrato (cabeçalho diferente, config sem ids) |

## Segurança e idempotência

- Sem segredos no código nem na config: a autenticação é do `gws`.
- Ledger de fases por decisão, gravado de forma atômica antes de cada passo: `recebida` (já com o `hash_depois` previsto) → `propostas_atualizada` → `recibo_criado`.
- Retomada: se a execução cair depois do upload de `Propostas.csv`, a próxima vê que a linha já tem o `hash_depois` e só cria o recibo, sem reaplicar.
- Antes de cada upload de `Propostas.csv` o script confere o md5 no Drive; se alguém mudou o arquivo no meio, para sem gravar.
- Recibo com criação ambígua (erro ou timeout no create): lista `recibos/` pelo nome `<decision_id>.json`. Se existe, considera feito; se não existe, deixa pendente para a próxima execução (que lista de novo antes de criar). Dois recibos com o mesmo nome: não cria outro e registra aviso.
- Decisão com `id` repetido em `decisoes.csv`: só a primeira vale, as outras são ignoradas com aviso. Mesma versão (item + hash) já aplicada por outra decisão: recibo rejeitado "decisão duplicada".

## Testes

```bash
python3 -m unittest discover consumidor
```

Os testes usam um `gws` simulado (Drive em memória) e o fixture real `test/fixtures/anuncios/Propostas.csv`. O teste de vetores regrava `consumidor/vetores_hash.json`, que o painel em JS confere.
