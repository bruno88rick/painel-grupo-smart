/**
 * Code.gs: servidor do Painel Grupo Smart (Apps Script Web App).
 * Lê os arquivos que os agentes mantêm no Google Drive. Não copia dados para outro banco.
 * Única configuração: o arquivo painel-fontes.json no Drive (achado pelo nome).
 */

var CONFIG_NOME = 'painel-fontes.json';
var CACHE_PREFIXO = 'painel_v1_';

function doGet() {
  var t = HtmlService.createTemplateFromFile('Index');
  return t.evaluate()
    .setTitle('Painel Grupo Smart')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setFaviconUrl('https://www.gstatic.com/images/branding/product/1x/drive_2020q4_48dp.png');
}

function include(nome) {
  return HtmlService.createHtmlOutputFromFile(nome).getContent();
}

/* ---------- Configuração ---------- */

function lerConfig_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('CONFIG_FILE_ID');
  var arquivo = null;
  if (id) {
    try { arquivo = DriveApp.getFileById(id); if (arquivo.isTrashed()) arquivo = null; } catch (e) { arquivo = null; }
  }
  if (!arquivo) {
    var it = DriveApp.getFilesByName(CONFIG_NOME);
    while (it.hasNext()) { var f = it.next(); if (!f.isTrashed()) { arquivo = f; break; } }
    if (!arquivo) throw new Error('Não achei o ' + CONFIG_NOME + ' no seu Drive.');
    props.setProperty('CONFIG_FILE_ID', arquivo.getId());
  }
  var cfg = JSON.parse(arquivo.getBlob().getDataAsString('UTF-8'));
  cfg._fileId = arquivo.getId();
  return cfg;
}

/* ---------- Leitura das fontes ---------- */

function lerArquivoTexto_(fileId) {
  var f = DriveApp.getFileById(fileId);
  return { texto: f.getBlob().getDataAsString('UTF-8'), atualizado: f.getLastUpdated().toISOString(), nome: f.getName(), fileId: fileId };
}

/** Lê um CSV por fileId. Nunca lança: devolve {ok, linhas, erro}. */
function lerCsv_(rotulo, fileId, obrigatorias) {
  var r = { rotulo: rotulo, fileId: fileId, ok: false, linhas: [], erro: '', avisos: [], atualizado: '' };
  try {
    var a = lerArquivoTexto_(fileId);
    r.atualizado = a.atualizado; r.nome = a.nome;
    var o = PainelLib.csvParaObjetos(a.texto, obrigatorias);
    r.linhas = o.linhas; r.avisos = o.avisos; r.ok = true;
  } catch (e) {
    r.erro = String(e && e.message || e);
  }
  return r;
}

/** Acha um arquivo pelo nome dentro de uma pasta. */
function acharNaPasta_(folderId, nome) {
  var it = DriveApp.getFolderById(folderId).getFilesByName(nome);
  while (it.hasNext()) { var f = it.next(); if (!f.isTrashed()) return f.getId(); }
  return null;
}

/** Lê uma aba do ledger (CSV pelo nome dentro da pasta). */
function lerAba_(rotulo, folderId, nome, obrigatorias) {
  try {
    var id = acharNaPasta_(folderId, nome);
    if (!id) return { rotulo: rotulo, ok: false, linhas: [], erro: nome + ' não está na pasta do ledger', avisos: [], atualizado: '' };
    return lerCsv_(rotulo, id, obrigatorias);
  } catch (e) {
    return { rotulo: rotulo, ok: false, linhas: [], erro: String(e && e.message || e), avisos: [], atualizado: '' };
  }
}

/** Lê os rascunhos post-*.md de uma pasta. */
function lerRascunhos_(rotulo, folderId, padrao) {
  var r = { rotulo: rotulo, ok: false, itens: [], erro: '', atualizado: '' };
  try {
    var re = new RegExp(padrao || '^post-.+\\.md$');
    var it = DriveApp.getFolderById(folderId).getFiles();
    var maisRecente = 0;
    while (it.hasNext()) {
      var f = it.next();
      if (f.isTrashed() || !re.test(f.getName())) continue;
      var t = f.getLastUpdated().getTime();
      if (t > maisRecente) maisRecente = t;
      r.itens.push({ nome: f.getName(), fileId: f.getId(), texto: f.getBlob().getDataAsString('UTF-8'), atualizado: f.getLastUpdated().toISOString() });
    }
    r.ok = true;
    r.atualizado = maisRecente ? new Date(maisRecente).toISOString() : '';
  } catch (e) {
    r.erro = String(e && e.message || e);
  }
  return r;
}

function lerDecisoes_(cfg) {
  if (!cfg.decisoes || !cfg.decisoes.fileId) return { ok: false, linhas: [], erro: 'decisoes.csv não configurado', rotulo: 'Decisões' };
  return lerCsv_('Decisões do painel', cfg.decisoes.fileId, ['id', 'item_id', 'decisao']);
}

/**
 * Hora de São Paulo como data "local" do script. Assim as datas dos CSVs
 * (horário de Brasília) são comparadas certo, seja qual for o fuso do projeto.
 */
function agoraSp_() {
  var s = Utilities.formatDate(new Date(), 'America/Sao_Paulo', 'yyyy-MM-dd HH:mm:ss');
  var m = s.match(/(\d+)-(\d+)-(\d+) (\d+):(\d+):(\d+)/);
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

/** Monta tudo o que a tela precisa. */
function montarDados_() {
  var cfg = lerConfig_();
  var mod = (cfg.modulos || []).filter(function (m) { return m.id === 'design'; })[0];
  if (!mod) throw new Error('O módulo "design" não está no ' + CONFIG_NOME + '.');
  var f = mod.fontes;
  var pedidos = lerCsv_(f.pedidos.rotulo, f.pedidos.fileId, ['id', 'estado']);
  var produtos = lerCsv_(f.produtos.rotulo, f.produtos.fileId, []);
  var ab = f.ledger.abas;
  var artes = lerAba_('Artes (ledger do Design)', f.ledger.folderId, ab.artes, ['id', 'arte_fileId']);
  var posts = lerAba_('Posts (ledger do Design)', f.ledger.folderId, ab.posts, []);
  var midia = lerAba_('Mídia (ledger do Design)', f.ledger.folderId, ab.midia, ['fileId']);
  var checkpoints = lerAba_('Checkpoints (ledger do Design)', f.ledger.folderId, ab.checkpoints, []);
  var rasc = lerRascunhos_(f.criativos.rotulo, f.criativos.folderId, f.criativos.padrao);
  var decisoes = lerDecisoes_(cfg);

  var modelo = PainelLib.montarModelo(
    { pedidos: pedidos.ok ? pedidos : null, artes: artes.ok ? artes : null, posts: posts.ok ? posts : null, midia: midia.ok ? midia : null, produtos: produtos.ok ? produtos : null, rascunhos: rasc.ok ? rasc.itens : [] },
    decisoes.ok ? decisoes.linhas : [],
    agoraSp_(),
    { dias_refazer_parado: cfg.dias_refazer_parado || 2 }
  );

  modelo.gerado_em = new Date().toISOString();
  modelo.fontes = [pedidos, artes, posts, midia, produtos, checkpoints, rasc, decisoes].map(function (s) {
    return { rotulo: s.rotulo, ok: s.ok, erro: s.erro || '', avisos: (s.avisos || []).slice(0, 3), atualizado: s.atualizado || '' };
  });
  modelo.checkpoints = checkpoints.ok ? checkpoints.linhas : [];
  modelo.modulos = (cfg.modulos || []).map(function (m) { return { id: m.id, rotulo: m.rotulo, ativo: !!m.ativo, agente: m.agente || '' }; });
  modelo.links = { artes_pasta: f.artes_pasta ? f.artes_pasta.folderId : '', criativos: f.criativos.folderId, ledger: f.ledger.folderId };
  return modelo;
}

/* ---------- Cache (5 minutos, em pedaços de 90 KB) ---------- */

function cacheGet_(chave) {
  var c = CacheService.getUserCache();
  var n = c.get(chave + '_n');
  if (!n) return null;
  var chaves = [];
  for (var i = 0; i < +n; i++) chaves.push(chave + '_' + i);
  var partes = c.getAll(chaves);
  var s = '';
  for (var j = 0; j < chaves.length; j++) { if (partes[chaves[j]] === undefined) return null; s += partes[chaves[j]]; }
  return s;
}

function cachePut_(chave, texto, segundos) {
  var c = CacheService.getUserCache();
  var tam = 90000;
  var obj = {};
  var n = Math.ceil(texto.length / tam);
  for (var i = 0; i < n; i++) obj[chave + '_' + i] = texto.substr(i * tam, tam);
  obj[chave + '_n'] = String(n);
  try { c.putAll(obj, segundos); } catch (e) { /* cache é só otimização */ }
}

function cacheLimpar_(chave) {
  try { CacheService.getUserCache().remove(chave + '_n'); } catch (e) {}
}

/** Chamado pela tela. forcar = botão "Atualizar agora". */
function obterDados(forcar) {
  var chave = CACHE_PREFIXO + 'dados';
  if (!forcar) {
    var s = cacheGet_(chave);
    if (s) { var o = JSON.parse(s); o.do_cache = true; return o; }
  }
  var cfg = lerConfig_();
  var dados = montarDados_();
  var txt = JSON.stringify(dados);
  cachePut_(chave, txt, (cfg.cache_minutos || 5) * 60);
  dados.do_cache = false;
  return dados;
}

/* ---------- Miniaturas (plano B quando a URL do Drive não carrega) ---------- */

function obterMiniatura(fileId) {
  if (!/^[\w-]{10,80}$/.test(String(fileId))) throw new Error('id inválido');
  var chave = CACHE_PREFIXO + 'thumb_' + fileId;
  var c = CacheService.getUserCache();
  var hit = c.get(chave);
  if (hit) return hit;
  var blob = DriveApp.getFileById(fileId).getThumbnail();
  if (!blob) return '';
  var url = 'data:' + (blob.getContentType() || 'image/png') + ';base64,' + Utilities.base64Encode(blob.getBytes());
  if (url.length < 99000) { try { c.put(chave, url, 6 * 60 * 60); } catch (e) {} }
  return url;
}

/* ---------- Decisões: só acrescenta linha em decisoes.csv ---------- */

function salvarDecisao(entrada) {
  var d = PainelLib.validarDecisao(entrada);
  var cfg = lerConfig_();
  if (!cfg.decisoes || !cfg.decisoes.fileId) throw new Error('decisoes.csv não configurado no ' + CONFIG_NOME);
  var lock = LockService.getUserLock();
  lock.waitLock(20000);
  try {
    var arq = DriveApp.getFileById(cfg.decisoes.fileId);
    var texto = arq.getBlob().getDataAsString('UTF-8');
    var cab = 'id,quando,modulo,item_id,decisao,comentario,origem,processado_em';
    if (!texto.trim()) texto = cab + '\n';
    if (!/\n$/.test(texto)) texto += '\n';
    var agora = new Date();
    var id = 'D-' + Utilities.formatDate(agora, 'America/Sao_Paulo', 'yyyyMMdd-HHmmss') + '-' + Math.floor(Math.random() * 900 + 100);
    var quando = Utilities.formatDate(agora, 'America/Sao_Paulo', "yyyy-MM-dd'T'HH:mm:ssXXX");
    texto += PainelLib.csvLinha([id, quando, d.modulo, d.item_id, d.decisao, d.comentario, 'painel', '']) + '\n';
    arq.setContent(texto);
    cacheLimpar_(CACHE_PREFIXO + 'dados');
    return { ok: true, id: id, quando: quando };
  } finally {
    lock.releaseLock();
  }
}
