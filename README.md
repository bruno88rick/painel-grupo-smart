# Painel Grupo Smart

Painel visual, privado e mobile-first, para o Bruno ver e aprovar as artes e os posts criados pelos agentes do Grupo Smart (RN Sports, BD 3D, Smart Produtora, Include Systems). É a fonte única da verdade em cima dos arquivos que os agentes já mantêm no Google Drive: o painel lê esses arquivos e não copia nada para outro banco.

**Status:** v1 publicada em 11/11/2026 como Web App do Google Apps Script, acesso só do dono. Módulo ativo: **Design** (Agente de Design). Próximos módulos já têm lugar reservado.

![Início no celular](docs/screenshots/390-claro-inicio.jpg)

## Sumário

- [Telas](#telas)
- [Capturas](#capturas)
- [Arquitetura](#arquitetura)
- [Decisões e agentes](#decisões-e-agentes)
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
- **Posts:** linha do tempo por estado, com arte, legenda do `post-*.md`, contas e link publicado.
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

## Testes

```
npm test
```

21 testes: CSV com BOM, CRLF, aspas e quebra de linha; CSV quebrado; colunas ausentes; leitura dos CSVs reais; marcas `post:`; rascunho `post-*.md`; o modelo das telas; decisões, hash, versão velha, decisão repetida, estado inválido, recibos, cabeçalho antigo e a regra do relógio; e o `Code.gs` com os serviços do Google simulados (cache, fonte quebrada, gravação em `decisoes.csv`).

Para ver a página localmente com os dados das fixtures:

```
./dev/baixar-imagens.sh     # uma vez (precisa do gws)
npm run build:dev           # gera dev/out/index.html
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

1. Atualize os arquivos do projeto (cole o conteúdo de `src/` no editor ou suba de novo pelo Drive).
2. **Implantar** > **Gerenciar implantações** > lápis na implantação ativa > **Versão: Nova versão** > **Implantar**.
3. A URL `/exec` continua a mesma.

## Como acrescentar um módulo

1. No `painel-fontes.json`, mude o módulo para `"ativo": true` e preencha `fontes` com os fileIds e folderIds dele.
2. Em `Lib.gs`, crie `montarModulo<Nome>(fontes, decisoes, agora)` que devolve as listas da tela. Teste em `test/` com CSVs reais do agente.
3. Em `Code.gs`, leia as fontes do módulo em `montarDados_` (use `lerCsv_` e `lerAba_`, que nunca derrubam o painel) e devolva no modelo.
4. Em `Index.html`, acrescente o botão da aba e a `<section id="aba-<id>">`. Em `App.html`, a função `desenhar<Nome>()`.
5. Se o módulo tiver decisões, use `salvarDecisao({modulo:'<id>', ...})`: a linha vai para o mesmo `decisoes.csv`, e o agente do módulo filtra por `modulo`.

Planejado: **Posts e anúncios** (ledger do Gestor de Tráfego), **Finanças** (ledger do Assistente Financeiro), **Investimentos**, **Suporte RN Sports** (ledger do Suporte), **Estudos** e **E-mails** (só contagens e resumo, nunca o conteúdo dos e-mails).

## Fuso horário

O Drive criou o projeto com o fuso da conta. O código não depende disso: `agoraSp_()` usa sempre o horário de São Paulo para comparar as datas dos CSVs.

## Problemas comuns

- **"Não achei o painel-fontes.json"**: o arquivo saiu da pasta ou foi renomeado. Volte o nome para `painel-fontes.json`; o painel o acha pelo nome.
- **Aviso vermelho numa fonte**: o CSV está ausente ou quebrado (aspas sem fechar, colunas faltando). O resto do painel funciona; corrija o arquivo e toque em **Atualizar agora**.
- **Miniatura não aparece**: o painel tenta de novo pelo servidor. Se ainda falhar, o cartão mostra "Prévia indisponível" e o link do Drive continua funcionando.
- **Dados desatualizados**: o cache dura 5 minutos. Use **Atualizar agora**.
- **Mudei o código e nada mudou**: falta criar uma nova versão da implantação (veja acima).

## Segurança

- Sem segredos no código: o painel usa a sua própria sessão Google.
- Só você acessa (`access: MYSELF`). Ninguém mais consegue abrir a URL.
- Texto vindo dos arquivos é sempre escapado antes de entrar na página.
- `salvarDecisao` valida módulo, item, estado, versão (hash) e decisão, exige comentário no pedido de ajuste e grava com trava.
