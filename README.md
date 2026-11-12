# Painel Grupo Smart

Painel visual, privado e mobile-first, para o Bruno ver e aprovar as artes e os posts criados pelos agentes do Grupo Smart (RN Sports, BD 3D, Smart Produtora, Include Systems). É a fonte única da verdade em cima dos arquivos que os agentes já mantêm no Google Drive: o painel lê esses arquivos e não copia nada para outro banco.

**Status:** v1 publicada em 11/11/2026 como Web App do Google Apps Script, acesso só do dono. v2.0.0 acrescentou o módulo **Posts e anúncios** (Gestor de Tráfego); v2.0.1 corrige o que apareceu na produção. Módulos ativos: **Design** (Agente de Design) e **Posts e anúncios**. Os outros já têm lugar reservado.

![Início no celular](docs/screenshots/390-claro-inicio.jpg)

## Produção e main

A produção (Web App, implantação **versão 5 = v2.0.0**, de 12/11/2026) está atrás da `main`. Decisão do Bruno em 12/11: os próximos módulos (Finanças, Investimentos e Suporte) entram na `main` por PR, com testes, **sem reimplantar**. Tudo vai para a produção de uma vez quando esses módulos estiverem prontos.

Falta implantar:

- **v2.0.1:** período da campanha vem do ledger quando a proposta não tem datas; campanha cruzada com ou sem `M-`; um cartão por post com as programações (feed, story); cache por arquivo e tela anterior na hora (primeira carga mais rápida).
- **v3.0.0-suporte:** base comum dos módulos v3 (menu **Mais** no celular e no desktop, cartão por agente no Início com a contagem do que precisa do Bruno, selo no menu, caminho genérico de decisões com chave por módulo) e o módulo **Suporte RN Sports** (fila de respostas para aprovar, rascunhos só no Zendesk, alertas, abertos por evento e tipo, parados há mais de 24 h). Chave `SUPORTE_INTEGRADO` em `false`: botões desligados com o aviso "o agente ainda não lê estas decisões" e o servidor recusa gravar. Corrige também o cabeçalho que prendia a barra de abas do celular no topo. Contrato: [docs/contrato-suporte.md](docs/contrato-suporte.md). Antes de implantar, preencha em `painel-fontes.json` o `ledger.folderId` do Suporte (e, se quiser, os fileIds em `arquivos`).
- **v3.0.0-emails:** módulo **E-mails** (Gestor de E-mails): movimentações propostas agrupadas por conta e pasta (aprovar o grupo ou recusar), pendências abertas (marcar como resolvida ou pedir rascunho), alertas recentes e rascunhos. Só conta, pasta, motivo, remetente, assunto, data e estado; nunca corpo nem anexos. Chave `EMAILS_INTEGRADO` em `false`. Contrato: [docs/contrato-emails.md](docs/contrato-emails.md). Antes de implantar, preencha em `painel-fontes.json` o `ledger.folderId` dos E-mails.

## Sumário

- [Telas](#telas)
- [Capturas](#capturas)
- [Arquitetura](#arquitetura)
- [Decisões e agentes](#decisões-e-agentes)
- [Módulo Posts e anúncios](#módulo-posts-e-anúncios)
- [Testes](#testes)
- [Como publicar](#como-publicar-primeira-vez)
- [Como reimplantar](#como-reimplantar-depois-de-uma-mudança)
- [Como acrescentar um módulo](#como-acrescentar-um-módulo)
- [Problemas comuns](#problemas-comuns)
- [Segurança](#segurança)

## Arquitetura

- **Google Apps Script Web App** (HtmlService). Executa como o Bruno e só o Bruno acessa (`executeAs: USER_DEPLOYING`, `access: MYSELF`). Nada fica em site público.
- **Leitura:** `Code.gs` lê os CSVs e os `post-*.md` do Drive com `DriveApp` e monta o modelo com `Lib.gs` (funções puras, testadas no Node).
- **Configuração:** um único arquivo, `painel-fontes.json`, na pasta `painel-grupo-smart` do Drive. Ele diz qual módulo lê quais arquivos (fileId e folderId). Não há ids espalhados no código. Exemplo em `config/painel-fontes.example.json`.
- **Cache:** `CacheService` por 5 minutos (`cache_minutos`). O botão **Atualizar agora** ignora o cache.
- **Imagens:** miniaturas por `https://drive.google.com/thumbnail?id=<fileId>&sz=w1000`, com plano B pelo servidor (`obterMiniatura`) quando a URL não carrega. Vídeos abrem no player do Drive.
- **Decisões:** **Aprovar** e **Pedir ajuste** só acrescentam uma linha em `decisoes.csv` (pasta do painel), presa à versão exata que estava na tela (`snapshot_hash`). O servidor confere o item e o estado atuais antes de gravar e recusa versão velha. O painel nunca edita os arquivos dos agentes. Os agentes respondem com um recibo imutável em `recibos/`. Detalhes em [Contrato de decisões](#contrato-de-decisões).
- **Robustez:** cada fonte é lida separada. Arquivo ausente ou CSV quebrado vira um aviso no topo e o resto continua.

```
src/
  appsscript.json   manifesto (fuso, V8, Web App só para você)
  Code.gs           servidor: doGet, obterDados, obterMiniatura, salvarDecisao
  Lib.gs            parsing de CSV e md, modelo das telas, validação (sem serviços Google)
  Index.html        estrutura da página
  Styles.html       visual (tema claro e escuro, selos com texto)
  App.html          comportamento da tela
config/painel-fontes.example.json
test/               testes do Node com CSVs reais (fixtures)
dev/                harness local: monta a página com google.script.run simulado
docs/screenshots/   capturas a 390 px e no desktop
```

## Telas

- **Início (Precisa de você):** artes `entregue`, posts com rascunho e sem `post:`, `refazer` parado há mais de 2 dias, decisões enviadas e a última atualização de cada fonte.
- **Designs:** grade com miniaturas, filtros por empresa, estado e tipo, e busca. O detalhe mostra todas as versões, o histórico de refação e os links do Canva e do Drive.
- **Posts:** linha do tempo por estado, com arte, legenda do `post-*.md`, contas e link publicado. Com o módulo Posts e anúncios ativo, a tela passa a ler o ledger do Tráfego (veja abaixo).
- **Campanhas:** só com o módulo Posts e anúncios ativo.
- **Biblioteca e produtos:** mídia por empresa (`Midia.csv`) e o catálogo (`produtos.csv`).

### Estados dos posts

| Estado | Regra |
|---|---|
| rascunho | tem `post-<id>.md`, arte ainda não aprovada |
| aguardando_aprovo | arte aprovada, rascunho sem "APROVADO" |
| aprovado | rascunho com "Estado: APROVADO" e ainda sem marca `post:` (falta programar) |
| programado | `post:programado <data>` no `obs` com data futura |
| aguardando_confirmacao | `post:programado <data>` com data já passada e sem `post:<link>` do mesmo formato |
| publicado | `post:<link> <data>` no `obs` (só com link; o relógio nunca marca publicado) |
| manual | `post:manual` no `obs` |

O estado **aprovado** é um acréscimo à lista original: separa o que você já aprovou do que ainda espera você.

## Capturas

| Celular (390 px) | Desktop |
|---|---|
| ![Início, tema escuro](docs/screenshots/390-escuro-inicio.jpg) | ![Início, tema escuro](docs/screenshots/desktop-escuro-inicio.jpg) |
| ![Designs](docs/screenshots/390-claro-designs.jpg) | ![Designs](docs/screenshots/desktop-claro-designs.jpg) |
| ![Detalhe de um design](docs/screenshots/390-claro-detalhe.jpg) | ![Detalhe de um design](docs/screenshots/desktop-claro-detalhe.jpg) |
| ![Posts](docs/screenshots/390-claro-posts.jpg) | ![Posts](docs/screenshots/desktop-claro-posts.jpg) |
| ![Biblioteca e produtos](docs/screenshots/390-claro-biblioteca.jpg) | ![Biblioteca e produtos](docs/screenshots/desktop-claro-biblioteca.jpg) |
| ![Pedir ajuste](docs/screenshots/390-claro-ajuste.jpg) | ![Depois de decidir](docs/screenshots/desktop-claro-apos-decisao.jpg) |
| ![Aviso de fonte com erro](docs/screenshots/390-claro-aviso-fonte.jpg) | |
| ![Início com decisão obsoleta e recusada](docs/screenshots/v2-390-inicio.jpg) | ![Início com decisão obsoleta e recusada](docs/screenshots/v2-desktop-inicio.jpg) |
| ![Posts aguardando confirmação](docs/screenshots/v2-390-posts.jpg) | ![Posts aguardando confirmação](docs/screenshots/v2-desktop-posts.jpg) |
| ![Versão velha recusada](docs/screenshots/v2-390-recusa-obsoleta.jpg) | ![Versão velha recusada](docs/screenshots/v2-desktop-recusa-obsoleta.jpg) |

### v2.0.0: Posts e anúncios

| Celular | Desktop |
|---|---|
| ![Início](docs/screenshots/v2/inicio-390-claro.jpg) | ![Início](docs/screenshots/v2/inicio-desktop-claro.jpg) |
| ![Carrossel 10/10](docs/screenshots/v2/carrossel-390-10.jpg) | ![Carrossel em grade](docs/screenshots/v2/carrossel-desktop.jpg) |
| ![Campanha ativa](docs/screenshots/v2/campanha-ativa-390.jpg) | ![Campanhas](docs/screenshots/v2/campanhas-desktop-escuro.jpg) |

### v2.0.1: correções da produção

| Posts (celular) | Programações do post (celular) | Campanhas (desktop) |
|---|---|---|
| ![Posts](docs/screenshots/v2.0.1/390-posts.jpg) | ![Programações](docs/screenshots/v2.0.1/390-post-detalhe.jpg) | ![Campanhas](docs/screenshots/v2.0.1/desktop-campanhas.jpg) |

### v3.0.0-suporte: base comum e Suporte RN Sports

Chave `SUPORTE_INTEGRADO` desligada (botões desabilitados). As capturas de diálogo e "depois de decidir" usam o harness com `--integrado-v3`.

| Celular (390 px) | Desktop |
|---|---|
| ![Início com cartão do Suporte](docs/screenshots/v3/suporte/390-claro-inicio-cartoes.jpg) | ![Início com cartão do Suporte](docs/screenshots/v3/suporte/desktop-claro-inicio-cartoes.jpg) |
| ![Menu Mais](docs/screenshots/v3/suporte/390-claro-menu-mais.jpg) | ![Menu Mais](docs/screenshots/v3/suporte/desktop-claro-menu-mais.jpg) |
| ![Suporte, tema claro](docs/screenshots/v3/suporte/390-claro-modulo.jpg) | ![Suporte, tema claro](docs/screenshots/v3/suporte/desktop-claro-modulo.jpg) |
| ![Suporte, tema escuro](docs/screenshots/v3/suporte/390-escuro-modulo.jpg) | ![Suporte, tema escuro](docs/screenshots/v3/suporte/desktop-escuro-modulo.jpg) |
| ![Pedir ajuste (chave ligada)](docs/screenshots/v3/suporte/390-claro-dialogo.jpg) | ![Depois de decidir (chave ligada)](docs/screenshots/v3/suporte/desktop-claro-apos-decisao.jpg) |

### v3.0.0-emails: E-mails

| Celular (390 px) | Desktop |
|---|---|
| ![E-mails, tema claro](docs/screenshots/v3/emails/390-claro-modulo.jpg) | ![E-mails, tema claro](docs/screenshots/v3/emails/desktop-claro-modulo.jpg) |
| ![E-mails, tema escuro](docs/screenshots/v3/emails/390-escuro-modulo.jpg) | ![E-mails, tema escuro](docs/screenshots/v3/emails/desktop-escuro-modulo.jpg) |
| ![Recusar grupo (chave ligada)](docs/screenshots/v3/emails/390-claro-dialogo.jpg) | ![Depois de decidir (chave ligada)](docs/screenshots/v3/emails/desktop-claro-apos-decisao.jpg) |

## Decisões e agentes

1. Você toca em **Aprovar v<N>** ou **Pedir ajuste** (com comentário) num cartão `entregue` (designs) ou `rascunho`/`aguardando_aprovo` (posts). O detalhe só oferece Aprovar na versão mais recente.
2. O navegador envia o `snapshot_hash` da versão que está na tela.
3. O servidor trava (`LockService`), relê as fontes sem cache e confere: o item existe, o estado ainda aceita decisão, o hash é igual ao atual e não há decisão pendente igual. Se algo falhar, nada é gravado e a tela avisa e se atualiza.
4. O painel acrescenta uma linha em `decisoes.csv` e o cartão mostra "Enviado (aprovar) para a versão vN, aguardando o agente".
5. O agente do módulo processa a linha e cria `recibos/<decision_id>.json`. O cartão passa a "processado" (aplicado) ou aparece em **Recusadas pelo agente** (rejeitado).
6. Se o item mudar antes do recibo, o cartão mostra "O item mudou; o agente vai recusar".

`item_id` é o id do pedido em `pedidos-de-arte.csv` (ex.: `P-20261111-02`) ou o id da arte em `Artes.csv` quando não há pedido. Posts usam `post:<id>`.

## Contrato de decisões

### decisoes.csv (só o painel escreve, só acrescenta)

```
id,quando,modulo,item_id,tipo_item,versao,arte_fileId,snapshot_hash,decisao,comentario,origem
```

- `id`: `D-yyyyMMdd-HHmmss-<8 caracteres>`, único.
- `quando`: horário de São Paulo, `yyyy-MM-dd HH:mm:ss`.
- `tipo_item`: `design` ou `post`. `versao` e `arte_fileId`: os da versão exibida.
- `snapshot_hash`: SHA-256 (64 hex, minúsculo) do texto canônico abaixo.
- `decisao`: `aprovar` ou `refazer`. `origem`: `painel`.
- O servidor recusa gravar se o cabeçalho for diferente deste. Os agentes nunca escrevem em `decisoes.csv`.

### Texto canônico e hash

Campos sem espaços nas pontas, unidos pelo caractere U+001F:

```
design: design␟id␟versao␟arte_fileId␟canva_design_id␟estado
post:   post␟id␟arte_fileId␟legenda␟hashtags␟contas␟horario␟estado
```

```python
import hashlib
campos = ["design", "P-20261111-02", "v1", "<arte_fileId>", "<canva_design_id>", "entregue"]
h = hashlib.sha256("\x1f".join(c.strip() for c in campos).encode("utf-8")).hexdigest()
```

Nos posts, `legenda`, `hashtags`, `contas` e `horario` vêm do `post-<id>.md` (legenda escolhida, linha de hashtags, "Contas de destino", "Horário").

### recibos/<decision_id>.json (só o agente escreve)

```json
{
  "decision_id": "D-20261111-201500-ab12cd34",
  "processado_em": "2026-11-11 20:20:00",
  "resultado": "aplicado",
  "motivo": "",
  "agente": "Agente de Design",
  "snapshot_hash": "<o mesmo da linha>"
}
```

- Um arquivo por decisão, nome igual ao `decision_id`. Criado uma vez, nunca sobrescrito nem apagado.
- `resultado`: `aplicado` ou `rejeitado` (com `motivo`).
- Antes de aplicar, o agente confere a versão atual: recalcula o hash ou, no mínimo, compara `versao` e `arte_fileId` com os arquivos. Se mudou, grava `rejeitado` com o motivo e não aplica.
- Linha sem recibo = pendente. Recibo inválido ou repetido vira aviso no topo do painel.

### Posts: integração pendente

Decisões de post (`post:<id>`) ainda não têm consumidor. A tela não oferece botões de aprovação de post e o servidor recusa qualquer `post:<id>` (`POSTS_INTEGRADOS = false` em `Lib.gs`) até o fluxo do Gestor de Tráfego ficar pronto. Aprovar uma arte nunca autoriza o post.

### Publicado

O painel nunca deduz "publicado" pelo relógio. Programado com horário vencido e sem `post:<link>` aparece como **Aguardando confirmação** em Início e em Posts, até o agente registrar o link.

## Módulo Posts e anúncios

Lê o ledger do Gestor de Tráfego (`Anuncios.csv`, `Campanhas.csv`, `Resultados.csv`, `Empresas.csv`, `Checkpoints.csv`, `Rules.csv` só leitura e `Propostas.csv`) e a pasta de criativos (`post-*.md` e `plano-<empresa>-<aaaa-mm>.md`). Os ids ficam no `painel-fontes.json` (`modulos.anuncios.ledger.abas` e `modulos.anuncios.criativos`).

- **Início:** posts aguardando seu aprovo, planos aguardando seu sim, alertas de gasto e um contador por empresa.
- **Posts:** linha do tempo `rascunho` > `aguardando_aprovo` > `aprovado` > `programado` > `aguardando_confirmacao` > `publicado` (só com link), mais `recusado`. Filtro por empresa e conta. O cartão mostra a mídia, as duas legendas lado a lado, hashtags, contas, horário e link.
- **Carrossel:** `midia_fileIds` (e `arte_fileId` nos designs) aceita vários ids separados por `;`. No celular arrasta com contador (1/10); no desktop vira grade.
- **Campanhas:** cartões com estado, objetivo, verba, período, gasto acumulado e dos últimos 7 dias, impressões, cliques, contatos e custo por contato (só com contatos > 0), gráfico de gasto diário e o plano `.md` no detalhe. Leituras de período (30d) aparecem separadas do diário. Resultados da semana por empresa e a última leitura de cada canal.
- **Um cartão por post:** quando o post está no `Propostas.csv`, as linhas do `Anuncios.csv` do mesmo post (feed, story) viram **Programações** dentro do cartão da proposta. A ligação é pelo pedido citado no texto (`P-aaaammdd-n`) ou pela mídia + horário (ou mídia + dia, só para propostas). Duas linhas do ledger com a mesma mídia e o mesmo horário também viram um cartão só.
- **Campanha cruzada pelo id:** `campanha_id` do `Propostas.csv` com ou sem o prefixo `M-`/`G-`, ou o id da plataforma, cai na mesma campanha do `Campanhas.csv`.
- **Campos vazios na proposta:** verba, início e fim vazios usam o valor do `Campanhas.csv` (por exemplo "após aprovação a 18/12").
- **Sem `Propostas.csv`:** nada quebra. Aparece o aviso "Propostas estruturadas ainda não ativadas" e os itens ficam só para consulta.

### Decisões de anúncios

Mesmo `decisoes.csv`, com `modulo=anuncios`, `item_id` `post:<id>` ou `campanha:<id>` e `tipo_item` `post` ou `campanha`. Só itens que vêm do `Propostas.csv` têm botões.

- Post: **Aprovar com legenda 1**, **Aprovar com legenda 2** (horário opcional), **Pedir ajuste**, **Recusar**.
- Campanha: **Aprovar plano** (verba opcional, nunca acima da proposta), **Pedir ajuste**, **Recusar**; **Pausar** quando ativa.
- `comentario` estruturado: `legenda=1;horario=aaaa-mm-dd HH:mm;verba=N;texto=...`.
- Chave `ANUNCIOS_INTEGRADOS` em `Lib.gs` (hoje `false`): os botões ficam desligados com o aviso "o Gestor de Tráfego ainda não lê estas decisões" e o servidor não grava nada. `POSTS_INTEGRADOS` (posts do Design) continua `false`.
- Recibos em `recibos/` com `agente: "Gestor de Tráfego"`; o painel mostra processado, recusado ou aplicado com link.

Contrato completo, exemplos reais e o script de hash: [docs/contrato-propostas.md](docs/contrato-propostas.md). O consumidor do Tráfego (ainda não ligado) fica em [consumidor/](consumidor/README.md).

## Testes

```
npm test
python3 -m unittest discover consumidor
```

v3.0.0-emails: 59 testes no Node (7 novos em `test/v3-emails.test.js`). v3.0.0-suporte: 52 testes no Node (9 novos em `test/v3-suporte.test.js`, com as fixtures anonimizadas de `test/fixtures/suporte/`). v2.0.1: 43 testes no Node e 29 no consumidor Python. v2.0.0: 35 e 29. Os vetores de hash do `Propostas.csv` são conferidos nos dois lados.

22 testes: CSV com BOM, CRLF, aspas e quebra de linha; CSV quebrado; colunas ausentes; leitura dos CSVs reais; marcas `post:`; rascunho `post-*.md`; o modelo das telas; decisões, hash, versão velha, decisão repetida, estado inválido, recibos, cabeçalho antigo e a regra do relógio; a versão do painel; e o `Code.gs` com os serviços do Google simulados (cache, fonte quebrada, gravação em `decisoes.csv`).

Para ver a página localmente com os dados das fixtures:

```
./dev/baixar-imagens.sh     # uma vez (precisa do gws)
npm run build:dev           # gera dev/out/index.html (v2, 12/11 19:00, com Propostas)
node dev/build.js --sem-propostas   # sem Propostas.csv
node dev/build.js --integrado       # chave ANUNCIOS_INTEGRADOS ligada (só no harness)
node dev/build.js --v1              # fixtures da v1
node dev/build.js --integrado-v3    # liga as chaves dos módulos v3 (só no harness)
node dev/build.js --sem-v3          # sem os módulos v3
python3 dev/shots_v3.py suporte base        # capturas do módulo (servidor na 8765 no mesmo comando)
python3 dev/shots_v3.py suporte integrado   # diálogo e depois de decidir (build com --integrado-v3)
python3 dev/shots_v3.py emails integrado recusar "texto"   # decisão e texto do diálogo
python3 -m http.server 8765 -d dev/out
```

## Como publicar (primeira vez)

O projeto já existe no seu Drive: pasta `painel-grupo-smart`, arquivo **Painel Grupo Smart**.

1. Abra o projeto no [editor do Apps Script](https://script.google.com/d/14gDaS5OQIBiMtWAeaCm5Nd5OVcCmuuqXMaguN1vUrgMpCBLsqINCe2xu/edit) (ou, no Drive, clique duas vezes em **Painel Grupo Smart**).
2. Clique em **Implantar** > **Nova implantação**.
3. Na engrenagem, escolha **App da Web**.
4. **Executar como:** Eu. **Quem pode acessar:** Somente eu.
5. Clique em **Implantar** e autorize o acesso ao Drive (uma vez só). Se aparecer "o Google não verificou este app", clique em **Avançado** > **Acessar Painel Grupo Smart**: o app é seu.
6. Copie a URL que termina em `/exec` e salve nos favoritos do celular.

## Como reimplantar depois de uma mudança

Antes, suba `VERSAO_PAINEL` em `src/Lib.gs` e `version` no `package.json` (o teste confere que são iguais). A versão aparece no topo, ao lado de "Grupo Smart".

1. Atualize os arquivos do projeto (cole o conteúdo de `src/` no editor ou suba de novo pelo Drive).
2. **Implantar** > **Gerenciar implantações** > lápis na implantação ativa > **Versão: Nova versão** > **Implantar**.
3. A URL `/exec` continua a mesma.

## Como acrescentar um módulo

Módulos v3 (caminho genérico, desde a v3.0.0):

1. Em `Lib.gs`, chame `registrarModuloV3('<id>', {rotulo, agente, fontes, decisoes, montar})`: `fontes` diz os arquivos do ledger (`opcional: true` para os que podem faltar), `decisoes` define tipos, rótulos, campos (`texto`, `data`, `valor`) e o texto canônico do hash, e `montar(fontes, decisoes, agora)` devolve os itens da tela e `precisa` (o que conta no Início e no selo).
2. Em `CHAVES`, acrescente `<ID>_INTEGRADO: false`. Enquanto for `false`, os botões ficam desabilitados com o aviso "o agente ainda não lê estas decisões" e o servidor recusa gravar.
3. No `painel-fontes.json`, `"ativo": true`, `fontes.ledger.folderId` e, se quiser, `fontes.arquivos.<chave>` com o fileId (sem fileId, o painel procura pelo nome na pasta, com o cache da v2.0.1).
4. Crie `src/Mod<Nome>.html` com `PainelV3.registrar('<id>', {desenhar})` e inclua no fim de `Index.html`. A tela abre pelo menu **Mais**.
5. Fixtures anonimizadas em `test/fixtures/<id>/`, testes em `test/v3-<id>.test.js`, e o id na lista `V3` de `dev/build.js`.

As decisões vão para o mesmo `decisoes.csv`, com `snapshot_hash` por linha, recibos e recusa de versão velha; o agente do módulo filtra por `modulo`.

Planejado: **Finanças**, **Investimentos** e **Estudos**.

## Fuso horário

O Drive criou o projeto com o fuso da conta. O código não depende disso: `agoraSp_()` usa sempre o horário de São Paulo para comparar as datas dos CSVs.

## Problemas comuns

- **"Não achei o painel-fontes.json"**: o arquivo saiu da pasta ou foi renomeado. Volte o nome para `painel-fontes.json`; o painel o acha pelo nome.
- **Aviso vermelho numa fonte**: o CSV está ausente ou quebrado (aspas sem fechar, colunas faltando). O resto do painel funciona; corrija o arquivo e toque em **Atualizar agora**.
- **Miniatura não aparece**: o painel tenta de novo pelo servidor. Se ainda falhar, o cartão mostra "Prévia indisponível" e o link do Drive continua funcionando.
- **Dados desatualizados**: o cache dura 5 minutos. Use **Atualizar agora**.
- **Primeira carga lenta** (v2.0.1): o painel mostra na hora a última tela montada (até 6 h) com "lendo o Drive…" e busca a nova em segundo plano. O texto de cada arquivo fica em cache pela data de alteração (muda o arquivo, muda a chave) e o id das abas do ledger também. `decisoes.csv` é sempre lido direto do Drive.
- **Mudei o código e nada mudou**: falta criar uma nova versão da implantação (veja acima).

## Segurança

- Sem segredos no código: o painel usa a sua própria sessão Google.
- Só você acessa (`access: MYSELF`). Ninguém mais consegue abrir a URL.
- Texto vindo dos arquivos é sempre escapado antes de entrar na página.
- `salvarDecisao` valida módulo, item, estado, versão (hash) e decisão, exige comentário no pedido de ajuste e grava com trava.
