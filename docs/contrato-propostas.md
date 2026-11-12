# Contrato do módulo anúncios: Propostas, decisões e recibos

Fonte da verdade para o painel (JS) e para o consumidor (Python, `consumidor/consumidor_anuncios.py`). As escolhas de implementação estão em "Decisões de implementação" no fim.

Fluxo: o Gestor de Tráfego escreve `Propostas.csv` → o painel mostra e grava uma linha em `decisoes.csv` → o consumidor (`--plano`) confere a decisão e entrega a ação ao agente → o agente executa na Meta → o consumidor (`--confirmar <decision_id>`) aplica em `Propostas.csv` e grava `recibos/<decision_id>.json` → o painel mostra processado ou recusado. Decisões inválidas ou de versão velha recebem o recibo `rejeitado` já no `--plano`.

## Propostas.csv

Escrito só pelo Gestor de Tráfego (e pelo consumidor, que roda como ele). Lido pelo painel.

Cabeçalho exato:

```
id,tipo,empresa,pedido_id,versao,formato,contas,horario,midia_fileIds,legenda_1,legenda_2,legenda_escolhida,hashtags,campanha_id,verba_diaria,inicio,fim,publico_resumo,plano_fileId,estado,atualizado_em,plataforma_link
```

| Campo | Regra |
| --- | --- |
| `id` | único por linha. Post: id do pedido ou próprio (`P-20261112-CAT`). Campanha: `C02`, `M-...`, `G-...` |
| `tipo` | `post` ou `campanha` |
| `versao` | inteiro; sobe a cada mudança de legenda, mídia, contas, horário ou verba; nunca reutilizado |
| `formato` | `feed`, `reels`, `story`, `carrossel` (post) |
| `contas` | lista separada por `;` (ex.: `ig:@bd3doficial;fb:1506484655871632`) |
| `horario` | `aaaa-mm-dd HH:mm`, horário de São Paulo |
| `midia_fileIds` | ids do Drive separados por `;`, na ordem do carrossel |
| `legenda_escolhida` | vazio até a aprovação; depois `1` ou `2` |
| `verba_diaria` | número com ponto decimal (`10`, `8.5`) |
| `inicio`, `fim` | `aaaa-mm-dd` |
| `estado` | post: `rascunho`, `aguardando_aprovo`, `aprovado`, `programado`, `publicado`, `recusado`, `ajuste`. Campanha: `plano`, `aprovado`, `ativo`, `pausado`, `encerrado`, `ajuste` |
| `atualizado_em` | ISO 8601 com `-03:00` |
| `plataforma_link` | link http quando publicado/ativo |

Arquivo UTF-8, registros terminados em CRLF, CSV padrão (campos com vírgula, aspas ou quebra de linha vão entre aspas, aspas dobradas). Dentro de um campo a quebra de linha pode ser LF (é assim no fixture).

### Exemplo real (fixture `test/fixtures/anuncios/Propostas.csv`)

Post `P-20261111-01` (a legenda 1 tem quebras de linha dentro das aspas):

```
P-20261111-01,post,BD 3D,P-20261111-01,1,feed,ig:@bd3doficial;fb:1506484655871632,2026-11-13 18:30,1rh0QuNdtj0DCyDwSJJHO71S4V782gbAI,"Mesa posta de Natal com charme: kit com 2 porta-guardanapos árvore, 1 dourado e 1 vermelho, por R$ 9,97. Chame pelo link da bio.

Árvore em espiral com estrela no topo, um detalhe que deixa cada lugar da mesa mais especial.

WhatsApp (34) 98719-3543 · @bd3doficial","Um detalhe que muda a mesa de Natal. Kit com 2 porta-guardanapos árvore (dourado + vermelho) por R$ 9,97. Peça no WhatsApp: wa.me/5534987193543",,#BD3D #MesaPosta #MesaPostaDeNatal #DecoracaoDeNatal #PortaGuardanapo #Natal2026 #Araxa #TrianguloMineiro #PresentesDeNatal,,,,,,,aguardando_aprovo,2026-11-12T10:00:00-03:00,
```

Campanha `C02`:

```
C02,campanha,BD 3D,,1,,,,,,,,,C02,10,2026-11-14,2026-12-15,"Triângulo Mineiro e Alto Paranaíba, 25 a 60 anos; conjunto A empresas (brindes) e B eventos (medalhas e troféus)",1fSzU-k4WdftEEuALxddiFfc4IjhvUVCQ,plano,2026-11-12T10:10:00-03:00,
```

## Hash do snapshot

Igual em JS e Python. Para cada campo: texto (vazio se ausente) → trocar `\r\n` e `\r` por `\n` → tirar espaços das pontas com a regra do `String.prototype.trim()` do JavaScript. Juntar com U+001F (␟). SHA-256 do UTF-8, hex minúsculo.

- post: `post␟id␟versao␟midia_fileIds␟legenda_1␟legenda_2␟hashtags␟contas␟horario␟estado`
- campanha: `campanha␟id␟versao␟verba_diaria␟inicio␟fim␟publico_resumo␟plano_fileId␟estado`

Texto canônico da `C02`:

```
campanha␟C02␟1␟10␟2026-11-14␟2026-12-15␟Triângulo Mineiro e Alto Paranaíba, 25 a 60 anos; conjunto A empresas (brindes) e B eventos (medalhas e troféus)␟1fSzU-k4WdftEEuALxddiFfc4IjhvUVCQ␟plano
```

Vetores do fixture (também em `consumidor/vetores_hash.json`, conferidos em Python e Node):

| id | hash |
| --- | --- |
| P-20261111-01 | `607f35ce898e949de9408f739e5b049b9ef984b67a6c0bc46dc7927ee17a6502` |
| P-20261112-CAT | `86cada420b41ff4707640d9a70763d5c8f35667919d43201060594c2b1da6b00` |
| C02 | `8ed605d1139b49e8e40f52a1489e2e05bc852ed588cbd375a9511bc9e6c30ac3` |
| M-52562345108818 | `fd52e27553dbcc2bdf543f01b409a4cadcb03a57fb155ac30c90413edb1f5ab4` |

Atenção ao trim em Python: `str.strip()` sem argumento remove também U+001C a U+001F e U+0085 e não remove U+FEFF, então difere do JS. Use o conjunto explícito do script abaixo.

### Script de referência (Python, autocontido)

```python
#!/usr/bin/env python3
"""Uso: python3 hash_propostas.py Propostas.csv  -> imprime 'id hash' por linha."""
import csv, hashlib, sys

JS_WS = ("\t\n\u000b\u000c\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006"
         "\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff")
POST = ["id", "versao", "midia_fileIds", "legenda_1", "legenda_2", "hashtags", "contas", "horario", "estado"]
CAMPANHA = ["id", "versao", "verba_diaria", "inicio", "fim", "publico_resumo", "plano_fileId", "estado"]

def norm(v):
    return ("" if v is None else str(v)).replace("\r\n", "\n").replace("\r", "\n").strip(JS_WS)

def snapshot_hash(linha):
    tipo = norm(linha.get("tipo"))
    campos = POST if tipo == "post" else CAMPANHA
    texto = "\u001f".join([tipo] + [norm(linha.get(c)) for c in campos])
    return hashlib.sha256(texto.encode("utf-8")).hexdigest()

with open(sys.argv[1], encoding="utf-8-sig", newline="") as f:
    for linha in csv.DictReader(f):
        print(linha["id"], snapshot_hash(linha))
```

Equivalente em JS: `[tipo, ...campos.map(k => String(l[k] ?? '').replace(/\r\n|\r/g, '\n').trim())].join('\u001f')` e SHA-256 hex.

## Decisão (linha em decisoes.csv)

O painel acrescenta linhas; ninguém reescreve o arquivo.

```
id,quando,modulo,item_id,tipo_item,versao,arte_fileId,snapshot_hash,decisao,comentario,origem
```

| Campo | Regra |
| --- | --- |
| `modulo` | `anuncios` (o consumidor ignora os outros módulos) |
| `item_id` | `post:<id>` ou `campanha:<id>`; o prefixo tem de ser igual a `tipo_item` |
| `tipo_item` | `post` ou `campanha` |
| `versao` | versão exibida no painel |
| `arte_fileId` | `midia_fileIds` exibido (vazio para campanha) |
| `snapshot_hash` | hash da linha exibida (64 hex) |
| `decisao` | `aprovar`, `refazer`, `recusar`, `pausar` |
| `origem` | `painel` |

Estados decidíveis:

| Tipo | Decisão | Estados aceitos |
| --- | --- | --- |
| post | aprovar, refazer, recusar | `rascunho`, `aguardando_aprovo` |
| campanha | aprovar, refazer, recusar | `plano`, `ajuste` |
| campanha | pausar | `ativo` |
| post | pausar | nunca |

### comentario

Pares `chave=valor` separados por `;`, na ordem `legenda`, `horario`, `verba`, `texto`. Cada chave aparece no máximo uma vez. `texto` é sempre o último e pode conter `;` e `=`: tudo depois de `texto=` é o texto. Quebras de linha do texto viram espaço. Sem espaços ao redor de `;` e `=` nas chaves.

| Tipo e decisão | Chaves |
| --- | --- |
| post aprovar | `legenda=1` ou `legenda=2` obrigatório; `horario=aaaa-mm-dd HH:mm` opcional; `texto` opcional |
| post refazer | só `texto`, obrigatório e não vazio |
| post recusar | `texto` opcional (comentario pode ser vazio) |
| campanha aprovar | `verba=N` opcional (número > 0, ponto decimal, ≤ `verba_diaria` da proposta); `texto` opcional |
| campanha refazer | só `texto`, obrigatório |
| campanha recusar, pausar | `texto` opcional |

Exemplos válidos: `legenda=1;horario=2026-11-13 18:30;texto=usar a foto 2` · `verba=8` · `texto=trocar o público`.
Inválidos: `horario=...;legenda=1` (ordem), `legenda=3`, `legenda=1;` (`;` sobrando), `trocar o público` (sem `texto=`), `verba=8,5` (vírgula), qualquer chave que não vale para aquela decisão.

## Recibo (recibos/<decision_id>.json)

Escrito só pelo agente (consumidor). Imutável.

```json
{
  "decision_id": "D-20261112-0001",
  "snapshot_hash": "8ed605d1139b49e8e40f52a1489e2e05bc852ed588cbd375a9511bc9e6c30ac3",
  "resultado": "aplicado",
  "motivo": "aprovada com verba 8 (versao 2)",
  "processado_em": "2026-11-12T15:00:00-03:00",
  "agente": "Gestor de Tráfego"
}
```

`resultado`: `aplicado` ou `rejeitado`. `link` opcional (http). `snapshot_hash` é o da decisão (a versão que o Bruno viu).

Motivos de rejeição usados pelo consumidor: `versão desatualizada`, `decisão duplicada: esta versão já foi decidida`, `item não existe em Propostas.csv`, `tipo_item não confere com Propostas.csv`, `item_id não confere com tipo_item`, `estado <x> não aceita <decisão>`, `decisão <x> não vale para <tipo>`, `comentario inválido: <detalhe>`, `verba acima da proposta`, `proposta sem verba_diaria válida`, `snapshot_hash inválido`.

## Aplicar (consumidor)

O `--plano` lista a ação; a mudança abaixo só é gravada no `--confirmar`, depois que o agente agiu. Nas duas fases o consumidor só segue se o hash recalculado da linha atual for igual ao `snapshot_hash` da decisão. Sempre grava `atualizado_em` = `processado_em` do recibo.

| Decisão | Mudança em Propostas.csv | Ação para o agente |
| --- | --- | --- |
| post aprovar | `estado=aprovado`, `legenda_escolhida=N`; horário novo se veio e é diferente (`versao+1`) | `programar_post` (contas, horário, mídias na ordem, legenda escolhida, hashtags) |
| post refazer | `estado=ajuste` | `refazer_post` com o texto |
| post recusar | `estado=recusado` | `registrar_recusa_post` |
| campanha aprovar | `estado=aprovado`; verba nova se veio e é menor (`versao+1`); igual não muda; maior → rejeitado | `criar_campanha` |
| campanha refazer | `estado=ajuste` | `refazer_campanha` |
| campanha recusar | `estado=encerrado`, motivo "recusada pelo Bruno" | `registrar_recusa_campanha` |
| campanha pausar | `estado=pausado` | `pausar_campanha_meta` (feito pelo agente) |

O consumidor nunca publica, nunca chama a API da Meta e nunca aumenta verba. As ações saem no JSON do `--plano` (stdout), que o Gestor de Tráfego executa com as próprias regras antes de rodar `--confirmar`.

## Decisões de implementação

1. Trim: segue o `String.prototype.trim()` do JS (não o `str.strip()` do Python).
2. Escolher a legenda (`legenda_escolhida`) não sobe `versao`; só horário diferente (post) ou verba menor (campanha) sobem.
3. Além do hash, o consumidor confere `versao` da decisão contra a linha (redundante, mesma mensagem "versão desatualizada").
4. `id` repetido em `decisoes.csv`: só a primeira linha vale, as outras são ignoradas sem recibo (o nome do recibo já pertence à primeira). Mesma versão (item + hash) já aplicada por outra decisão: recibo rejeitado "decisão duplicada". Uma decisão rejeitada antes não bloqueia uma nova sobre a mesma versão.
5. Verba é normalizada ao gravar (`8.50` → `8.5`). Verba igual à proposta aprova sem mudar a linha.
6. Ledger de fases: `planejada` (no `--plano`) → `confirmando` (no `--confirmar`, já com o `hash_depois` previsto, antes do upload) → `propostas_atualizada` → `recibo_criado`. Se a execução cair entre o upload e o registro de `propostas_atualizada`, o próximo `--confirmar` reconhece a linha pelo `hash_depois` e só cria o recibo. Rejeições vão de `rejeitada` para `recibo_criado`. Entradas antigas com a fase `recebida` são convertidas (ver README do consumidor).
7. Create ambíguo do recibo: uma listagem por nome. Existe → feito. Não existe → pendente para o próximo `--confirmar` (não recria na mesma execução, para não duplicar se a listagem do Drive estiver atrasada). Dois ou mais com o mesmo nome → não cria outro e avisa.
8. Ledger em `recibo_criado` mas o recibo sumiu de `recibos/`: não recria, só avisa.
9. Antes de cada upload o consumidor confere o md5 de `Propostas.csv` no Drive; se mudou desde o download, para sem gravar.
10. `Propostas.csv` não configurado (`propostas_fileId` = `PREENCHER`): o `--plano` sai com mensagem e código 0, sem rejeitar as decisões (elas esperam); o `--confirmar` sai com 3.
11. Qualquer 401/403/invalid_grant/unauthenticated (ou exit 2 do gws) para tudo com código 2, inclusive 403 de cota.
12. Se a linha mudou entre o `--plano` e o `--confirmar`, o `--confirmar` não grava nada e sai com 3 ("versão desatualizada"); se o agente já agiu na Meta, a correção de `Propostas.csv` é manual.
