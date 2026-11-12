/**
 * Code.gs: servidor do Painel Grupo Smart (Apps Script Web App).
 * Lê os arquivos que os agentes mantêm no Google Drive. Não copia dados para outro banco.
 * Única configuração: o arquivo painel-fontes.json no Drive (achado pelo nome).
 */

var CONFIG_NOME = 'painel-fontes.json';
var CACHE_PREFIXO = 'painel_v2_';
var CACHE_ARQUIVO_SEG = 6 * 60 * 60;   // texto por versão do arquivo (seguro: muda a chave quando o arquivo muda)
var CACHE_ULTIMO_SEG = 6 * 60 * 60;    // última tela montada, mostrada na hora enquanto a nova é lida

function doGet() {
  var t = HtmlService.createTemplateFromFile('Index');
  t.versao = PainelLib.VERSAO_PAINEL;
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
  var cfg = JSON.parse(textoDoArquivo_(arquivo));
  cfg._fileId = arquivo.getId();
  return cfg;
}

/* ---------- Leitura das fontes ---------- */

/**
 * Texto de um arquivo com cache por versão: a chave leva o fileId e a data da última alteração.
 * Arquivo alterado no Drive = chave nova, então o cache nunca devolve conteúdo velho.
 * Arquivos acima de 90 KB não entram no cache.
 */
function textoDoArquivo_(f, semCache, quando) {
  if (semCache) return f.getBlob().getDataAsString('UTF-8');
  var chave = chaveTexto_(f.getId(), quando || f.getLastUpdated());
  var c = null;
  try { c = CacheService.getScriptCache(); var hit = c.get(chave); if (hit !== null && hit !== undefined) return hit; } catch (e) { c = null; }
  var texto = f.getBlob().getDataAsString('UTF-8');
  if (c && texto.length < 90000) { try { c.put(chave, texto, CACHE_ARQUIVO_SEG); } catch (e) {} }
  return texto;
}

function chaveTexto_(id, quando) { return CACHE_PREFIXO + 'txt_' + id + '_' + quando.getTime(); }

/** Texto, data e nome com uma leitura de metadados só (getLastUpdated uma vez). Aceita fileId ou o File já achado. */
function lerArquivoTexto_(fileOuId, semCache) {
  var f = typeof fileOuId === 'string' ? DriveApp.getFileById(fileOuId) : fileOuId;
  var quando = f.getLastUpdated();
  return { texto: textoDoArquivo_(f, semCache, quando), atualizado: quando.toISOString(), nome: f.getName(), fileId: f.getId() };
}

/**
 * Vários arquivos de uma vez: um getAll no cache para todos, e o Drive só para os que faltam.
 * itens: [{ f, quando }]. Devolve os textos na mesma ordem.
 */
function textosDosArquivos_(itens) {
  var c = null, hits = {};
  var chaves = itens.map(function (x) { return chaveTexto_(x.id || x.f.getId(), x.quando); });
  try { c = CacheService.getScriptCache(); hits = chaves.length ? (c.getAll(chaves) || {}) : {}; } catch (e) { c = null; hits = {}; }
  var novos = {};
  var r = itens.map(function (x, i) {
    var h = hits[chaves[i]];
    if (h !== null && h !== undefined) return h;
    var t = x.f.getBlob().getDataAsString('UTF-8');
    if (t.length < 90000) novos[chaves[i]] = t;
    return t;
  });
  if (c && Object.keys(novos).length) { try { c.putAll(novos, CACHE_ARQUIVO_SEG); } catch (e) {} }
  return r;
}

/** Lê um CSV por fileId (ou File já achado). Nunca lança: devolve {ok, linhas, erro}. */
function lerCsv_(rotulo, fileId, obrigatorias, semCache) {
  var r = { rotulo: rotulo, fileId: typeof fileId === 'string' ? fileId : '', ok: false, linhas: [], erro: '', avisos: [], atualizado: '' };
  try {
    var a = lerArquivoTexto_(fileId, semCache);
    r.fileId = a.fileId;
    r.atualizado = a.atualizado; r.nome = a.nome;
    var o = PainelLib.csvParaObjetos(a.texto, obrigatorias);
    r.linhas = o.linhas; r.avisos = o.avisos; r.ok = true;
  } catch (e) {
    r.erro = String(e && e.message || e);
  }
  return r;
}

/**
 * Acha um arquivo pelo nome dentro de uma pasta e devolve o File (ou null).
 * O id fica no cache; o File conferido (nome e lixeira) é reaproveitado na leitura,
 * sem um segundo getFileById.
 */
function acharArquivoNaPasta_(folderId, nome) {
  var chave = CACHE_PREFIXO + 'id_' + folderId + '_' + nome;
  var c = null;
  try {
    c = CacheService.getScriptCache();
    var id = c.get(chave);
    if (id) {
      var f0 = DriveApp.getFileById(id);
      if (!f0.isTrashed() && f0.getName() === nome) return f0;
    }
  } catch (e) { /* cache velho ou arquivo sumiu: procura de novo */ }
  var it = DriveApp.getFolderById(folderId).getFilesByName(nome);
  while (it.hasNext()) {
    var f = it.next();
    if (!f.isTrashed()) { if (c) { try { c.put(chave, f.getId(), CACHE_ARQUIVO_SEG); } catch (e) {} } return f; }
  }
  return null;
}

/** Acha um arquivo pelo nome dentro de uma pasta: devolve o id (ou null). */
function acharNaPasta_(folderId, nome) {
  var f = acharArquivoNaPasta_(folderId, nome);
  return f ? f.getId() : null;
}

/** Lê uma aba do ledger (CSV pelo nome dentro da pasta). */
function lerAba_(rotulo, folderId, nome, obrigatorias) {
  try {
    var f = acharArquivoNaPasta_(folderId, nome);
    if (!f) return { rotulo: rotulo, ok: false, linhas: [], erro: nome + ' não está na pasta do ledger', avisos: [], atualizado: '' };
    return lerCsv_(rotulo, f, obrigatorias);
  } catch (e) {
    return { rotulo: rotulo, ok: false, linhas: [], erro: String(e && e.message || e), avisos: [], atualizado: '' };
  }
}

/** Lê os rascunhos post-*.md de uma pasta. */
function lerRascunhos_(rotulo, folderId, padrao) {
  return lerRascunhosVarios_(folderId, [{ rotulo: rotulo, padrao: padrao }])[0];
}

/**
 * Uma listagem da pasta para vários padrões (posts do Design, planos e posts do Tráfego na mesma pasta).
 * Metadados lidos uma vez por arquivo; textos pelo cache por versão num getAll só.
 */
function lerRascunhosVarios_(folderId, pedidos) {
  var rs = pedidos.map(function (p) { return { rotulo: p.rotulo, ok: false, itens: [], erro: '', atualizado: '', re: new RegExp(p.padrao || '^post-.+\\.md$'), max: 0 }; });
  try {
    var it = DriveApp.getFolderById(folderId).getFiles();
    var achados = [];
    while (it.hasNext()) {
      var f = it.next();
      var nome = f.getName();
      var quem = rs.filter(function (r) { return r.re.test(nome); });
      if (!quem.length || f.isTrashed()) continue;
      achados.push({ f: f, id: f.getId(), nome: nome, quando: f.getLastUpdated(), quem: quem });
    }
    var textos = textosDosArquivos_(achados);
    achados.forEach(function (a, i) {
      var t = a.quando.getTime();
      a.quem.forEach(function (r) {
        if (t > r.max) r.max = t;
        r.itens.push({ nome: a.nome, fileId: a.id, texto: textos[i], atualizado: a.quando.toISOString() });
      });
    });
    rs.forEach(function (r) { r.ok = true; r.atualizado = r.max ? new Date(r.max).toISOString() : ''; });
  } catch (e) {
    rs.forEach(function (r) { r.erro = String(e && e.message || e); });
  }
  return rs.map(function (r) { return { rotulo: r.rotulo, ok: r.ok, itens: r.itens, erro: r.erro, atualizado: r.atualizado }; });
}

function lerDecisoes_(cfg) {
  if (!cfg.decisoes || !cfg.decisoes.fileId) return { ok: false, linhas: [], erro: 'decisoes.csv não configurado', rotulo: 'Decisões do painel' };
  // decisoes.csv sempre direto do Drive: é a base da conferência antes de gravar.
  return lerCsv_('Decisões do painel', cfg.decisoes.fileId, PainelLib.CABECALHO_DECISOES, true);
}

/**
 * Lê os recibos imutáveis dos agentes: recibos/<decision_id>.json.
 * O agente cria um arquivo por decisão e nunca reescreve. O painel só lê.
 */
function lerRecibos_(cfg) {
  var r = { rotulo: 'Recibos dos agentes', ok: false, mapa: {}, erro: '', avisos: [], atualizado: '' };
  try {
    if (!cfg.decisoes || !cfg.decisoes.recibos_folderId) throw new Error('pasta recibos não configurada');
    var it = DriveApp.getFolderById(cfg.decisoes.recibos_folderId).getFiles();
    var maisRecente = 0, achados = [];
    while (it.hasNext()) {
      var f = it.next();
      var nome = f.getName();
      if (!/^D-[\w-]+\.json$/.test(nome) || f.isTrashed()) continue;
      achados.push({ f: f, id: f.getId(), nome: nome, quando: f.getLastUpdated() });
    }
    var textos = textosDosArquivos_(achados);
    achados.forEach(function (a, i) {
      try {
        var rec = PainelLib.parseRecibo(textos[i], a.nome);
        if (r.mapa[rec.decision_id]) { r.avisos.push('recibo duplicado: ' + a.nome); return; }
        r.mapa[rec.decision_id] = rec;
      } catch (e) {
        r.avisos.push(a.nome + ': ' + (e && e.message || e));
      }
      var t = a.quando.getTime();
      if (t > maisRecente) maisRecente = t;
    });
    r.ok = true;
    r.atualizado = maisRecente ? new Date(maisRecente).toISOString() : '';
  } catch (e) {
    r.erro = String(e && e.message || e);
  }
  return r;
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

/**
 * Lê as fontes do módulo Posts e anúncios (Gestor de Tráfego), se ativo.
 * Propostas.csv ausente não é erro: o painel mostra o aviso e segue com os rascunhos .md.
 */
function lerAnuncios_(cfg, rascDesign, planosLidos) {
  var mod = (cfg.modulos || []).filter(function (m) { return m.id === 'anuncios'; })[0];
  if (!mod || !mod.ativo || !mod.fontes || !mod.fontes.ledger || !mod.fontes.ledger.folderId) return null;
  var f = mod.fontes, pasta = f.ledger.folderId;
  var ab = f.ledger.abas || {};
  var nome = function (k, padrao) { return ab[k] || padrao; };
  var r = {
    anuncios: lerAba_('Anúncios (ledger do Tráfego)', pasta, nome('anuncios', 'Anuncios.csv'), ['id', 'estado']),
    campanhas: lerAba_('Campanhas (ledger do Tráfego)', pasta, nome('campanhas', 'Campanhas.csv'), ['id', 'estado']),
    resultados: lerAba_('Resultados (ledger do Tráfego)', pasta, nome('resultados', 'Resultados.csv'), ['data', 'campanha_id', 'gasto']),
    empresas: lerAba_('Empresas (ledger do Tráfego)', pasta, nome('empresas', 'Empresas.csv'), []),
    checkpoints: lerAba_('Checkpoints (ledger do Tráfego)', pasta, nome('checkpoints', 'Checkpoints.csv'), []),
    rules: lerAba_('Regras do Tráfego', pasta, nome('rules', 'Rules.csv'), [])
  };
  var nomeProp = nome('propostas', 'Propostas.csv');
  var idProp = null;
  try { idProp = acharNaPasta_(pasta, nomeProp); } catch (e) { idProp = null; }
  r.propostas = idProp ? lerCsv_('Propostas (Tráfego)', idProp, PainelLib.CABECALHO_PROPOSTAS)
    : { rotulo: 'Propostas (Tráfego)', ok: true, ausente: true, linhas: null, erro: '', avisos: [], atualizado: '' };
  var cri = f.criativos || {};
  var mesmaPasta = rascDesign && cri.folderId && rascDesign.folderId === cri.folderId;
  var planos = planosLidos && cri.folderId === planosLidos.folderId ? planosLidos.leitura : cri.folderId ? lerRascunhos_('Planos de campanha', cri.folderId, cri.padrao_planos || '^plano-.+\\.md$') : { rotulo: 'Planos de campanha', ok: false, itens: [], erro: 'pasta de criativos não configurada' };
  var posts = mesmaPasta ? rascDesign.leitura : (cri.folderId ? lerRascunhos_('Rascunhos de post (Tráfego)', cri.folderId, cri.padrao_posts || '^post-.+\\.md$') : { ok: true, itens: [] });
  var ok = function (x) { return x && x.ok && x.linhas ? x : null; };
  return {
    fontes: {
      anuncios: ok(r.anuncios), campanhas: ok(r.campanhas), resultados: ok(r.resultados), empresas: ok(r.empresas),
      checkpoints: ok(r.checkpoints), rules: ok(r.rules), propostas: r.propostas.ausente ? null : ok(r.propostas),
      rascunhos: posts.ok ? posts.itens : [], planos: planos.ok ? planos.itens : []
    },
    status: [r.anuncios, r.campanhas, r.resultados, r.empresas, r.checkpoints, r.rules, r.propostas, planos].concat(mesmaPasta ? [] : [posts])
  };
}

/**
 * Lê as fontes de um módulo v3 (Suporte, E-mails, Finanças, Investimentos, Estudos).
 * Quais arquivos: PainelLib.MODULOS_V3[id].fontes. Onde: painel-fontes.json, em
 * modulos[id].fontes.ledger.folderId (pelo nome do arquivo) ou modulos[id].fontes.arquivos[chave]
 * ("fileId" ou { fileId, nome, folderId }). Sempre pelo cache por versão (textoDoArquivo_, acharNaPasta_).
 * Arquivo opcional ausente não é erro: vira "ainda não criado".
 */
function lerModuloV3_(mod) {
  var def = PainelLib.MODULOS_V3[mod.id];
  var cfgF = mod.fontes || {};
  var pasta = cfgF.ledger && cfgF.ledger.folderId;
  var arqs = cfgF.arquivos || {};
  var fontes = {}, status = [];
  Object.keys(def.fontes).forEach(function (k) {
    var fd = def.fontes[k];
    var c = arqs[k];
    if (typeof c === 'string') c = { fileId: c };
    c = c || {};
    var nome = c.nome || fd.arquivo;
    var r;
    if (c.fileId) {
      r = lerCsv_(fd.rotulo, c.fileId, fd.obrigatorias || []);
    } else {
      var dir = c.folderId || pasta;
      var id = null;
      try { id = dir ? acharArquivoNaPasta_(dir, nome) : null; } catch (e) { id = null; }
      if (!id) r = fd.opcional ? { rotulo: fd.rotulo, ok: true, ausente: true, linhas: null, erro: '', avisos: [], atualizado: '' }
        : { rotulo: fd.rotulo, ok: false, linhas: [], erro: dir ? nome + ' não está na pasta do ledger' : 'pasta do ledger não configurada', avisos: [], atualizado: '' };
      else r = lerCsv_(fd.rotulo, id, fd.obrigatorias || []);
    }
    fontes[k] = r.ok && r.linhas ? r : null;
    status.push(r);
  });
  return { fontes: fontes, status: status };
}

/** Primeira subpasta com o nome, dentro de uma pasta (ou null). */
function acharSubpasta_(folderId, nome) {
  var it = DriveApp.getFolderById(folderId).getFoldersByName(nome);
  while (it.hasNext()) { var p = it.next(); if (!p.isTrashed || !p.isTrashed()) return p.getId(); }
  return null;
}

/**
 * Estudos: caminho relativo à pasta de materiais ("pasta/arquivo.md" ou só "arquivo.md") -> fileId.
 * Só arquivo solto: procura na raiz e, se não achar, nas subpastas de primeiro nível. Só leitura.
 * Cache curto por caminho (o "não achou" também, para não varrer o Drive a cada carga).
 */
function resolverCaminhos_(raizId, caminhos) {
  var r = {}, c = null;
  try { c = CacheService.getScriptCache(); } catch (e) { c = null; }
  caminhos.slice(0, 60).forEach(function (cam) {
    var chave = CACHE_PREFIXO + 'cam_' + raizId + '_' + cam;
    var v = null;
    try { v = c ? c.get(chave) : null; } catch (e) { v = null; }
    if (v === null) {
      var id = null;
      try {
        var partes = cam.split('/').filter(function (x) { return x; });
        var pasta = raizId;
        for (var i = 0; i < partes.length - 1 && pasta; i++) pasta = acharSubpasta_(pasta, partes[i]);
        if (pasta) id = acharNaPasta_(pasta, partes[partes.length - 1]);
        if (!id && partes.length === 1) {
          var it = DriveApp.getFolderById(raizId).getFolders();
          while (!id && it.hasNext()) { var sub = it.next(); id = acharNaPasta_(sub.getId(), partes[0]); }
        }
      } catch (e) { id = null; }
      v = id || '-';
      try { if (c) c.put(chave, v, id ? 3600 : 600); } catch (e) {}
    }
    if (v && v !== '-') r[cam] = v;
  });
  return r;
}

function lerModulosV3_(cfg) {
  var fontes = {}, status = [];
  (cfg.modulos || []).forEach(function (m) {
    if (!m.ativo || !PainelLib.MODULOS_V3[m.id]) return;
    var r = lerModuloV3_(m);
    fontes[m.id] = r.fontes;
    status = status.concat(r.status);
  });
  return { fontes: fontes, status: status };
}

/** Módulo do painel-fontes.json pelo id (ou undefined). */
function moduloCfg_(cfg, id) { return (cfg.modulos || []).filter(function (m) { return m.id === id; })[0]; }

/** Ids dos módulos v3 ativos, na ordem do painel-fontes.json. */
function idsV3Ativos_(cfg) {
  return (cfg.modulos || []).filter(function (m) { return m.ativo && PainelLib.MODULOS_V3[m.id]; }).map(function (m) { return m.id; });
}

function statusFonte_(s) {
  return { rotulo: s.rotulo, ok: s.ok, ausente: !!s.ausente, erro: s.erro || '', avisos: (s.avisos || []).slice(0, 3), atualizado: s.atualizado || '' };
}

/**
 * Início (v3.0.1): só Design e Posts e anúncios, mais decisões e recibos.
 * Os módulos v3 não são lidos aqui; a tela pede cada um com obterModulo(id).
 * A pasta de criativos é listada uma vez para os posts do Design e os planos do Tráfego.
 */
function montarInicio_(cfgPronta, lidos_) {
  var cfg = cfgPronta || lerConfig_();
  var mod = moduloCfg_(cfg, 'design');
  if (!mod) throw new Error('O módulo "design" não está no ' + CONFIG_NOME + '.');
  var f = mod.fontes;
  var pedidos = lerCsv_(f.pedidos.rotulo, f.pedidos.fileId, ['id', 'estado']);
  var produtos = lerCsv_(f.produtos.rotulo, f.produtos.fileId, []);
  var ab = f.ledger.abas;
  var artes = lerAba_('Artes (ledger do Design)', f.ledger.folderId, ab.artes, ['id', 'arte_fileId']);
  var posts = lerAba_('Posts (ledger do Design)', f.ledger.folderId, ab.posts, []);
  var midia = lerAba_('Mídia (ledger do Design)', f.ledger.folderId, ab.midia, ['fileId']);
  var checkpoints = lerAba_('Checkpoints (ledger do Design)', f.ledger.folderId, ab.checkpoints, []);
  var an0 = moduloCfg_(cfg, 'anuncios');
  var cri = an0 && an0.ativo && an0.fontes && an0.fontes.criativos;
  var juntos = cri && cri.folderId === f.criativos.folderId;
  var lidos = lerRascunhosVarios_(f.criativos.folderId, [{ rotulo: f.criativos.rotulo, padrao: f.criativos.padrao }]
    .concat(juntos ? [{ rotulo: 'Planos de campanha', padrao: cri.padrao_planos || '^plano-.+\\.md$' }] : []));
  var rasc = lidos[0];
  var decisoes = lerDecisoes_(cfg);
  var recibos = lerRecibos_(cfg);
  var an = lerAnuncios_(cfg, { folderId: f.criativos.folderId, leitura: rasc }, juntos ? { folderId: cri.folderId, leitura: lidos[1] } : null);

  if (lidos_) { lidos_.decisoes = decisoes; lidos_.recibos = recibos; }
  var agora = agoraSp_();
  var modelo = PainelLib.montarModelo(
    { pedidos: pedidos.ok ? pedidos : null, artes: artes.ok ? artes : null, posts: posts.ok ? posts : null, midia: midia.ok ? midia : null, produtos: produtos.ok ? produtos : null, rascunhos: rasc.ok ? rasc.itens : [] },
    decisoes.ok ? decisoes.linhas : [],
    agora,
    { dias_refazer_parado: cfg.dias_refazer_parado || 2, recibos: recibos.ok ? recibos.mapa : {}, anuncios: an ? an.fontes : null }
  );
  modelo.v3 = {};
  modelo.v3_ids = idsV3Ativos_(cfg);
  modelo.gerado_em = new Date().toISOString();
  modelo.decisoes_ok = decisoes.ok && recibos.ok;
  modelo.fontes = [pedidos, artes, posts, midia, produtos, checkpoints, rasc, decisoes, recibos].concat(an ? an.status : []).map(statusFonte_);
  modelo.checkpoints = checkpoints.ok ? checkpoints.linhas : [];
  modelo.modulos = (cfg.modulos || []).map(function (m) { return { id: m.id, rotulo: m.rotulo, ativo: !!m.ativo, agente: m.agente || '' }; });
  modelo.links = { artes_pasta: f.artes_pasta ? f.artes_pasta.folderId : '', criativos: f.criativos.folderId, ledger: f.ledger.folderId };
  return modelo;
}

/**
 * Um módulo v3 sozinho: as fontes dele, e decisões e recibos só se o módulo tiver decisões
 * e houver linha dele em decisoes.csv. decisoes.csv aqui vem pelo cache por versão
 * (a chave muda quando o arquivo muda); a conferência antes de gravar continua lendo direto do Drive.
 * Devolve { id, modulo, fontes, gerado_em }.
 */
function montarModuloV3Unico_(cfg, id) {
  var m = moduloCfg_(cfg, id), def = PainelLib.MODULOS_V3[id];
  if (!m || !m.ativo || !def) throw new Error('O módulo "' + id + '" não está ativo no ' + CONFIG_NOME + '.');
  var lido = lerModuloV3_(m);
  var status = lido.status.slice();
  var linhas = [], mapa = {};
  if (def.decisoes && cfg.decisoes && cfg.decisoes.fileId) {
    var dec = lerCsv_('Decisões do painel', cfg.decisoes.fileId, PainelLib.CABECALHO_DECISOES);
    if (dec.ok) {
      linhas = dec.linhas.filter(function (x) { return x.modulo === id; });
      if (linhas.length) { var rec = lerRecibos_(cfg); if (rec.ok) mapa = rec.mapa; else status.push(rec); }
    } else status.push(dec);
  }
  var fontes = {}; fontes[id] = lido.fontes;
  var x = PainelLib.montarModulosV3(fontes, PainelLib.decisoesComRecibos(linhas, mapa), agoraSp_())[id];
  x.pastas = { ledger: (m.fontes && m.fontes.ledger && m.fontes.ledger.folderId) || '', materiais: (m.fontes && m.fontes.materiais && m.fontes.materiais.folderId) || '' };
  if (id === 'estudos' && x.pastas.materiais) x.links = resolverCaminhos_(x.pastas.materiais, x.caminhos || []);
  return { id: id, modulo: x, fontes: status.map(statusFonte_), gerado_em: new Date().toISOString() };
}

/**
 * Tudo junto (Início e todos os módulos v3), como na v3.0.0. Usado pela conferência
 * antes de gravar uma decisão (salvarDecisao) e por obterDados, mantido por compatibilidade.
 */
function montarDados_(cfgPronta) {
  var cfg = cfgPronta || lerConfig_();
  var lidos = {};
  var modelo = montarInicio_(cfg, lidos);
  var v3 = lerModulosV3_(cfg);
  var dec = lidos.decisoes, rec = lidos.recibos;
  modelo.v3 = PainelLib.montarModulosV3(v3.fontes, PainelLib.decisoesComRecibos(dec.ok ? dec.linhas : [], rec.ok ? rec.mapa : {}), agoraSp_());
  (cfg.modulos || []).forEach(function (m) {
    var x = modelo.v3[m.id];
    if (x) x.pastas = { ledger: (m.fontes && m.fontes.ledger && m.fontes.ledger.folderId) || '', materiais: (m.fontes && m.fontes.materiais && m.fontes.materiais.folderId) || '' };
  });
  if (modelo.v3.estudos && modelo.v3.estudos.pastas.materiais) {
    modelo.v3.estudos.links = resolverCaminhos_(modelo.v3.estudos.pastas.materiais, modelo.v3.estudos.caminhos || []);
  }
  modelo.fontes = modelo.fontes.concat(v3.status.map(statusFonte_));
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

/**
 * Cache em duas camadas, igual para o Início e para cada módulo:
 * 1. montado há menos de cache_minutos (5): devolve do cache;
 * 2. senão, a cópia "_ult" (até 6 h): devolve na hora com desatualizado=true, e a tela pede a nova em segundo plano;
 * 3. sem nada: monta lendo o Drive (os textos continuam no cache por versão de cada arquivo).
 */
function doCache_(chave, forcar, montar) {
  if (!forcar) {
    var s = cacheGet_(chave);
    if (s) { var o = JSON.parse(s); o.do_cache = true; o.desatualizado = false; return o; }
    var u = cacheGet_(chave + '_ult');
    if (u) { var v = JSON.parse(u); v.do_cache = true; v.desatualizado = true; return v; }
  }
  var cfg = lerConfig_();
  var dados = montar(cfg);
  var txt = JSON.stringify(dados);
  cachePut_(chave, txt, (cfg.cache_minutos || 5) * 60);
  cachePut_(chave + '_ult', txt, CACHE_ULTIMO_SEG);
  dados.do_cache = false;
  dados.desatualizado = false;
  return dados;
}

/** Chamado pela tela primeiro: só o Início (Design e Posts e anúncios). forcar = "Atualizar agora". */
function obterInicio(forcar) {
  return doCache_(CACHE_PREFIXO + 'inicio', forcar, function (cfg) { return montarInicio_(cfg); });
}

/** Chamado pela tela, um por módulo v3 e em paralelo, depois do Início. Cache próprio por módulo. */
function obterModulo(id, forcar) {
  id = String(id || '');
  if (!PainelLib.MODULOS_V3[id]) throw new Error('módulo desconhecido: ' + id);
  return doCache_(CACHE_PREFIXO + 'mod_' + id, forcar, function (cfg) { return montarModuloV3Unico_(cfg, id); });
}

/** v3.0.0: tudo numa chamada só. Mantido por compatibilidade; a tela da v3.0.1 usa obterInicio e obterModulo. */
function obterDados(forcar) {
  return doCache_(CACHE_PREFIXO + 'dados', forcar, function (cfg) { return montarDados_(cfg); });
}

/** Depois de gravar: a próxima carga do Início e do módulo lê o Drive de novo. */
function limparCachesTela_(modulo) {
  ['dados', 'inicio'].concat(PainelLib.MODULOS_V3[modulo] ? ['mod_' + modulo] : []).forEach(function (k) {
    cacheLimpar_(CACHE_PREFIXO + k);
    cacheLimpar_(CACHE_PREFIXO + k + '_ult');
  });
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

/**
 * Grava a decisão do Bruno ligada à versão exata que estava na tela.
 * 1. Valida o formato (inclui snapshot_hash).
 * 2. Relê o Drive sem cache e confere item, estado e snapshot_hash (rejeita versão obsoleta).
 * 3. Acrescenta uma linha. Só este app escreve em decisoes.csv; os agentes respondem com recibos.
 */
function salvarDecisao(entrada) {
  var d = PainelLib.validarDecisao(entrada);
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new Error('outra decisão está sendo gravada; tente de novo');
  try {
    var cfg = lerConfig_();
    if (!cfg.decisoes || !cfg.decisoes.fileId) throw new Error('decisoes.csv não configurado no ' + CONFIG_NOME);
    var modelo = montarDados_(cfg);
    if (!modelo.decisoes_ok) throw new Error('não consegui ler decisoes.csv ou os recibos; nada foi gravado');
    var vinculo = PainelLib.conferirDecisao(modelo, d);

    var arq = DriveApp.getFileById(cfg.decisoes.fileId);
    var texto = arq.getBlob().getDataAsString('UTF-8');
    var cab = PainelLib.CABECALHO_DECISOES.join(',');
    if (!texto.trim()) texto = cab + '\n';
    if (texto.replace(/^\ufeff/, '').split(/\r?\n/)[0].trim() !== cab) throw new Error('cabeçalho de decisoes.csv diferente do contrato; nada foi gravado');
    var antes = PainelLib.csvParaObjetos(texto, PainelLib.CABECALHO_DECISOES).linhas.length;
    if (!/\n$/.test(texto)) texto += '\n';
    var agora = new Date();
    var id = 'D-' + Utilities.formatDate(agora, 'America/Sao_Paulo', 'yyyyMMdd-HHmmss') + '-' + Utilities.getUuid().slice(0, 8);
    var quando = Utilities.formatDate(agora, 'America/Sao_Paulo', "yyyy-MM-dd'T'HH:mm:ssXXX");
    texto += PainelLib.csvLinha([id, quando, d.modulo, d.item_id, vinculo.tipo_item, vinculo.versao, vinculo.arte_fileId, vinculo.snapshot_hash, d.decisao, d.comentario, 'painel']) + '\n';
    if (PainelLib.csvParaObjetos(texto, PainelLib.CABECALHO_DECISOES).linhas.length !== antes + 1) throw new Error('falha ao montar a nova linha; nada foi gravado');
    arq.setContent(texto);
    limparCachesTela_(d.modulo);
    return { ok: true, id: id, quando: quando, versao: vinculo.versao, snapshot_hash: vinculo.snapshot_hash };
  } finally {
    lock.releaseLock();
  }
}
