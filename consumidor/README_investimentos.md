# Consumidor de decisões de Investimentos (Analista de Investimentos)

Script: `consumidor_investimentos.py` (Python 3, só biblioteca padrão, autocontido). Lê as decisões `modulo=investimentos` que o Bruno grava no painel, confere cada uma contra `Aportes.csv` e grava o recibo em `recibos/<decision_id>.json`. Não opera na corretora. Contrato: `docs/contrato-investimentos.md`.

## Configurar (uma vez)

Copie `config.investimentos.example.json` para `config.investimentos.json` e troque `aportes_fileId` pelo id do `Aportes.csv` (está no `painel-fontes.json`, módulo `investimentos`). `decisoes_fileId` e `recibos_folderId` já vêm preenchidos.

## Ciclo do agente

1. Planejar: `python3 consumidor_investimentos.py --plano`
2. Executar cada ação:

   | Ação (decisão do painel) | Campos | O que o agente faz |
   | --- | --- | --- |
   | `confirmar_aporte` (`fiz_aporte` em `aporte:<data>\|<destino>\|<origem>`) | `data` (do comentário ou a da decisão), `valor` (do comentário ou o planejado), `valor_planejado`, `destino`, `ativo`, `categoria_arca`, `origem`, `texto` | confere o aporte e atualiza `Posicoes`/`Reserva`/`Metas_ARCA` como já faz |
   | `marcar_nao_feito` (`nao_fiz`) | os dados do aporte e `texto` (motivo) | nada na corretora |

3. Confirmar: `python3 consumidor_investimentos.py --confirmar <decision_id>` (opcional `--link URL`).
   - `confirmar_aporte`: `estado=confirmado` (só o valor estrito, desde a v3.2.0); `valor_brl` recebe o valor se a decisão trouxe um. Data, valor e texto vão no recibo.
   - `marcar_nao_feito`: `estado=nao_feito`; o motivo vai no recibo.
   - Se o `Aportes.csv` tiver a coluna `obs`, a data e o motivo também vão nela (somados ao que já houver).
   - Colunas extras (ex. `valor`, `moeda`) ficam como estão.

Sem gravar nada: acrescente `--teste`.

## Códigos de saída

- 0: ok. 1: ficou pendência (rode de novo). 3: erro de dado, configuração ou argumento; nada foi gravado.
- 2: erro de autenticação no Drive. Pare tudo e peça para reconectar o Google Drive.

## Segurança

- Só aporte pendente (estado que não começa por `confirmad`, `não fiz`, `nao feito`, `nao_feito`, `cancelad`, `desistiu`; lê o formato estrito e o antigo) aceita decisão, e só com hash igual ao do painel. Senão, recibo `rejeitado`.
- Só a linha do aporte muda; o resto do CSV fica byte a byte. Ledger local antes do recibo; retomada com `--confirmar` de novo; recibo existente não é refeito.
