# Contrato: módulo Estudos (v3.0.0-estudos)

Agente: **Assistente de Estudos**. O painel só lê. Não há botão, chave em `CHAVES` nem decisão em `decisoes.csv`: `registrarModuloV3('estudos', {decisoes: null, ...})`, e `salvarDecisao` com `modulo: 'estudos'` é recusado com "o módulo Estudos é só leitura".

## Onde o painel lê

`painel-fontes.json`, módulo `estudos`:

- `fontes.ledger.folderId`: pasta do ledger do Assistente de Estudos no Drive.
- `fontes.materiais.folderId`: pasta de materiais (onde ficam os resumos `.md`). Opcional; sem ela, o painel mostra a situação do resumo, mas sem o link "Abrir resumo".
- `fontes.arquivos.<chave>.fileId`: opcional; sem fileId, o arquivo é procurado pelo nome na pasta do ledger, com o cache da v2.0.1 (`textoDoArquivo_`, `acharNaPasta_`).

| Chave | Arquivo | Obrigatório |
|---|---|---|
| `cursos` | `Cursos.csv` | sim |
| `entregas` | `Entregas.csv` | sim |
| `modulos` | `Modulos.csv` | sim |
| `provas` | `Provas.csv` | não (hoje só tem o cabeçalho) |
| `pedidos` | `Pedidos.csv` | não |

## Colunas usadas

- `Cursos.csv`: `curso, pasta, calendario, situacao`. Da `pasta` (caminho do Mac) o painel mostra só o último nome; o caminho `/Users/...` nunca sai do servidor.
- `Entregas.csv`: `curso, titulo, data, fonte, evento_id, plano_em, rascunho_em, arquivos`.
- `Provas.csv`: `curso, titulo, data, fonte, evento_id, modulos, simulado_em, simulado_arquivo`.
- `Modulos.csv`: `curso, fase, modulo, arquivo, tipo, chegou_em, resumo_em, resumo_arquivo`.
- `Pedidos.csv`: `data, pedido, tipo, estado, entregue_em`.

O texto é normalizado para NFC (o Mac grava acentos decompostos). Linhas com CRLF e campos com vírgula entre aspas são aceitos.

## Regras

- **Data** (`data` de entregas e provas): `AAAA-MM-DD HH:MM` vale no fuso do projeto (America/Sao_Paulo); só `AAAA-MM-DD` vale até 23:59 do dia; qualquer outro texto ("a confirmar") vira "a confirmar" e entra no fim da lista de próximas.
- **Contagem regressiva:** "hoje às HH:MM", "amanhã às HH:MM", "em N dias"; depois do prazo, "passou há N dias" (mostradas por 30 dias, num bloco recolhido).
- **Início e selo do menu:** entregas e provas com data nos próximos 7 dias. As "a confirmar" aparecem num contador próprio, fora do Início.
- **Situação do resumo** pelo começo de `resumo_em`: data → resumido; "parcial" → parcial; vazio ou começando por "não", "sem", "pendente" ou "a fazer" → sem resumo; outro texto → outro. O resto do texto entre parênteses aparece como observação.
- **Linhas duplicadas:** o mesmo módulo pode vir da pasta do Mac (`arquivo` = "N arquivos") e do Drive (`arquivo` = "Google Drive"). O painel junta pelo curso, a fase e o número do módulo ("MÓDULO 1 - ..." e "Módulo 1 ..."), mantém o nome da linha do Mac e usa o melhor resumo. Linhas de fase `TODAS` (Resumo Mestre) aparecem no topo do curso.
- **Curso das linhas:** `curso` de módulos e entregas casa com o `curso` de `Cursos.csv` pelo começo do nome ("CURSO X" casa com "CURSO X - Tema").
- **Caminho do resumo** (`resumo_arquivo`): sem o prefixo `materiais/`, relativo à pasta de materiais; um texto depois de `.md` ("seção 8.3") vira nota ao lado do link. Um nome solto é procurado na raiz e nas subpastas de primeiro nível. Achou: link para o arquivo no Drive (cache de 1 h). Não achou (por exemplo, `RESUMOS MESTRE/...`, que só existe no Mac): "Resumo fora da pasta de materiais", com o caminho na dica, e o "não achou" fica no cache por 10 min.
- **Pedidos:** `estado` começando por "entregue" vai para "Entregues recentes" (5 mais novos); começando por "cancelado" ou "desistiu" some da tela; qualquer outro texto vai para "Pedidos em andamento".

## Propostas de colunas para o Assistente de Estudos

1. `Modulos.csv`: `resumo_arquivo` sempre relativo à pasta de materiais do Drive (hoje mistura `materiais/...`, nome solto com "seção 10.2" no fim e `RESUMOS MESTRE/...`, que só existe no Mac) e uma coluna `resumo_fileId`.
2. `Modulos.csv`: `resumo_em` só com a data, e a situação ("parcial") e a observação em colunas próprias (`resumo_situacao`, `obs`).
3. `Modulos.csv`: uma linha por módulo, com uma coluna `origem` (mac, drive, ambos), em vez da linha do Mac e da linha "Google Drive" separadas.
4. Gravar em NFC (acentos compostos) também nas linhas que vêm do Mac.
5. `Entregas.csv` e `Provas.csv`: hora sempre preenchida, ou uma coluna `hora` vazia quando o calendário não diz; `evento_id` completo (hoje vem truncado com "...").
6. `Cursos.csv`: `calendario` com o id ou o nome do calendário quando estiver confirmado.
