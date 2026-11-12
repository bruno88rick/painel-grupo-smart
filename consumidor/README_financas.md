# Consumidor de decisões de Finanças (Assistente Financeiro)

Script: `consumidor_financas.py` (Python 3, só biblioteca padrão, autocontido). Lê as decisões `modulo=financas` que o Bruno grava no painel, confere cada uma contra `Contas.csv`, `contas-recebidas.csv` e `Rateios.csv` e grava o recibo em `recibos/<decision_id>.json`. Não paga nada e não mexe em `Lancamentos.csv`. Contrato: `docs/contrato-financas.md`.

Aceita os dois formatos que o painel aceita: o atual (`Contas.csv` com a última coluna sem nome, `Rateios.csv` com 5 colunas) e o novo (`Contas.csv` com aspas, `message_id`, `codigo`, `pdf_fileId`; `Rateios.csv` com `emissor` e `pagaram`/`pagantes`).

## Configurar (uma vez)

Copie `config.financas.example.json` para `config.financas.json` e troque os `PREENCHER` pelos ids do Drive (estão no `painel-fontes.json`, módulo `financas`):

| Chave | O que é |
| --- | --- |
| `decisoes_fileId`, `recibos_folderId` | `decisoes.csv` e a pasta `recibos/` (já preenchidos) |
| `contas_fileId` | `Contas.csv` (obrigatório) |
| `recebidas_fileId` | `contas-recebidas.csv` (subpasta). Opcional, mas sem ele o hash das contas com código Pix/barras ou PDF da recebida não bate com o do painel e a decisão é rejeitada |
| `rateios_fileId` | `Rateios.csv` (opcional; sem ele, decisões de rateio são rejeitadas) |
| `pasta_trabalho`, `ledger_path` | pasta local do `gws` e o ledger local |

## Ciclo do agente

1. Planejar: `python3 consumidor_financas.py --plano`
2. Executar cada ação:

   | Ação (decisão do painel) | Campos | O que o agente faz |
   | --- | --- | --- |
   | `registrar_pagamento` (`paguei` em `conta:<emissor>\|<mes_ref>`) | `emissor`, `mes_ref`, `data` (do comentário ou a da decisão), `valor` (pago, se veio), `valor_conta`, `vencimento`, `texto` | lança o pagamento em `Lancamentos.csv` se ainda não houver |
   | `registrar_rateio_recebido` (`recebi_mais_um` em `rateio:<mes_ref>`) | `mes_ref`, `emissor`, `nome` (o texto do Bruno), `recebidos`, `de` | confere o recebimento |

3. Confirmar: `python3 consumidor_financas.py --confirmar <decision_id>` (opcional `--link URL`).
   - Conta: `estado=pago <data>` (com `(valor pago R$ x,xx; <texto>)` quando vierem) e `pago_em=<data>`. A coluna `valor` (valor da conta) não muda. Linha do formato atual quebrada pela vírgula do valor é regravada consertada, com aspas.
   - Rateio: `recebidos` `x/y` vira `x+1/y` (o resto do texto fica). No formato novo, com `nome`, o nome entra em `pagaram` (ou `pagantes`) separado por `; `. No formato atual o nome fica só no recibo.

Sem gravar nada: acrescente `--teste`.

## Hash

Igual ao que o painel publicado grava hoje. Observação: o servidor (`Code.gs`, `lerCsv_`) passa para a Lib só as linhas, sem o cabeçalho; por isso o conserto de linha do formato atual não roda no servidor e o rateio no formato novo usa só os 5 campos do formato atual. O consumidor usa esse hash e também aceita o hash "da Lib com cabeçalho" (linha consertada; rateio com `emissor` e `pagaram`), para não quebrar se o painel passar a mandar o cabeçalho.

## Códigos de saída

- 0: ok. 1: ficou pendência (rode de novo). 3: erro de dado, configuração ou argumento; nada foi gravado.
- 2: erro de autenticação no Drive. Pare tudo e peça para reconectar o Google Drive.

## Segurança

- Só aplica com hash igual e estado que aceita a decisão (`paguei`: `a pagar`, em atraso, sem confirmação ou outro; `recebi_mais_um`: rateio enviado e faltando). Senão, recibo `rejeitado`.
- Só a linha da decisão muda; o resto do CSV fica byte a byte. Ledger local antes do recibo; retomada com `--confirmar` de novo; recibo existente não é refeito.
