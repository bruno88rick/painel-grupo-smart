# Contrato do módulo Finanças: leitura, decisões e recibos

Fonte da verdade para o painel e para o Assistente Financeiro. O painel só lê os arquivos que o agente já mantém no ledger (`Contas`, `contas-recebidas`, `Lancamentos`, `Recorrentes`, `Rateios`, `Fechamentos`, `Orcamento` e `Alerts`). Nenhum arquivo novo é pedido ao agente. O painel não acessa banco nem cartão.

Privacidade: códigos Pix e linhas digitáveis vêm escondidos na tela (botões **Copiar** e **Mostrar**). PDFs abrem pelo link do Drive, sem cópia no painel.

Enquanto `FINANCAS_INTEGRADO` estiver `false` em `src/Lib.gs` (`CHAVES`), os botões ficam desligados com o aviso "o agente ainda não lê estas decisões" e o servidor recusa gravar. A chave só vira `true` quando o agente ler as decisões.

## Como o painel lê os arquivos atuais

| Arquivo | Uso |
| --- | --- |
| `Contas.csv` | `emissor,mes_ref,valor,vencimento,forma,estado,link,pago_em,` (a última coluna não tem nome). Última linha por `emissor` + `mes_ref`. `estado` é texto livre, classificado pelo começo: `a pagar`, `pago`/`paga`, `em atraso`/`atrasad`/`vencid`, `sem confirmação`; o resto é `outro`. Conta `a pagar` com vencimento já passado aparece como **Em atraso**, com a observação "No arquivo ainda está 'a pagar'". O texto inteiro do estado aparece na tela |
| `Contas.csv` (linha quebrada) | quando um valor `R$ 321,45` foi escrito sem aspas no `estado`, a vírgula parte o campo e empurra as colunas seguintes. O painel junta `...R$ 321` com `66...` e puxa os campos de volta (`consertarLinha`) |
| `contas-recebidas/contas-recebidas.csv` | `recebido_em,caixa,emissor,tipo,valor,vencimento,codigo_ou_pix,pdf_fileId,message_id,anotado_em`. Opcional. Liga-se à conta quando o `message_id` aparece no texto de `link` ou `estado` da conta; daí vêm o código (Pix se começa com `000201`, barras se tiver 44 dígitos ou mais) e o PDF. Recebidas com código, sem conta ligada e dos últimos 30 dias aparecem em "Recebidas no e-mail, ainda fora da lista de contas" |
| `Lancamentos.csv` | `data,descricao,categoria,essencial,tipo,valor,conta,parcela,origem,estado,dono`. Agrupado por mês de `data`; entradas e saídas por `tipo`; essencial `s`; `dono` `pessoal`/`empresa` (vazio conta como "sem dono"). Valores aceitos: `2.468,10`, `1469,05`, `-48,32`, `R$ 10`. Negativos (créditos e estornos) descontam |
| `Recorrentes.csv` | lista recolhida "Recorrentes conhecidas" |
| `Rateios.csv` | `mes_ref,total,por_pessoa,enviado,recebidos`. Vale a linha de `mes_ref` mais recente. `enviado` começando com `s` = enviado; `recebidos` no formato `1/3`. Estado: `nao_enviado`, `aberto` (enviado e faltando) ou `completo` |
| `Fechamentos.csv`, `Orcamento.csv` | tabelas quando houver linhas; senão "Ainda sem fechamento." / "Ainda sem orçamento." |
| `Alerts.csv` | os 10 mais recentes por `created_at`, todos os tiers |

Contagem do Início ("precisa de você"): contas atrasadas ou sem confirmação + contas que vencem em 7 dias + 1 se o rateio estiver `aberto`.

O `pdf <fileId>` citado no `link` da conta tem preferência sobre o `pdf_fileId` da recebida.

## Formato novo (aceito junto com o atual)

O Assistente Financeiro vai passar a gravar um formato mais limpo. O painel lê os dois, pelo nome das colunas (a ordem não importa), e escolhe sozinho:

| Arquivo | Formato novo | O que muda no painel |
| --- | --- | --- |
| `Contas.csv` | CSV com aspas; última coluna com nome (ex. `obs`); colunas `message_id`, `codigo` e `pdf_fileId`; `pago_em` só com a data; `estado` `em atraso` quando vence | o conserto de linha só roda quando a última coluna não tem nome (formato atual); `message_id` da coluna liga a recebida por igualdade; `codigo` (Pix ou barras) e `pdf_fileId` da própria conta têm preferência sobre os da recebida |
| `Lancamentos.csv` | entradas com `tipo=entrada` e `dono` sempre preenchido | nada novo: entradas, saldo e pessoal/empresa já saem das colunas |
| `Rateios.csv` | `mes_ref,total,por_pessoa,enviado,recebidos,emissor,pagaram` (cabeçalho real; `pagaram` = nomes separados por `;`; o nome antigo `pagantes` também vale) | título e contagem do Início com o `emissor`; "Já pagaram: ..." no cartão; recebidos = o maior entre `x` de `x/y` e o número de nomes |

Fixture de exemplo: `test/fixtures/financas-novo/`.

Na tela, o estado e a origem da conta aparecem sem os tokens que o painel já extraiu (`gmail:`/`outlook:`/`icloud:` e `pdf <fileId>`). O hash usa o texto cru do arquivo.

## Itens e hash

Texto canônico igual ao dos outros módulos: cada campo (vazio se ausente) com `\r\n` e `\r` trocados por `\n` e espaços das pontas tirados (trim do JS); campos unidos com U+001F (␟); SHA-256 do UTF-8, hex minúsculo. Os campos entram como texto do arquivo (depois do conserto da linha quebrada), não como número.

### Conta (`tipo_item=conta`)

`item_id` = `conta:<emissor>|<mes_ref>`, ex. `conta:Energia Exemplo|2026-11`. `versao` vazia. Pagas não aceitam decisão.

```
conta␟emissor␟mes_ref␟valor␟vencimento␟forma␟estado␟link␟pago_em␟codigo␟pdf_fileId
```

`codigo` e `pdf_fileId` são os que o painel ligou à conta (vazios se não houver). Vetor (conferido em `test/v3-financas.test.js`):

```
conta␟Energia Exemplo␟2026-11␟1.234,56␟2026-11-18␟boleto␟a pagar; débito em 18/11␟chat 10/11␟␟00020126580014br.gov.bcb.pix0136exemplo␟1ExemploExemploExemploExemplo12345
hash 5993849ab14caa61253ffabd1fd0c1e78e6f339f43df240790acadb35fd48a7f
```

### Rateio (`tipo_item=rateio`)

`item_id` = `rateio:<mes_ref>`. `versao` vazia. Só o rateio `aberto` aceita decisão.

```
rateio␟mes_ref␟total␟por_pessoa␟enviado␟recebidos
```

Vetor: `2026-10`, `600,00`, `150,00`, `s (09/11 WhatsApp)`, `1/3` → `c982befc6ef4cfcfda0f839df7beda3bf14247c3e82ab201c0f7b64f57976f65`.

Formato novo (o `Rateios.csv` tem `emissor`, `pagaram` ou `pagantes` no cabeçalho): `emissor` e `pagaram` (ou `pagantes`, se for essa a coluna) entram no fim.

```
rateio␟mes_ref␟total␟por_pessoa␟enviado␟recebidos␟emissor␟pagaram
```

Vetor: `2026-10`, `861,53`, `136,34`, `s (09/11 09:17 WhatsApp Grupo TV)`, `2/3`, `TV Estrela`, `Ana; Rita` → `6ff1894773e2ff47970e3fa90cc8dea57b65809d44d12dca10f2b91143c7673f`.

## Decisão (linha em decisoes.csv)

Mesmo arquivo e cabeçalho; o agente filtra por `modulo=financas`. `arte_fileId` vazio, `origem=painel`.

| tipo_item | decisao | Estados aceitos | comentario |
| --- | --- | --- | --- |
| conta | `paguei` | `a_pagar`, `atraso`, `sem_confirmacao`, `outro` | `data=aaaa-mm-dd;valor=123.45;texto=...`, todos opcionais (valor com ponto decimal, maior que zero) |
| rateio | `recebi_mais_um` | `aberto` | `texto=<de quem>` opcional |

O servidor recusa (e não grava): chave desligada, item que não existe mais, estado que não aceita a decisão, campo inválido, hash diferente do atual e decisão repetida para o mesmo hash.

## O que o agente faz

| Decisão | No ledger |
| --- | --- |
| paguei | `estado=pago` na conta e `pago_em` com a data (ou a da decisão); valor pago e texto vão no recibo; lançamento em `Lancamentos.csv` se ainda não houver |
| recebi_mais_um | soma 1 em `recebidos` do rateio (ex. `1/3` → `2/3`); com `texto`, anota de quem |

Desde a v3.2.0 o leitor (`consumidor/consumidor_financas.py`) grava na coluna `estado` só `pago`; a data vai na coluna `pago_em`, como o Assistente Financeiro já faz, e o valor pago e o texto, só no recibo. O painel lê os dois formatos: o antigo (`pago 2026-11-12 (valor pago R$ 10,00; <texto>)`) e o estrito (`pago`), porque classifica pelo começo do texto.

Antes de aplicar, o agente recalcula o hash da conta ou do rateio. Se for diferente do `snapshot_hash`, não aplica e grava recibo `rejeitado` com motivo `versão desatualizada`. Recibo em `recibos/<decision_id>.json`, mesmo formato dos outros módulos, com `agente: "Assistente Financeiro"`.

## Colunas sugeridas ao agente

Nada disso é exigido pelo painel (ele já contorna o formato atual); é o que o formato novo acima traz:

- Escrever o CSV com aspas (o `R$ 321,45` sem aspas quebra a linha) e dar nome à última coluna de `Contas.csv`.
- Em `Contas.csv`: colunas `message_id`, `codigo` e `pdf_fileId` (hoje o painel procura o `message_id` dentro de `link`/`estado` e o `pdf <id>` no `link`).
- `pago_em` sem lixo como `['']`; um só fim de linha (hoje CRLF e LF misturados).
- `estado` passar de `a pagar` para `em atraso` quando o vencimento passa.
- `Lancamentos.csv` com as entradas do mês (hoje só há saídas, o saldo fica só negativo) e `dono` sempre preenchido.
- `Rateios.csv` com `emissor` (o painel assume SKY) e os nomes de quem já pagou.
