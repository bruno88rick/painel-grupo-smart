# Contrato do módulo Investimentos: leitura, decisões e recibos

Fonte da verdade para o painel e para o Analista de Investimentos. O painel só lê os arquivos que o agente já mantém no ledger (`Posicoes`, `Precos`, `Metas_ARCA`, `Recomendacoes`, `Aportes`, `Previdencia`, `Reserva` e `Alerts`). Nenhum arquivo novo é pedido ao agente. O painel não acessa corretora, banco nem cotação na internet: preço é o que está no `Precos.csv`.

Enquanto `INVESTIMENTOS_INTEGRADO` estiver `false` em `src/Lib.gs` (`CHAVES`), os botões ficam desligados com o aviso "o agente ainda não lê estas decisões" e o servidor recusa gravar. A chave só vira `true` quando o agente ler as decisões.

## Como o painel lê os arquivos atuais

| Arquivo | Uso |
| --- | --- |
| `Precos.csv` | `data,ativo,fechamento,moeda,fonte`. Séries por `ativo` (`BTCBRL`, `BTCUSD`, `AAPL`, `USDBRL`). `data` vem em três formatos: `2026-11-06 16:17 BRT` (hora de Brasília), `2026-11-06 16:00 NY` (somamos 2 h para Brasília) e só a data (ação em USD vale como fechamento às 18:00 de Brasília; o resto às 00:00). Linha cuja `fonte` diz `intradiário` ou `não é fechamento` fica fora da série e do gráfico (a tela conta quantas). Mesma hora repetida: vale a última linha. Decimais com ponto, de qualquer tamanho (`5.5077`, `0.00002867`) |
| `Posicoes.csv` | `ativo,plataforma,categoria_arca,quantidade,preco_medio,moeda,custo_total,data,notas,estado`. Linhas com `quantidade` viram posições: valor em reais ao último preço (BTC em USD usa `BTCUSD` e o dólar do `USDBRL`; AAPL usa o dólar) e ganho % contra o `preco_medio` na moeda da própria posição. Linhas sem quantidade (previdência, reserva) dão a nota do cartão da reserva |
| `Metas_ARCA.csv` | `data,categoria,valor_brl,peso_pct,meta_pct`. Vale a `data` mais recente. Meta numérica = categoria da ARCA (barra de peso com traço da meta, diferença em pontos e quanto falta em reais para a meta). Meta em texto (ex. `provisório 01/11`) = "Fora da ARCA", mostrada como texto. A tela também mostra o valor de cada categoria ao último preço das posições |
| `Recomendacoes.csv` | `data,ativo,preco,sinal,score,motivo,resultado_30d`. A última por ativo em cartão; histórico recolhido (12 mais recentes). `resultado_30d` vazio mostra "em aberto até `data + 30 dias`". "desde então" = último preço contra o `preco` da recomendação (BTC em USD) |
| `Aportes.csv` | `data,destino,categoria_arca,ativo,valor_brl,origem,estado`. `estado` é texto livre, classificado pelo começo: `confirmad...` = confirmado; `nao fiz`/`não fiz`/`nao feito`/`cancelad...`/`desistiu` = não feito; o resto (ex. `planejado`, vazio) = pendente, que pede decisão. Lista do mês corrente e soma dos confirmados em reais. Aporte sem `valor_brl` (ex. `pessoal (US$ 19,69)`) mostra a origem |
| `Previdencia.csv` | `data_ref,saldo_oficial,aporte_pessoal,aporte_empresa,rendimento,rentabilidade_pct`. Última linha e a anterior (diferença). `data_ref` como `2026-11-01 (provisório; ...)` vira referência `2026-11-01` + observação e selo **Provisório** |
| `Reserva.csv` | `data,saldo,aporte,produto`. Última linha pela maior `data` (empate: a de baixo) |
| `Alerts.csv` | os 10 mais recentes, todos os tiers. Vazio: "Nenhum alerta." |

Contagem do Início ("precisa de você"): aportes pendentes + alertas `Now` sem `outcome` (ou `pending`).

## Itens e hash

Texto canônico igual ao dos outros módulos: cada campo (vazio se ausente) com `\r\n` e `\r` trocados por `\n` e espaços das pontas tirados; campos unidos com U+001F (␟); SHA-256 do UTF-8, hex minúsculo. Os campos entram como texto do arquivo, não como número.

### Aporte (`tipo_item=aporte`)

`item_id` = `aporte:<data>|<destino>|<origem>`, ex. `aporte:2026-11-15|Reserva de emergência|pessoal`. `versao` vazia. Só aportes pendentes aceitam decisão.

```
aporte␟data␟destino␟categoria_arca␟ativo␟valor_brl␟origem␟estado
```

Vetor: `2026-11-15`, `Reserva de emergência`, `Fora da ARCA`, `Tesouro Selic`, `250.00`, `pessoal`, `planejado` → `dc6bd7b8d5bca74ff2bb9c7f1da68b5e659c3499587375112b0fa3160784f7cb`.

## Decisão (linha em decisoes.csv)

Mesmo arquivo e cabeçalho; o agente filtra por `modulo=investimentos`. `arte_fileId` vazio, `origem=painel`.

| tipo_item | decisao | Estados aceitos | comentario |
| --- | --- | --- | --- |
| aporte | `fiz_aporte` | `pendente` | `data=aaaa-mm-dd;valor=123.45;texto=...`, todos opcionais (valor em reais com ponto decimal, maior que zero) |
| aporte | `nao_fiz` | `pendente` | `texto=<motivo>` opcional |

O servidor recusa (e não grava): chave desligada, item que não existe mais, estado que não aceita a decisão, campo inválido, hash diferente do atual e decisão repetida para o mesmo hash.

## O que o agente faz

| Decisão | No ledger |
| --- | --- |
| fiz_aporte | `estado=confirmado <data>` no aporte (data da decisão se não vier), `valor_brl` com o valor se vier; atualiza `Posicoes`/`Reserva`/`Metas_ARCA` como já faz |
| nao_fiz | `estado=não fiz` (com o motivo, se vier) |

Antes de aplicar, o agente recalcula o hash do aporte. Se for diferente do `snapshot_hash`, não aplica e grava recibo `rejeitado` com motivo `versão desatualizada`. Recibo em `recibos/<decision_id>.json`, mesmo formato dos outros módulos, com `agente: "Analista de Investimentos"`.

## Colunas sugeridas ao agente

Nada disso é exigido pelo painel (ele já contorna o formato atual):

- `Precos.csv`: `data` sempre em ISO com fuso (ex. `2026-11-06T16:00:00-03:00`) e uma coluna `tipo` (`fechamento`/`intradiario`), em vez de deduzir pelo texto da `fonte`; um só fim de linha (hoje CRLF e LF misturados).
- `Aportes.csv`: colunas `valor` e `moeda` (o aporte de AAPL em dólar fica com `valor_brl` vazio e o valor dentro de `origem`); `estado` com valores fixos (`planejado`, `confirmado`, `nao_feito`).
- `Previdencia.csv`: `data_ref` só com a data e a observação numa coluna `obs`.
- `Metas_ARCA.csv`: `meta_pct` só com número (vazio para fora da ARCA) e a observação numa coluna `obs`.
- `Reserva.csv`: uma linha por data (hoje há duas em 07/11) e `produto` sem observação entre parênteses (coluna `obs`).
- `Posicoes.csv`: `custo_total` da posição do App Cripto Beta (vazio hoje).
- `Recomendacoes.csv`: preencher `resultado_30d` quando a recomendação faz 30 dias.
