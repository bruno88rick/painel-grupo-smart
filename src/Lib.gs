/**
 * Lib.gs: funções puras do Painel Grupo Smart.
 * Não usam nenhum serviço do Google, então rodam no Apps Script e no Node (testes).
 */

var PainelLib = (function () {
  var DIA_MS = 24 * 60 * 60 * 1000;

  /** CSV RFC 4180: aspas, vírgulas e quebras de linha dentro de campos, CRLF e BOM. */
  function parseCsv(texto) {
    if (texto === null || texto === undefined) throw new Error('arquivo vazio');
    var s = String(texto);
    if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
    var linhas = [];
    var linha = [];
    var campo = '';
    var emAspas = false;
    var i = 0;
    while (i < s.length) {
      var c = s[i];
      if (emAspas) {
        if (c === '"') {
          if (s[i + 1] === '"') { campo += '"'; i += 2; continue; }
          emAspas = false; i++; continue;
        }
        if (c === '\r' && s[i + 1] === '\n') { i++; continue; }
        campo += c; i++; continue;
      }
      if (c === '"') {
        if (campo.length > 0) throw new Error('aspas no meio do campo, linha ' + (linhas.length + 1));
        emAspas = true; i++; continue;
      }
      if (c === ',') { linha.push(campo); campo = ''; i++; continue; }
      if (c === '\r') { i++; continue; }
      if (c === '\n') { linha.push(campo); linhas.push(linha); linha = []; campo = ''; i++; continue; }
      campo += c; i++;
    }
    if (emAspas) throw new Error('aspas sem fechar no fim do arquivo');
    if (campo.length > 0 || linha.length > 0) { linha.push(campo); linhas.push(linha); }
    return linhas.filter(function (l) { return !(l.length === 1 && l[0].trim() === ''); });
  }

  /** Converte linhas em objetos pelo cabeçalho. Retorna {cabecalho, linhas, avisos}. */
  function csvParaObjetos(texto, colunasObrigatorias) {
    var linhas = parseCsv(texto);
    if (!linhas.length) throw new Error('sem cabeçalho');
    var cab = linhas[0].map(function (h) { return String(h).trim(); });
    var faltam = (colunasObrigatorias || []).filter(function (c) { return cab.indexOf(c) < 0; });
    if (faltam.length) throw new Error('faltam colunas: ' + faltam.join(', '));
    var avisos = [];
    var objs = [];
    for (var r = 1; r < linhas.length; r++) {
      var l = linhas[r];
      if (l.length !== cab.length) avisos.push('linha ' + (r + 1) + ' tem ' + l.length + ' campos, esperado ' + cab.length);
      var o = {};
      for (var k = 0; k < cab.length; k++) o[cab[k]] = (l[k] === undefined ? '' : String(l[k]).trim());
      objs.push(o);
    }
    return { cabecalho: cab, linhas: objs, avisos: avisos };
  }

  /** Escapa um valor para CSV. */
  function csvCampo(v) {
    var s = v === null || v === undefined ? '' : String(v);
    if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }
  function csvLinha(valores) { return valores.map(csvCampo).join(','); }

  /** Lê datas "2026-11-09", "2026-11-11 18:30", "11/11/2026", "14/11 19:00". */
  function parseData(txt, ano) {
    if (!txt) return null;
    var s = String(txt).trim();
    var m = s.match(/(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0);
    m = s.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?(?:[^\d]+(\d{1,2})[:h](\d{2}))?/);
    if (m) return new Date(m[3] ? +m[3] : (ano || new Date().getFullYear()), +m[2] - 1, +m[1], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0);
    return null;
  }

  function dataIso(d) {
    if (!d) return '';
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ((d.getHours() || d.getMinutes()) ? ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) : '');
  }

  /**
   * Lê as marcas "post:" do campo obs.
   * post:<link> <data>        -> publicado
   * post:programado <data>    -> programado
   * post:manual               -> manual
   * post:story <link> <data>  -> publicado (story)
   */
  function parsePostObs(obs) {
    var res = [];
    if (!obs) return res;
    var partes = String(obs).split(/(?=post:)/);
    partes.forEach(function (p) {
      if (p.indexOf('post:') !== 0) return;
      var corpo = p.slice(5).split('|')[0].replace(/;\s*$/, '').trim();
      var link = (corpo.match(/https?:\/\/\S+/) || [null])[0];
      var resto = corpo.replace(link || '', '').trim();
      if (/^manual\b/i.test(corpo)) { res.push({ tipo: 'manual', link: null, quando: null, texto: corpo }); return; }
      if (/^programado\b/i.test(corpo)) {
        var t = resto.replace(/^programado\s*/i, '');
        var dm = t.match(/(\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2})?|\d{1,2}\/\d{1,2}(?:\/\d{4})?(?:\s+\d{1,2}:\d{2})?)/);
        res.push({ tipo: 'programado', link: link, quando: dm ? dm[1] : null, formato: t.replace(dm ? dm[1] : '', '').trim() || null, texto: corpo });
        return;
      }
      if (link) {
        var d = resto.match(/(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}(?:\/\d{4})?)/);
        var formato = resto.replace(d ? d[1] : '', '').trim() || null;
        res.push({ tipo: 'publicado', link: link, quando: d ? d[1] : null, formato: formato, texto: corpo });
      }
    });
    return res;
  }

  /** Lê um rascunho post-<pedido_id>.md. */
  function parsePostMd(texto, nomeArquivo) {
    var s = String(texto || '').replace(/\r/g, '');
    var linhas = s.split('\n');
    var r = { pedido_id: null, titulo: '', empresa: '', estado_texto: '', aprovado: false, contas: '', horario: '', legenda: '', hashtags: '', formato: '' };
    var m = (nomeArquivo || '').match(/^post-(.+)\.md$/);
    if (m) r.pedido_id = m[1];
    var t = s.match(/^#\s*Post:\s*([^\s(]+)\s*(?:\(([^,]+),\s*([^)]+)\))?/m);
    if (t) { r.pedido_id = r.pedido_id || t[1]; r.empresa = (t[2] || '').trim(); r.titulo = (t[3] || '').trim(); }
    linhas.forEach(function (l) {
      var x;
      if ((x = l.match(/^Estado:\s*(.+)$/i))) r.estado_texto = x[1].trim();
      if ((x = l.match(/^-\s*Contas de destino[^:]*:\s*(.+)$/i))) r.contas = x[1].trim();
      if ((x = l.match(/^-\s*Hor[aá]rio[^:]*:\s*(.+)$/i))) r.horario = x[1].trim();
      if ((x = l.match(/^-\s*Formato[^:]*:\s*(.+)$/i))) r.formato = x[1].trim();
    });
    r.aprovado = /\baprovad[oa]\b/i.test(r.estado_texto);
    // seções "## ..."
    var secoes = [];
    var atual = null;
    linhas.forEach(function (l) {
      var h = l.match(/^##\s+(.+)$/);
      if (h) { atual = { titulo: h[1].trim(), linhas: [] }; secoes.push(atual); return; }
      if (atual) atual.linhas.push(l);
    });
    var legendas = secoes.filter(function (x) { return /^legenda/i.test(x.titulo); });
    var escolhida = legendas.filter(function (x) { return /aprovad/i.test(x.titulo); })[0] || legendas[0];
    if (escolhida) r.legenda = escolhida.linhas.join('\n').trim();
    r.legenda_versao = escolhida ? escolhida.titulo : '';
    var hs = secoes.filter(function (x) { return /^hashtags/i.test(x.titulo); })[0];
    if (hs) r.hashtags = hs.linhas.join(' ').replace(/\s+/g, ' ').trim();
    return r;
  }

  /** SHA-256 em JavaScript puro (UTF-8), hex minúsculo. Igual a hashlib.sha256(s.encode()).hexdigest(). */
  function sha256(texto) {
    var bytes = [];
    var str = unescape(encodeURIComponent(String(texto)));
    for (var i = 0; i < str.length; i++) bytes.push(str.charCodeAt(i));
    var K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var bitLen = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    var alto = Math.floor(bitLen / 0x100000000), baixo = bitLen >>> 0;
    bytes.push((alto >>> 24) & 255, (alto >>> 16) & 255, (alto >>> 8) & 255, alto & 255, (baixo >>> 24) & 255, (baixo >>> 16) & 255, (baixo >>> 8) & 255, baixo & 255);
    function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }
    var W = new Array(64);
    for (var o = 0; o < bytes.length; o += 64) {
      for (var t = 0; t < 16; t++) W[t] = (bytes[o + 4 * t] << 24) | (bytes[o + 4 * t + 1] << 16) | (bytes[o + 4 * t + 2] << 8) | bytes[o + 4 * t + 3];
      for (t = 16; t < 64; t++) {
        var s0 = rotr(W[t - 15], 7) ^ rotr(W[t - 15], 18) ^ (W[t - 15] >>> 3);
        var s1 = rotr(W[t - 2], 17) ^ rotr(W[t - 2], 19) ^ (W[t - 2] >>> 10);
        W[t] = (W[t - 16] + s0 + W[t - 7] + s1) | 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (t = 0; t < 64; t++) {
        var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        var ch = (e & f) ^ (~e & g);
        var t1 = (h + S1 + ch + K[t] + W[t]) | 0;
        var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + maj) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    return H.map(function (x) { return ('00000000' + (x >>> 0).toString(16)).slice(-8); }).join('');
  }

  var SEP = '\u001f';
  /**
   * Texto canônico do que o Bruno vê. O hash dele vai em decisoes.csv (snapshot_hash).
   * design: design␟id␟versao␟arte_fileId␟canva_design_id␟estado
   * post:   post␟id␟arte_fileId␟legenda␟hashtags␟contas␟horario␟estado
   * (␟ = caractere U+001F; campos sem espaços nas pontas)
   */
  function canonicoDesign(d) {
    return ['design', d.id, d.versao, d.arte_fileId, d.canva_design_id, d.estado].map(function (x) { return String(x || '').trim(); }).join(SEP);
  }
  function canonicoPost(p) {
    return ['post', p.id, p.arte_fileId, p.legenda, p.hashtags, p.contas, p.horario, p.estado].map(function (x) { return String(x || '').trim(); }).join(SEP);
  }

  function ehVideo(tipo, formato) { return /v[ií]deo|reels/i.test((tipo || '') + ' ' + (formato || '')); }

  function diasDesde(dataTxt, agora) {
    var d = parseData(dataTxt);
    if (!d) return null;
    var hoje = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate());
    var dia = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    return Math.round((hoje - dia) / DIA_MS);
  }

  /** Estado de uma arte sem pedido: aprovado_em, refacao ou entregue. */
  function estadoDaArte(a) {
    if (a.aprovado_em) return 'aprovado';
    if (a.refacao && /refaz|refazer|ajust/i.test(a.refacao)) return 'refazer';
    if (a.entregue_em) return 'entregue';
    return 'em_criacao';
  }

  /**
   * Monta o modelo do módulo Design e Posts.
   * fontes: { pedidos:{linhas}, artes:{linhas}, posts:{linhas}, midia:{linhas}, produtos:{linhas}, rascunhos:[{nome, texto, fileId, atualizado}] }
   * Cada fonte pode estar ausente (null): o painel mostra o aviso e segue.
   * decisoes: linhas de decisoes.csv.
   */
  function montarModelo(fontes, decisoes, agora, opcoes) {
    agora = agora || new Date();
    opcoes = opcoes || {};
    var diasRefazer = opcoes.dias_refazer_parado || 2;
    var pedidos = (fontes.pedidos && fontes.pedidos.linhas) || [];
    var artes = (fontes.artes && fontes.artes.linhas) || [];
    var recibos = opcoes.recibos || {};
    var todas = (decisoes || []).map(function (d) {
      var r = recibos[d.id] || null;
      return { id: d.id, quando: d.quando, modulo: d.modulo, item_id: d.item_id, tipo_item: d.tipo_item, versao: d.versao, arte_fileId: d.arte_fileId, snapshot_hash: d.snapshot_hash, decisao: d.decisao, comentario: d.comentario, origem: d.origem, recibo: r };
    });
    var pendentes = todas.filter(function (d) { return !d.recibo; });
    var pendPorItem = {};
    pendentes.forEach(function (d) { if (d.modulo !== 'anuncios') pendPorItem[d.item_id] = d; });

    // Designs: agrupa as versões por pedido (ou pela própria arte quando não há pedido)
    var grupos = {};
    var ordem = [];
    artes.forEach(function (a) {
      var chave = a.pedido_id || a.id;
      if (!grupos[chave]) { grupos[chave] = { chave: chave, versoes: [] }; ordem.push(chave); }
      grupos[chave].versoes.push(a);
    });
    var pedidoPorId = {};
    pedidos.forEach(function (p) {
      pedidoPorId[p.id] = p;
      if (!grupos[p.id]) { grupos[p.id] = { chave: p.id, versoes: [] }; ordem.push(p.id); }
    });

    var designs = ordem.map(function (chave) {
      var g = grupos[chave];
      g.versoes.sort(function (a, b) { return (+a.versao || 0) - (+b.versao || 0); });
      var ult = g.versoes[g.versoes.length - 1] || {};
      var p = pedidoPorId[chave] || null;
      var estado = p && p.estado ? p.estado : estadoDaArte(ult);
      var arteId = ult.arte_fileId || (p && p.arte_fileIds ? p.arte_fileIds.split(/[\s;|]+/)[0] : '');
      var tipo = ult.tipo || (p && p.tipo) || '';
      var formato = ult.formato || (p && p.formatos) || '';
      var entregue = (p && p.entregue_em) || ult.entregue_em || '';
      var refacoes = g.versoes.filter(function (v) { return v.refacao; }).map(function (v) { return { versao: v.versao, texto: v.refacao, arte_fileId: v.arte_fileId }; });
      var dias = diasDesde(entregue || (p && p.pedido_em), agora);
      return {
        id: chave,
        pedido_id: p ? p.id : '',
        empresa: ult.empresa || (p && p.empresa) || '',
        tipo: tipo,
        formato: formato,
        versao: ult.versao || '',
        estado: estado,
        video: ehVideo(tipo, formato),
        arte_fileId: arteId,
        canva_design_id: ult.canva_design_id || (p && p.canva_design_id) || '',
        pedido_em: p ? p.pedido_em : '',
        prazo: p ? p.prazo : '',
        entregue_em: entregue,
        aprovado_em: (p && p.aprovado_em) || ult.aprovado_em || '',
        briefing: p ? p.briefing : '',
        quem_pediu: p ? p.quem_pediu : '',
        obs: p ? p.obs : '',
        versoes: g.versoes.map(function (v) {
          return { id: v.id, versao: v.versao, arte_fileId: v.arte_fileId, canva_design_id: v.canva_design_id, entregue_em: v.entregue_em, aprovado_em: v.aprovado_em, refacao: v.refacao, formato: v.formato };
        }),
        refacoes: refacoes,
        dias_parado: dias,
        decisao_pendente: pendPorItem[chave] || null
      };
    });
    designs.forEach(function (d) { d.snapshot_hash = sha256(canonicoDesign(d)); });
    designs.sort(function (a, b) { return String(b.entregue_em || b.pedido_em).localeCompare(String(a.entregue_em || a.pedido_em)) || String(b.id).localeCompare(String(a.id)); });

    // Posts
    var rascunhos = fontes.rascunhos || [];
    var mdPorPedido = {};
    rascunhos.forEach(function (r) {
      var info = parsePostMd(r.texto, r.nome);
      info.fileId = r.fileId; info.atualizado = r.atualizado;
      if (info.pedido_id) mdPorPedido[info.pedido_id] = info;
    });
    var designPorId = {};
    designs.forEach(function (d) { designPorId[d.id] = d; });
    var idsPosts = [];
    pedidos.forEach(function (p) { if (mdPorPedido[p.id] || /post:/.test(p.obs || '')) idsPosts.push(p.id); });
    Object.keys(mdPorPedido).forEach(function (id) { if (idsPosts.indexOf(id) < 0) idsPosts.push(id); });

    var posts = idsPosts.map(function (id) {
      var p = pedidoPorId[id] || {};
      var md = mdPorPedido[id] || null;
      var d = designPorId[id] || {};
      var marcas = parsePostObs(p.obs);
      var estado;
      // Publicado só com evidência (marca com link). Programado com horário já passado
      // e sem link do mesmo formato fica "aguardando_confirmacao": o relógio não prova publicação.
      var publicados = marcas.filter(function (m) { return m.tipo === 'publicado' && m.link; });
      var programados = marcas.filter(function (m) { return m.tipo === 'programado'; });
      var semEvidencia = programados.filter(function (m) {
        var dt = parseData(m.quando, agora.getFullYear());
        if (!dt || dt > agora) return false;
        return !publicados.some(function (x) { return !m.formato || !x.formato || x.formato === m.formato; });
      });
      var futuros = programados.filter(function (m) { var dt = parseData(m.quando, agora.getFullYear()); return !dt || dt > agora; });
      if (semEvidencia.length) estado = 'aguardando_confirmacao';
      else if (futuros.length) estado = 'programado';
      else if (publicados.length) estado = 'publicado';
      else if (marcas.some(function (m) { return m.tipo === 'manual'; })) estado = 'manual';
      else if (md && md.aprovado) estado = 'aprovado';
      else if (md && (d.estado === 'aprovado')) estado = 'aguardando_aprovo';
      else estado = 'rascunho';
      return {
        id: id,
        empresa: (md && md.empresa) || d.empresa || p.empresa || '',
        titulo: (md && md.titulo) || d.tipo || p.tipo || '',
        estado: estado,
        arte_fileId: d.arte_fileId || '',
        video: !!d.video,
        legenda: md ? md.legenda : '',
        legenda_versao: md ? md.legenda_versao : '',
        hashtags: md ? md.hashtags : '',
        contas: md ? md.contas : '',
        horario: md ? md.horario : '',
        estado_texto: md ? md.estado_texto : '',
        rascunho_fileId: md ? md.fileId : '',
        marcas: marcas,
        arte_estado: d.estado || '',
        decisao_pendente: pendPorItem['post:' + id] || null
      };
    });
    // Posts.csv do ledger do Design (planejamento semanal) entra como rascunho quando não tem pedido
    ((fontes.posts && fontes.posts.linhas) || []).forEach(function (r) {
      if (!r.id || idsPosts.indexOf(r.id) >= 0) return;
      var est = /public/i.test(r.estado) ? 'publicado' : /program/i.test(r.estado) ? 'programado' : /aprov/i.test(r.estado) ? 'aprovado' : 'rascunho';
      posts.push({ id: r.id, empresa: r.empresa, titulo: r.ideia, estado: est, arte_fileId: r.arte_fileId || '', video: ehVideo('', r.formato), legenda: r.legenda, legenda_versao: '', hashtags: '', contas: '', horario: r.data, estado_texto: r.estado, rascunho_fileId: '', marcas: [], arte_estado: '', decisao_pendente: pendPorItem['post:' + r.id] || null });
    });

    posts.forEach(function (p) { p.snapshot_hash = sha256(canonicoPost(p)); });
    // Decisão pendente feita sobre outra versão do item
    designs.concat(posts).forEach(function (x) {
      if (x.decisao_pendente) x.decisao_pendente.obsoleta = x.decisao_pendente.snapshot_hash !== x.snapshot_hash;
    });

    // Início: o que espera o Bruno
    var artesEntregues = designs.filter(function (d) { return d.estado === 'entregue'; });
    var postsPendentes = posts.filter(function (p) { return p.estado === 'rascunho' || p.estado === 'aguardando_aprovo'; });
    var postsSemConfirmacao = posts.filter(function (p) { return p.estado === 'aguardando_confirmacao'; });
    var refazerParados = designs.filter(function (d) { return d.estado === 'refazer' && d.dias_parado !== null && d.dias_parado > diasRefazer; });

    // Biblioteca
    var midia = ((fontes.midia && fontes.midia.linhas) || []).map(function (m) {
      return { fileId: m.fileId, empresa: m.empresa, pasta: m.pasta, tipo: m.tipo, descricao: m.descricao, adicionado_em: m.adicionado_em, usado_em: m.usado_em, ia: /gerad[oa] por ia/i.test(m.descricao || '') };
    });
    var produtos = ((fontes.produtos && fontes.produtos.linhas) || []).map(function (p) {
      return { id: p.id, empresa: p.empresa, produto: p.produto, colecao: p.colecao, descricao: p.descricao, venda: p.venda || p.kit || '', preco: p.preco, pasta_midia: p.pasta_midia, midia_obs: p.midia_obs, status: p.status, atualizado_em: p.atualizado_em };
    });

    var anuncios = opcoes.anuncios ? montarAnuncios(Object.assign({}, opcoes.anuncios, { designs: designs }), todas, agora) : null;

    return {
      anuncios: anuncios,
      gerado_em: agora.toISOString(),
      inicio: {
        artes_entregues: artesEntregues.map(function (d) { return d.id; }),
        posts_pendentes: postsPendentes.map(function (p) { return p.id; }),
        refazer_parados: refazerParados.map(function (d) { return d.id; }),
        posts_sem_confirmacao: postsSemConfirmacao.map(function (p) { return p.id; }),
        decisoes_pendentes: pendentes,
        decisoes_recusadas: todas.filter(function (d) { return d.recibo && d.recibo.resultado === 'rejeitado'; }).slice(-10)
      },
      designs: designs,
      posts: posts,
      midia: midia,
      produtos: produtos,
      empresas: unicos(designs.map(function (d) { return d.empresa; }).concat(midia.map(function (m) { return m.empresa; }))),
      tipos: unicos(designs.map(function (d) { return d.tipo; }))
    };
  }

  function unicos(lista) {
    var vistos = {};
    return lista.filter(function (x) { if (!x || vistos[x]) return false; vistos[x] = 1; return true; }).sort();
  }

  /* ================= Módulo anuncios (Gestor de Tráfego) ================= */

  /** Campo do texto canônico v2: CRLF/CR viram LF e as pontas são cortadas. */
  function normCampo(x) { return String(x === null || x === undefined ? '' : x).replace(/\r\n?/g, '\n').trim(); }
  /**
   * Texto canônico das linhas de Propostas.csv (hash = SHA-256 hex do UTF-8):
   * post:     post␟id␟versao␟midia_fileIds␟legenda_1␟legenda_2␟hashtags␟contas␟horario␟estado
   * campanha: campanha␟id␟versao␟verba_diaria␟inicio␟fim␟publico_resumo␟plano_fileId␟estado
   */
  function canonicoPostV2(r) {
    return ['post', r.id, r.versao, r.midia_fileIds, r.legenda_1, r.legenda_2, r.hashtags, r.contas, r.horario, r.estado].map(normCampo).join(SEP);
  }
  function canonicoCampanha(r) {
    return ['campanha', r.id, r.versao, r.verba_diaria, r.inicio, r.fim, r.publico_resumo, r.plano_fileId, r.estado].map(normCampo).join(SEP);
  }

  var CABECALHO_PROPOSTAS = ['id', 'tipo', 'empresa', 'pedido_id', 'versao', 'formato', 'contas', 'horario', 'midia_fileIds', 'legenda_1', 'legenda_2', 'legenda_escolhida', 'hashtags', 'campanha_id', 'verba_diaria', 'inicio', 'fim', 'publico_resumo', 'plano_fileId', 'estado', 'atualizado_em', 'plataforma_link'];
  /**
   * Chave da integração com o Gestor de Tráfego. Enquanto false, os botões de decisão de
   * Posts e anúncios ficam desabilitados e o servidor não grava nada. Só o Builder liga.
   */
  var CHAVES = { ANUNCIOS_INTEGRADOS: false, SUPORTE_INTEGRADO: false, EMAILS_INTEGRADO: false, FINANCAS_INTEGRADO: false, INVESTIMENTOS_INTEGRADO: false };
  var DECISOES_ANUNCIOS = {
    post: { aprovar: ['rascunho', 'aguardando_aprovo'], refazer: ['rascunho', 'aguardando_aprovo'], recusar: ['rascunho', 'aguardando_aprovo'] },
    campanha: { aprovar: ['plano', 'ajuste'], refazer: ['plano', 'ajuste'], recusar: ['plano', 'ajuste'], pausar: ['ativo'] }
  };

  /** Ids de mídia separados por ";" (ordem do carrossel). */
  function midias(txt) { return String(txt || '').split(';').map(function (s) { return s.trim(); }).filter(Boolean); }
  function ehLink(s) { return /^https?:\/\/\S+$/i.test(String(s || '').trim()); }
  function numero(s) {
    var t = String(s === null || s === undefined ? '' : s).trim().replace(/^R\$\s*/, '');
    if (!t) return null;
    if (/^\d{1,3}(\.\d{3})*,\d+$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');
    else t = t.replace(',', '.');
    var n = Number(t);
    return isFinite(n) ? n : null;
  }
  function soDia(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function diaIso(d) { function p(n) { return (n < 10 ? '0' : '') + n; } return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); }
  function arred(n) { return Math.round(n * 100) / 100; }

  /**
   * Comentário de decisão do módulo anuncios, formato fixo:
   * pares chave=valor separados por ";" na ordem legenda, horario, verba, texto.
   * "texto" é sempre o último e pode conter ";" e "=". Quebras de linha viram espaço.
   * Ex.: legenda=1;horario=2026-11-13 18:30;texto=usar a foto 2
   */
  function parseComentarioAnuncio(txt) {
    var s = String(txt || '').replace(/[\r\n]+/g, ' ').trim();
    var r = {};
    var ordem = ['legenda', 'horario', 'verba'];
    var pos = 0;
    while (s) {
      if (/^texto=/.test(s)) { r.texto = s.slice(6).trim(); break; }
      var i = s.indexOf(';');
      var par = i < 0 ? s : s.slice(0, i);
      s = i < 0 ? '' : s.slice(i + 1).replace(/^\s+/, '');
      var m = par.match(/^(\w+)=(.*)$/);
      if (!m) throw new Error('comentário fora do formato (esperado chave=valor): "' + par + '"');
      var k = m[1], v = m[2].trim();
      var idx = ordem.indexOf(k);
      if (idx < 0) throw new Error('chave desconhecida no comentário: ' + k);
      if (idx < pos) throw new Error('chaves fora de ordem no comentário (legenda, horario, verba, texto)');
      pos = idx + 1;
      if (k === 'legenda' && !/^[12]$/.test(v)) throw new Error('legenda deve ser 1 ou 2');
      if (k === 'horario' && !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(v)) throw new Error('horario deve ser aaaa-mm-dd HH:mm');
      if (k === 'verba' && !(/^\d+(\.\d{1,2})?$/.test(v) && +v > 0)) throw new Error('verba deve ser um número maior que zero (ponto decimal)');
      r[k] = v;
    }
    return r;
  }
  /** Monta o comentário no formato fixo (usado pela tela e pelos testes). */
  function montarComentarioAnuncio(o) {
    var p = [];
    if (o.legenda) p.push('legenda=' + o.legenda);
    if (o.horario) p.push('horario=' + o.horario);
    if (o.verba) p.push('verba=' + o.verba);
    var t = String(o.texto || '').replace(/[\r\n]+/g, ' ').trim();
    if (t) p.push('texto=' + t);
    return p.join(';');
  }
  /** Regras de comentário por tipo e decisão. Lança com mensagem clara. */
  function validarComentarioAnuncio(tipo, decisao, comentario, item) {
    var c = parseComentarioAnuncio(comentario);
    var permitidas = tipo === 'post' ? (decisao === 'aprovar' ? ['legenda', 'horario', 'texto'] : ['texto']) : (decisao === 'aprovar' ? ['verba', 'texto'] : ['texto']);
    Object.keys(c).forEach(function (k) { if (permitidas.indexOf(k) < 0) throw new Error('"' + k + '" não vale para ' + decisao + ' de ' + tipo); });
    if (tipo === 'post' && decisao === 'aprovar' && !c.legenda) throw new Error('escolha a legenda 1 ou 2');
    if (decisao === 'refazer' && !c.texto) throw new Error('o pedido de ajuste precisa de um comentário');
    if (c.verba) {
      var prop = numero(item && item.verba_diaria);
      if (prop === null) throw new Error('a proposta não tem verba diária; não dá para aprovar com outra verba');
      if (+c.verba > prop) throw new Error('verba ' + c.verba + ' maior que a proposta (' + prop + '); o painel só aceita igual ou menor');
    }
    return c;
  }

  function formatoDe(txt) {
    var m = String(txt || '').toLowerCase().match(/carrossel|reels|story|stories|feed|v[ií]deo/);
    if (!m) return '';
    return m[0] === 'stories' ? 'story' : /v[ií]deo/.test(m[0]) ? 'reels' : m[0];
  }
  /** Contas de destino a partir de texto livre: @perfil vira ig:@perfil, "Página X" vira fb:X. */
  function contasDoTexto(txt) {
    var s = String(txt || '');
    var r = [];
    (s.match(/@[\w.]+/g) || []).forEach(function (h) { var c = 'ig:' + h.replace(/\.$/, ''); if (r.indexOf(c) < 0) r.push(c); });
    var fb = s.match(/P[áa]gina(?: do Facebook)? ([A-Z][\w ]*?\w)(?=\s*(?:\(|$|[,;.+]))/);
    if (fb) r.push('fb:' + fb[1].trim());
    return r;
  }
  function rotuloConta(c) {
    var m = String(c).match(/^(ig|fb|tt|yt|li):(.+)$/);
    if (!m) return c;
    return ({ ig: 'Instagram ', fb: 'Facebook ', tt: 'TikTok ', yt: 'YouTube ', li: 'LinkedIn ' })[m[1]] + m[2];
  }

  /** Estado exibido de uma publicação: publicado só com link; horário passado sem link vira aguardando_confirmacao. */
  function estadoPublicacao(estado, link, quando, agora) {
    var e = String(estado || '').toLowerCase().trim();
    var dt = parseData(quando, agora.getFullYear());
    var temHora = /\d{1,2}:\d{2}/.test(String(quando || ''));
    var passou = dt ? (temHora ? dt <= agora : soDia(dt) < soDia(agora)) : false;
    if (e === 'publicado') return ehLink(link) ? 'publicado' : 'aguardando_confirmacao';
    if (e === 'programado') return ehLink(link) ? 'publicado' : (passou ? 'aguardando_confirmacao' : 'programado');
    if (['rascunho', 'aguardando_aprovo', 'aprovado', 'recusado', 'ajuste'].indexOf(e) >= 0) return e;
    return 'rascunho';
  }

  /** Lê o plano-<empresa>-<aaaa-mm>.md: título, campanha citada e texto. */
  function parsePlanoMd(texto, nome) {
    var s = String(texto || '').replace(/\r/g, '');
    var t = s.match(/^#\s*(.+)$/m);
    var c = s.match(/\bCampanha\s+([A-Z]-?\d[\w-]*|C\d+)\b/);
    var e = s.match(/^Estado:\s*(.+)$/mi);
    return { nome: nome || '', titulo: t ? t[1].trim() : (nome || ''), campanha_id: c ? c[1] : '', estado_texto: e ? e[1].trim() : '', texto: s };
  }

  /**
   * Monta o módulo Posts e anúncios.
   * fontes: { anuncios, campanhas, resultados, empresas, checkpoints, rules, propostas (null = ausente),
   *           rascunhos:[{nome,texto,fileId}], planos:[{nome,texto,fileId}], designs:[...] (para achar arte por pedido) }
   * todas: decisões já com recibo (montarModelo). agora: data local de São Paulo.
   */
  function montarAnuncios(fontes, todas, agora, opcoes) {
    opcoes = opcoes || {};
    var hoje = soDia(agora);
    var linhas = function (f) { return (fontes[f] && fontes[f].linhas) || []; };
    var propostasAtivas = !!(fontes.propostas && fontes.propostas.linhas);
    var props = propostasAtivas ? linhas('propostas') : [];

    // decisões do módulo: pendente (sem recibo) e último recibo por item
    var pend = {}, ultimoRecibo = {};
    (todas || []).forEach(function (d) {
      if (d.modulo !== 'anuncios') return;
      if (!d.recibo) pend[d.item_id] = d;
      else ultimoRecibo[d.item_id] = { decision_id: d.id, decisao: d.decisao, resultado: d.recibo.resultado, motivo: d.recibo.motivo, link: d.recibo.link || '', processado_em: d.recibo.processado_em };
    });

    // rascunhos post-*.md por pedido
    var mdPorPedido = {};
    (fontes.rascunhos || []).forEach(function (r) {
      var info = parsePostMd(r.texto, r.nome);
      var s = String(r.texto || '').replace(/\r/g, '');
      var secoes = s.split(/^##\s+/m).slice(1);
      var legs = secoes.filter(function (x) { return /^legenda/i.test(x); }).map(function (x) { var i = x.indexOf('\n'); return { titulo: x.slice(0, i).trim(), texto: x.slice(i + 1).trim() }; });
      info.legendas = legs;
      var arte = s.match(/drive\.google\.com\/file\/d\/([\w-]{10,})/);
      info.arte_fileId = arte ? arte[1] : '';
      info.fileId = r.fileId;
      if (info.pedido_id) mdPorPedido[info.pedido_id] = info;
    });
    var designPorId = {};
    (fontes.designs || []).forEach(function (d) { designPorId[d.id] = d; });
    var empresasCsv = linhas('empresas');

    var posts = [];
    var pedidosCobertos = {};
    // Índice para juntar o mesmo post: pedido/id da proposta, mídia+horário e mídia+dia.
    var postPorChave = {};
    function chavesPost(fileId, horario) {
      var h = String(horario || '').trim().replace('T', ' ').slice(0, 16);
      return fileId ? ['f:' + fileId + '|' + h, 'd:' + fileId + '|' + h.slice(0, 10)] : [];
    }
    function indexar(item, ids) {
      ids.concat(chavesPost(midias(item.midia_fileIds)[0], item.horario)).forEach(function (k) { if (k && !postPorChave[k]) postPorChave[k] = item; });
    }
    // 1) Propostas estruturadas (decidíveis)
    props.filter(function (r) { return r.tipo === 'post'; }).forEach(function (r) {
      var exib = estadoPublicacao(r.estado, r.plataforma_link, r.horario, agora);
      if (['publicado', 'programado'].indexOf(String(r.estado).trim()) < 0) exib = String(r.estado || 'rascunho').trim();
      var item = {
        id: r.id, item_id: 'post:' + r.id, origem: 'propostas', empresa: r.empresa, pedido_id: r.pedido_id || '',
        titulo: (r.legenda_1 || '').split(/[.:\n]/)[0].slice(0, 90) || r.id,
        formato: r.formato || '', versao: r.versao || '', estado: exib, estado_bruto: r.estado,
        contas: midias(r.contas), horario: r.horario || '', midias: midias(r.midia_fileIds), midia_fileIds: r.midia_fileIds || '',
        legenda_1: r.legenda_1 || '', legenda_2: r.legenda_2 || '', legenda_escolhida: r.legenda_escolhida || '',
        hashtags: r.hashtags || '', link: ehLink(r.plataforma_link) ? r.plataforma_link : '', campanha_id: r.campanha_id || '',
        atualizado_em: r.atualizado_em || '', snapshot_hash: sha256(canonicoPostV2(r)), programacoes: []
      };
      item.decisoes_possiveis = Object.keys(DECISOES_ANUNCIOS.post).filter(function (k) { return DECISOES_ANUNCIOS.post[k].indexOf(String(r.estado).trim()) >= 0; });
      posts.push(item);
      indexar(item, ['p:' + r.id].concat(r.pedido_id ? ['p:' + r.pedido_id] : []));
      if (r.pedido_id) pedidosCobertos[r.pedido_id] = true;
    });
    // 2) Publicações do ledger do Tráfego (Anuncios.csv)
    linhas('anuncios').forEach(function (a) {
      if (!a.id) return;
      var ped = (String(a.texto_resumo || '').match(/\(?(P-\d{8}-\d+)/) || [])[1] || '';
      var md = ped ? mdPorPedido[ped] : null;
      var link = ehLink(a.plataforma_id) ? a.plataforma_id : '';
      var legV = (String(a.texto_resumo || '').match(/legenda v(\d)/i) || [])[1] || '';
      var contas = contasDoTexto(a.texto_resumo);
      var prog = {
        id: a.id, formato: formatoDe(a.versao) || formatoDe(a.texto_resumo), horario: a.ativo_em || '',
        estado: estadoPublicacao(a.estado, link, a.ativo_em, agora), link: link, onde: link ? '' : (a.plataforma_id || ''),
        canal: a.canal || '', edicao_do_bruno: a.edicao_do_bruno || ''
      };
      // Mesmo post já na tela (proposta, ou outra linha com a mesma mídia e horário): vira programação dentro do cartão.
      var cand = (ped ? ['p:' + ped] : []).concat(chavesPost(midias(a.arte_fileId)[0], a.ativo_em));
      var alvo = null;
      for (var i = 0; i < cand.length && !alvo; i++) {
        var x = postPorChave[cand[i]];
        if (x && (cand[i].charAt(0) !== 'd' || x.origem === 'propostas')) alvo = x;
      }
      if (alvo) {
        alvo.programacoes.push(prog);
        if (ped) pedidosCobertos[ped] = true;
        return;
      }
      var item = {
        id: a.id, item_id: 'post:' + a.id, origem: 'publicacao', empresa: a.empresa, pedido_id: ped,
        titulo: String(a.texto_resumo || '').split(/\s*\(/)[0].trim() || a.id,
        resumo: a.texto_resumo || '', formato: formatoDe(a.versao) || formatoDe(a.texto_resumo), versao: (String(a.versao || '').match(/v(\d+)/) || [])[1] || '',
        estado: estadoPublicacao(a.estado, link, a.ativo_em, agora), estado_bruto: a.estado,
        contas: contas, horario: a.ativo_em || '', midias: midias(a.arte_fileId), midia_fileIds: a.arte_fileId || '',
        legenda_1: md && md.legendas[0] ? md.legendas[0].texto : '', legenda_2: md && md.legendas[1] ? md.legendas[1].texto : '',
        legenda_escolhida: legV, hashtags: md ? md.hashtags : '', link: link, onde: link ? '' : (a.plataforma_id || ''),
        canal: a.canal || '', edicao_do_bruno: a.edicao_do_bruno || '', campanha_id: a.campanha_id || '',
        rascunho_fileId: md ? md.fileId : '', decisoes_possiveis: [], programacoes: [prog]
      };
      posts.push(item);
      indexar(item, []);
      if (ped) pedidosCobertos[ped] = true;
    });
    // 3) Rascunhos .md sem proposta nem publicação
    Object.keys(mdPorPedido).forEach(function (ped) {
      if (pedidosCobertos[ped]) return;
      var md = mdPorPedido[ped];
      var d = designPorId[ped] || {};
      var est = md.aprovado ? 'aprovado' : (md.legendas.length ? 'aguardando_aprovo' : 'rascunho');
      posts.push({
        id: ped, item_id: 'post:' + ped, origem: 'rascunho', empresa: md.empresa || d.empresa || '', pedido_id: ped,
        titulo: md.titulo || ped, formato: formatoDe(md.formato) || formatoDe(d.formato), versao: '', estado: est, estado_bruto: md.estado_texto,
        contas: contasDoTexto(md.contas), horario: md.horario || '', midias: midias(d.arte_fileId || md.arte_fileId), midia_fileIds: d.arte_fileId || md.arte_fileId || '',
        legenda_1: md.legendas[0] ? md.legendas[0].texto : '', legenda_2: md.legendas[1] ? md.legendas[1].texto : '',
        legenda_escolhida: (md.legendas[1] && /aprovad/i.test(md.legendas[1].titulo)) ? '2' : (md.aprovado ? '1' : ''),
        hashtags: md.hashtags || '', link: '', rascunho_fileId: md.fileId, decisoes_possiveis: [], programacoes: []
      });
    });
    posts.forEach(function (p) {
      p.decisao_pendente = pend[p.item_id] || null;
      if (p.decisao_pendente) p.decisao_pendente.obsoleta = !!p.snapshot_hash && p.decisao_pendente.snapshot_hash !== p.snapshot_hash;
      p.ultimo_recibo = ultimoRecibo[p.item_id] || null;
      p.contas_rotulo = p.contas.map(rotuloConta);
      p.programacoes.sort(function (a, b) { return String(a.horario).localeCompare(String(b.horario)); });
    });
    posts.sort(function (a, b) { return String(b.horario).localeCompare(String(a.horario)) || String(b.id).localeCompare(String(a.id)); });

    // Planos .md
    var planos = (fontes.planos || []).map(function (p) { var x = parsePlanoMd(p.texto, p.nome); x.fileId = p.fileId; return x; });
    function planoDe(c) {
      for (var i = 0; i < planos.length; i++) if ((c.plano_fileId && planos[i].fileId === c.plano_fileId) || (planos[i].campanha_id && planos[i].campanha_id === c.id)) return planos[i];
      return null;
    }

    // Resultados: diários e intervalos
    var resultados = linhas('resultados').map(function (r) {
      var diario = /^\d{4}-\d{2}-\d{2}$/.test(String(r.data).trim());
      return { data: String(r.data).trim(), diario: diario, canal: r.canal, empresa: r.empresa, campanha_id: String(r.campanha_id || '').trim(), gasto: numero(r.gasto) || 0, impressoes: numero(r.impressoes) || 0, cliques: numero(r.cliques) || 0, contatos: numero(r.contatos) || 0, conversoes: numero(r.conversoes) || 0, valor: numero(r.valor) || 0 };
    });
    var checkpoints = linhas('checkpoints');
    function leituraDe(canal) {
      var k = 'leitura_' + String(canal || '').toLowerCase();
      var c = checkpoints.filter(function (x) { return x.source === k; })[0];
      return c ? c.last_checked_at : '';
    }

    // Campanhas: Campanhas.csv + Propostas (proposta manda nos campos decididos)
    var porId = {}, ordem = [], apelido = {};
    function semPrefixo(x) { return String(x || '').trim().replace(/^[MG]-/i, ''); }
    linhas('campanhas').forEach(function (c) {
      if (!c.id) return; porId[c.id] = { base: c, prop: null }; ordem.push(c.id);
      [c.id, semPrefixo(c.id), semPrefixo(c.plataforma_id)].forEach(function (k) { if (k && !apelido[k]) apelido[k] = c.id; });
    });
    props.filter(function (r) { return r.tipo === 'campanha'; }).forEach(function (r) {
      // campanha_id com ou sem o prefixo M-/G-, ou o id da plataforma: a mesma campanha do ledger.
      var cands = [r.campanha_id, r.id].map(function (x) { return String(x || '').trim(); }).filter(Boolean);
      var id = null;
      cands.forEach(function (k) { if (!id) id = porId[k] ? k : (apelido[k] || apelido[semPrefixo(k)] || null); });
      id = id || cands[0];
      if (!porId[id]) { porId[id] = { base: null, prop: null }; ordem.push(id); }
      porId[id].prop = r;
    });
    var seteAtras = new Date(hoje.getTime() - 6 * DIA_MS);
    var campanhas = ordem.map(function (id) {
      var b = porId[id].base || {}, r = porId[id].prop;
      var c = {
        id: id, item_id: 'campanha:' + (r ? r.id : id), origem: r ? 'propostas' : 'ledger',
        empresa: (r && r.empresa) || b.empresa || '', canal: b.canal || '', objetivo: b.objetivo || '',
        plataforma_id: b.plataforma_id || '', estado: String((r ? r.estado : b.estado) || '').trim(),
        // Proposta manda; campo vazio na proposta usa o valor do ledger.
        verba_diaria: (r && r.verba_diaria) || b.verba_diaria || '', inicio: (r && r.inicio) || b.inicio || '', fim: (r && r.fim) || b.fim || '',
        publico_resumo: r ? r.publico_resumo || '' : '', plano_fileId: r ? r.plano_fileId || '' : '', versao: r ? r.versao || '' : '',
        aprovado_em: b.aprovado_em || '', link: r && ehLink(r.plataforma_link) ? r.plataforma_link : ''
      };
      if (r) c.snapshot_hash = sha256(canonicoCampanha(r));
      c.decisoes_possiveis = r ? Object.keys(DECISOES_ANUNCIOS.campanha).filter(function (k) { return DECISOES_ANUNCIOS.campanha[k].indexOf(c.estado) >= 0; }) : [];
      var plano = planoDe(c);
      c.plano = plano ? { fileId: plano.fileId, nome: plano.nome, titulo: plano.titulo, estado_texto: plano.estado_texto, texto: plano.texto } : null;
      var chaves = [id, c.plataforma_id, String(id).replace(/^[MG]-/, '')].filter(Boolean);
      var meus = resultados.filter(function (x) { return chaves.indexOf(x.campanha_id) >= 0; });
      var diarios = meus.filter(function (x) { return x.diario; }).sort(function (a, z) { return a.data.localeCompare(z.data); });
      var soma = function (l, k) { return arred(l.reduce(function (s, x) { return s + x[k]; }, 0)); };
      var ult7 = diarios.filter(function (x) { var d = parseData(x.data); return d >= seteAtras && d <= hoje; });
      c.diario = diarios.map(function (x) { return { data: x.data, gasto: x.gasto, impressoes: x.impressoes, cliques: x.cliques, contatos: x.contatos }; });
      c.periodos = meus.filter(function (x) { return !x.diario; }).map(function (x) { return { data: x.data, gasto: x.gasto, impressoes: x.impressoes, cliques: x.cliques, contatos: x.contatos }; });
      c.gasto_total = soma(diarios, 'gasto'); c.gasto_7d = soma(ult7, 'gasto');
      c.impressoes = soma(diarios, 'impressoes'); c.cliques = soma(diarios, 'cliques'); c.contatos = soma(diarios, 'contatos');
      c.custo_contato = c.contatos > 0 ? arred(c.gasto_total / c.contatos) : null;
      c.alertas = [];
      if (c.estado === 'ativo') {
        var fim = /^\d{4}-\d{2}-\d{2}/.test(c.fim) ? parseData(c.fim) : null;
        if (fim && soDia(fim) < hoje) c.alertas.push('o período acabou em ' + c.fim.slice(8, 10) + '/' + c.fim.slice(5, 7) + ' e a campanha segue ativa');
        var leit = leituraDe(c.canal);
        var leitDia = leit ? parseData(leit) : null;
        var temHoje = diarios.some(function (x) { return x.data === diaIso(hoje); });
        if (leitDia && soDia(leitDia).getTime() === hoje.getTime() && !temHoje) c.alertas.push('ativa e sem resultado de hoje na leitura ' + leit.slice(11, 16));
      }
      c.decisao_pendente = pend[c.item_id] || null;
      if (c.decisao_pendente) c.decisao_pendente.obsoleta = !!c.snapshot_hash && c.decisao_pendente.snapshot_hash !== c.snapshot_hash;
      c.ultimo_recibo = ultimoRecibo[c.item_id] || null;
      return c;
    });
    var ordemEstado = { ativo: 0, plano: 1, ajuste: 2, aprovado: 3, pausado: 4, encerrado: 5 };
    campanhas.sort(function (a, z) { return (ordemEstado[a.estado] === undefined ? 9 : ordemEstado[a.estado]) - (ordemEstado[z.estado] === undefined ? 9 : ordemEstado[z.estado]) || String(a.id).localeCompare(String(z.id)); });

    // Início e resultados da semana
    var postsAguardando = posts.filter(function (p) { return p.estado === 'aguardando_aprovo'; });
    var planosAguardando = campanhas.filter(function (c) { return c.estado === 'plano'; });
    var alertas = [];
    campanhas.forEach(function (c) { c.alertas.forEach(function (t) { alertas.push({ campanha: c.id, empresa: c.empresa, texto: t }); }); });
    var empresas = unicos(posts.map(function (p) { return p.empresa; }).concat(campanhas.map(function (c) { return c.empresa; })).concat(empresasCsv.map(function (e) { return e.empresa; })));
    var porEmpresa = empresas.map(function (e) {
      return { empresa: e, posts: postsAguardando.filter(function (p) { return p.empresa === e; }).length, planos: planosAguardando.filter(function (c) { return c.empresa === e; }).length, alertas: alertas.filter(function (a) { return a.empresa === e; }).length };
    }).filter(function (x) { return x.posts || x.planos || x.alertas; });
    var semana = empresas.map(function (e) {
      var rs = resultados.filter(function (x) { if (!x.diario || x.empresa !== e) return false; var d = parseData(x.data); return d >= seteAtras && d <= hoje; });
      var gasto = arred(rs.reduce(function (s, x) { return s + x.gasto; }, 0));
      var contatos = rs.reduce(function (s, x) { return s + x.contatos; }, 0);
      var publicados = posts.filter(function (p) { if (p.empresa !== e || p.estado !== 'publicado') return false; var d = parseData(p.horario, agora.getFullYear()); return d && soDia(d) >= seteAtras && soDia(d) <= hoje; }).length;
      return { empresa: e, gasto: gasto, contatos: contatos, custo_contato: contatos > 0 ? arred(gasto / contatos) : null, posts_publicados: publicados };
    }).filter(function (x) { return x.gasto || x.contatos || x.posts_publicados; });

    return {
      propostas_ativas: propostasAtivas,
      integrados: CHAVES.ANUNCIOS_INTEGRADOS,
      posts: posts,
      campanhas: campanhas,
      planos: planos.map(function (p) { return { fileId: p.fileId, nome: p.nome, titulo: p.titulo, campanha_id: p.campanha_id }; }),
      inicio: { posts_aguardando: postsAguardando.map(function (p) { return p.id; }), planos_aguardando: planosAguardando.map(function (c) { return c.id; }), alertas: alertas, por_empresa: porEmpresa },
      semana: { de: diaIso(seteAtras), ate: diaIso(hoje), empresas: semana },
      leituras: checkpoints.map(function (c) { return { fonte: c.source, quando: c.last_checked_at, cursor: c.cursor }; }),
      rules: linhas('rules').filter(function (r) { return !r.status || r.status === 'active'; }).map(function (r) { return { id: r.rule_id, efeito: r.effect, escopo: r.scope_value, evidencia: r.evidence }; }),
      empresas: empresas,
      contas: unicos([].concat.apply([], posts.map(function (p) { return p.contas; })))
    };
  }

  /** Confere decisão do módulo anuncios contra o modelo recém-lido. */
  function conferirDecisaoAnuncio(modelo, d) {
    var an = modelo.anuncios;
    if (!an) throw new Error('o módulo Posts e anúncios não está ativo no painel-fontes.json');
    if (!CHAVES.ANUNCIOS_INTEGRADOS) throw new Error('o Gestor de Tráfego ainda não lê estas decisões; nada foi gravado');
    var m = String(d.item_id).match(/^(post|campanha):(.+)$/);
    if (!m) throw new Error('item inválido para Posts e anúncios');
    var tipo = m[1];
    var lista = tipo === 'post' ? an.posts : an.campanhas;
    var item = null;
    for (var i = 0; i < lista.length; i++) if (lista[i].item_id === d.item_id) { item = lista[i]; break; }
    if (!item) throw new Error('item ' + d.item_id + ' não existe mais nos arquivos do Gestor de Tráfego');
    if (item.origem !== 'propostas' || !item.snapshot_hash) throw new Error('item ' + d.item_id + ' não está em Propostas.csv; propostas estruturadas ainda não ativadas para ele');
    var estados = DECISOES_ANUNCIOS[tipo][d.decisao];
    if (!estados) throw new Error('decisão "' + d.decisao + '" não vale para ' + tipo);
    var bruto = tipo === 'post' ? item.estado_bruto : item.estado;
    if (estados.indexOf(String(bruto).trim()) < 0) throw new Error('item ' + d.item_id + ' está "' + bruto + '" e não aceita ' + d.decisao + ' agora; atualize o painel');
    if (item.snapshot_hash !== d.snapshot_hash) throw new Error('o item ' + d.item_id + ' mudou desde que a tela foi carregada; atualize o painel e confira de novo');
    var pend = item.decisao_pendente;
    if (pend && pend.snapshot_hash === d.snapshot_hash) throw new Error('já existe uma decisão enviada para esta versão (' + pend.id + ')');
    validarComentarioAnuncio(tipo, d.decisao, d.comentario, item);
    return { tipo_item: tipo, versao: item.versao || '', arte_fileId: tipo === 'post' ? (item.midia_fileIds || '') : '', snapshot_hash: item.snapshot_hash };
  }

  /* ================= v3: base comum dos módulos novos ================= */
  /*
   * Cada módulo v3 se registra em MODULOS_V3 com:
   *   id, rotulo, agente, chave (nome em CHAVES; null = só leitura),
   *   fontes: { chave: { arquivo, rotulo, obrigatorias, opcional } }  (lidas pelo Code.gs, ids no painel-fontes.json)
   *   decisoes: { tipo_item: { decisao: { rotulo, estados, campos:[{k, obrigatorio, rotulo}], primario } } }
   *   montar(fontes, decisoesDoModulo, agora) -> modelo da tela, com:
   *     itens: [{ item_id, tipo_item, versao, estado, snapshot_hash, ... }] (o que aceita decisão)
   *     precisa: { total, partes:[{rotulo, n}] }  (cartão do Início e selo do menu)
   * Decisões vão para o mesmo decisoes.csv; item_id sempre "<tipo_item>:<id>".
   */
  var AVISO_CHAVE_V3 = 'o agente ainda não lê estas decisões';
  var MODULOS_V3 = {};
  var ORDEM_V3 = [];
  function registrarModuloV3(def) { if (!MODULOS_V3[def.id]) ORDEM_V3.push(def.id); MODULOS_V3[def.id] = def; }

  /** Texto canônico v3: tipo␟campos..., cada campo com CRLF/CR -> LF e trim (igual ao v2). */
  function canonicoV3(tipo, campos) { return [tipo].concat(campos).map(normCampo).join(SEP); }

  /** Decisões com o recibo do agente (se houver). */
  function decisoesComRecibos(decisoes, recibos) {
    recibos = recibos || {};
    return (decisoes || []).map(function (d) {
      return { id: d.id, quando: d.quando, modulo: d.modulo, item_id: d.item_id, tipo_item: d.tipo_item, versao: d.versao, arte_fileId: d.arte_fileId, snapshot_hash: d.snapshot_hash, decisao: d.decisao, comentario: d.comentario, origem: d.origem, recibo: recibos[d.id] || null };
    });
  }

  /** Pendente (sem recibo) e último recibo por item, só do módulo. */
  function decisoesDoModulo(todas, modulo) {
    var pend = {}, ultimo = {};
    (todas || []).forEach(function (d) {
      if (d.modulo !== modulo) return;
      if (!d.recibo) pend[d.item_id] = d;
      else ultimo[d.item_id] = { decision_id: d.id, decisao: d.decisao, resultado: d.recibo.resultado, motivo: d.recibo.motivo, link: d.recibo.link || '', processado_em: d.recibo.processado_em };
    });
    return { pend: pend, ultimo: ultimo };
  }

  /** Liga pendência, recibo e decisões possíveis a um item que já tem snapshot_hash. */
  function prepararItemV3(item, def, dm) {
    var regras = (def.decisoes || {})[item.tipo_item] || {};
    item.decisoes_possiveis = Object.keys(regras).filter(function (k) { return regras[k].estados.indexOf(item.estado) >= 0; });
    var p = dm.pend[item.item_id] || null;
    if (p) p = Object.assign({}, p, { obsoleta: p.snapshot_hash !== item.snapshot_hash });
    item.decisao_pendente = p;
    item.ultimo_recibo = dm.ultimo[item.item_id] || null;
    return item;
  }

  function validarCampoV3(k, v) {
    if (k === 'data' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error('data deve ser aaaa-mm-dd');
    if (k === 'valor' && !(/^\d+(\.\d{1,2})?$/.test(v) && +v > 0)) throw new Error('valor deve ser um número maior que zero (ponto decimal)');
    if (k === 'texto' && v.length > 1500) throw new Error('texto muito longo');
  }
  /**
   * Comentário estruturado v3, igual ao de anúncios: pares chave=valor separados por ";",
   * na ordem dos campos da decisão; "texto" é sempre o último e pode ter ";" e "=".
   */
  function parseComentarioV3(txt, campos) {
    var s = String(txt || '').replace(/[\r\n]+/g, ' ').trim();
    var ordem = (campos || []).map(function (c) { return c.k; });
    var r = {}, pos = 0;
    while (s) {
      if (/^texto=/.test(s)) {
        if (ordem.indexOf('texto') < 0) throw new Error('esta decisão não aceita texto');
        r.texto = s.slice(6).trim(); break;
      }
      var i = s.indexOf(';');
      var par = i < 0 ? s : s.slice(0, i);
      s = i < 0 ? '' : s.slice(i + 1).replace(/^\s+/, '');
      var m = par.match(/^(\w+)=(.*)$/);
      if (!m) throw new Error('comentário fora do formato (esperado chave=valor): "' + par + '"');
      var k = m[1], v = m[2].trim(), idx = ordem.indexOf(k);
      if (idx < 0) throw new Error('"' + k + '" não vale para esta decisão');
      if (idx < pos) throw new Error('chaves fora de ordem no comentário (' + ordem.join(', ') + ')');
      pos = idx + 1;
      validarCampoV3(k, v);
      r[k] = v;
    }
    if (r.texto !== undefined) validarCampoV3('texto', r.texto);
    (campos || []).forEach(function (c) { if (c.obrigatorio && !r[c.k]) throw new Error(c.k === 'texto' ? 'escreva o comentário (obrigatório nesta decisão)' : 'falta ' + c.k); });
    return r;
  }
  function montarComentarioV3(o, campos) {
    var p = [];
    (campos || []).forEach(function (c) {
      var v = String(o[c.k] === undefined || o[c.k] === null ? '' : o[c.k]).replace(/[\r\n]+/g, ' ').trim();
      if (v) p.push(c.k + '=' + v);
    });
    return p.join(';');
  }

  /** Confere decisão de módulo v3 contra o modelo recém-lido do Drive. */
  function conferirDecisaoV3(modelo, d) {
    var def = MODULOS_V3[d.modulo];
    var mod = modelo.v3 && modelo.v3[d.modulo];
    if (!def || !mod) throw new Error('o módulo ' + d.modulo + ' não está ativo no painel-fontes.json');
    if (!def.chave || !def.decisoes) throw new Error('o módulo ' + def.rotulo + ' é só leitura');
    if (!CHAVES[def.chave]) throw new Error(AVISO_CHAVE_V3 + ' (' + def.agente + '); nada foi gravado');
    var item = null;
    for (var i = 0; i < mod.itens.length; i++) if (mod.itens[i].item_id === d.item_id) { item = mod.itens[i]; break; }
    if (!item) throw new Error('item ' + d.item_id + ' não existe mais nos arquivos do ' + def.agente);
    var regra = (def.decisoes[item.tipo_item] || {})[d.decisao];
    if (!regra) throw new Error('decisão "' + d.decisao + '" não vale para ' + item.tipo_item);
    if (regra.estados.indexOf(item.estado) < 0) throw new Error('item ' + d.item_id + ' está "' + (item.estado_texto || item.estado) + '" e não aceita esta decisão agora; atualize o painel');
    if (item.snapshot_hash !== d.snapshot_hash) throw new Error('o item ' + d.item_id + ' mudou desde que a tela foi carregada; atualize o painel e confira de novo');
    var pend = item.decisao_pendente;
    if (pend && pend.snapshot_hash === d.snapshot_hash && (!def.repetivel || def.repetivel.indexOf(d.decisao) < 0)) throw new Error('já existe uma decisão enviada para esta versão (' + pend.id + ')');
    parseComentarioV3(d.comentario, regra.campos);
    return { tipo_item: item.tipo_item, versao: String(item.versao || ''), arte_fileId: '', snapshot_hash: item.snapshot_hash };
  }

  /** Monta todos os módulos v3 presentes em fontesV3 ({ id: fontes }). */
  function montarModulosV3(fontesV3, todas, agora) {
    var r = {};
    ORDEM_V3.forEach(function (id) {
      if (!fontesV3 || !fontesV3[id]) return;
      var def = MODULOS_V3[id];
      var dm = decisoesDoModulo(todas, id);
      var m = def.montar(fontesV3[id], dm, agora);
      m.id = id; m.rotulo = m.rotulo || def.rotulo; m.agente = def.agente;
      m.integrado = def.chave ? !!CHAVES[def.chave] : null;
      m.aviso_chave = AVISO_CHAVE_V3;
      m.decisoes_def = def.decisoes || null;
      (m.itens || []).forEach(function (x) { prepararItemV3(x, def, dm); });
      r[id] = m;
    });
    return r;
  }

  /** Começo do texto, sem acento e em minúsculas, para classificar estado livre. */
  function semAcento(s) { return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim(); }
  /** Classifica um texto livre pelo começo: regras = [[regex, estado], ...]. */
  function classificarComeco(txt, regras, padrao) {
    var s = semAcento(txt);
    for (var i = 0; i < regras.length; i++) if (regras[i][0].test(s)) return regras[i][1];
    return padrao === undefined ? 'outro' : padrao;
  }
  function horasEntre(a, b) { return (b.getTime() - a.getTime()) / 3600000; }
  function contarPor(lista, campo) {
    var c = {};
    lista.forEach(function (x) { var k = String(x[campo] || '').trim() || '(sem ' + campo + ')'; c[k] = (c[k] || 0) + 1; });
    return Object.keys(c).map(function (k) { return { nome: k, n: c[k] }; }).sort(function (a, b) { return b.n - a.n || a.nome.localeCompare(b.nome); });
  }
  function mediana(nums) {
    if (!nums.length) return null;
    var s = nums.slice().sort(function (a, b) { return a - b; }), m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  /* ================= v3: Suporte RN Sports ================= */

  /** Texto canônico de Rascunhos-painel.csv (docs/contrato-suporte.md). */
  function canonicoResposta(r) {
    return canonicoV3('resposta', [r.id_chamado, r.versao, r.evento, r.tipo, r.cliente_primeiro_nome, r.pedido_resumo, r.rascunho_texto, r.estado, r.zendesk_link, r.prazo_evento]);
  }
  var CABECALHO_RASCUNHOS_SUPORTE = ['id_chamado', 'versao', 'evento', 'tipo', 'cliente_primeiro_nome', 'pedido_resumo', 'rascunho_texto', 'estado', 'zendesk_link', 'prazo_evento', 'atualizado_em'];
  var ESTADOS_RASCUNHO = [[/^aguardando/, 'aguardando_aprovo'], [/^aprovad/, 'aprovado'], [/^ajuste/, 'ajuste'], [/^recusad/, 'recusado'], [/^enviad/, 'enviado']];

  /** Dias até o evento: prazo_evento (aaaa-mm-dd) ou a data entre parênteses no nome do evento, ex. "(14/11)". */
  function prazoDoEvento(prazo, evento, agora) {
    var txt = String(prazo || '').trim(), origem = 'prazo_evento';
    var d = /^\d{4}-\d{2}-\d{2}/.test(txt) ? parseData(txt) : null;
    if (!d) {
      var m = String(evento || '').match(/\((\d{1,2}\/\d{1,2}(?:\/\d{4})?)\)/);
      if (m) { d = parseData(m[1], agora.getFullYear()); origem = 'evento'; }
    }
    if (!d) return null;
    return { data: diaIso(d), dias: Math.round((soDia(d) - soDia(agora)) / DIA_MS), origem: origem };
  }

  function montarSuporte(f, dm, agora) {
    var L = function (k) { return (f[k] && f[k].linhas) || []; };
    var chamados = L('chamados').filter(function (c) { return String(c.id || '').trim(); });
    var porChamado = {};
    chamados.forEach(function (c) { porChamado[String(c.id).trim()] = c; });
    var abertoSt = function (c) { return /^(open|pending|new|hold)/i.test(String(c.status || '').trim()); };

    // Rascunhos-painel.csv: última versão por chamado
    var ult = {};
    L('rascunhos').forEach(function (r) {
      var id = String(r.id_chamado || '').trim(); if (!id) return;
      if (!ult[id] || (+r.versao || 0) >= (+ult[id].versao || 0)) ult[id] = r;
    });
    var itens = Object.keys(ult).map(function (id) {
      var r = ult[id], ch = porChamado[id] || {};
      var criado = parseData(ch.criado_em);
      var resp = ch.primeira_resposta_em || ch.respondido_em || '';
      return {
        item_id: 'resposta:' + id, tipo_item: 'resposta', id_chamado: id, versao: String(r.versao || '').trim(),
        estado: classificarComeco(r.estado, ESTADOS_RASCUNHO), estado_texto: r.estado,
        evento: r.evento || ch.evento || '', tipo: r.tipo || ch.tipo || '', cliente: r.cliente_primeiro_nome || '',
        pedido_resumo: String(r.pedido_resumo || '').slice(0, 280), rascunho_texto: r.rascunho_texto || '',
        zendesk_link: ehLink(r.zendesk_link) ? String(r.zendesk_link).trim() : '', prazo_evento: r.prazo_evento || '',
        atualizado_em: r.atualizado_em || '', canal: ch.canal || '', status_chamado: ch.status || '',
        criado_em: ch.criado_em || '', espera_horas: criado ? Math.max(0, Math.round(horasEntre(criado, agora))) : null, sem_resposta: !resp,
        prazo: prazoDoEvento(r.prazo_evento, r.evento || ch.evento, agora),
        snapshot_hash: sha256(canonicoResposta(r))
      };
    });
    itens.sort(function (a, b) {
      var pa = a.prazo ? a.prazo.dias : 9999, pb = b.prazo ? b.prazo.dias : 9999;
      return pa - pb || (b.espera_horas || 0) - (a.espera_horas || 0) || a.id_chamado.localeCompare(b.id_chamado);
    });
    var fila = itens.filter(function (x) { return x.estado === 'aguardando_aprovo'; });
    var naFila = {}; itens.forEach(function (x) { naFila[x.id_chamado] = x.estado; });

    // Respostas.csv: rascunhos que existem só no Zendesk (sem texto no painel)
    var ultResp = {};
    L('respostas').forEach(function (r) {
      var id = String(r.id_chamado || '').trim(); if (!id) return;
      var chave = (+r.versao || 0) * 1e13 + ((parseData(r.rascunho_em) || new Date(0)).getTime());
      if (!ultResp[id] || chave >= ultResp[id]._k) ultResp[id] = Object.assign({ _k: chave }, r);
    });
    var semTexto = chamados.filter(function (c) {
      var id = String(c.id).trim(), r = ultResp[id];
      if (!abertoSt(c) || naFila[id]) return false;
      return r ? classificarComeco(r.aprovado, [[/^pendente/, 'p']], '') === 'p' : !!c.rascunho_em && !c.aprovado_em;
    }).map(function (c) {
      var r = ultResp[String(c.id).trim()] || {};
      return { id: String(c.id).trim(), evento: c.evento, tipo: c.tipo, status: c.status, versao: r.versao || '', ultima_acao: c.ultima_acao, proxima_acao: c.proxima_acao, prazo: prazoDoEvento('', c.evento, agora) };
    });

    // Chamados abertos, parados, alertas e primeira resposta
    var abertos = chamados.filter(abertoSt);
    var parados = abertos.map(function (c) {
      var datas = ['criado_em', 'primeira_resposta_em', 'rascunho_em', 'aprovado_em', 'respondido_em'].map(function (k) { return parseData(c[k]); }).filter(Boolean);
      var ultima = datas.length ? new Date(Math.max.apply(null, datas.map(function (d) { return d.getTime(); }))) : null;
      return { id: String(c.id).trim(), evento: c.evento, tipo: c.tipo, status: c.status, ultima_acao: c.ultima_acao, proxima_acao: c.proxima_acao, horas: ultima ? Math.round(horasEntre(ultima, agora)) : null };
    }).filter(function (x) { return x.horas !== null && x.horas > 24; }).sort(function (a, b) { return b.horas - a.horas; });

    var alertas = L('alertas').filter(function (a) { return /^(now|today)$/i.test(String(a.tier || '').trim()); }).map(function (a) {
      return { id: a.alert_id, quando: a.created_at, tier: String(a.tier).trim(), sinais: a.signals, objeto: a.object_id, link: ehLink(a.item_link) ? String(a.item_link).trim() : '', entrega: a.delivery_state, resultado: a.outcome, substituido: /superseded/i.test(a.delivery_state || '') };
    }).sort(function (a, b) { return String(b.quando).localeCompare(String(a.quando)); }).slice(0, 10);

    var semanaIni = new Date(soDia(agora).getTime() - 6 * DIA_MS);
    var daSemana = chamados.filter(function (c) { var d = parseData(c.criado_em); return d && d >= semanaIni && d <= agora; });
    var horas = [], soData = 0, resolvidosSem = 0, aguardando = 0;
    daSemana.forEach(function (c) {
      var t = c.primeira_resposta_em || c.respondido_em;
      var d0 = parseData(c.criado_em), d1 = parseData(t);
      if (d1) {
        if (!/\d{1,2}:\d{2}/.test(t)) { soData++; return; }
        horas.push(Math.max(0, horasEntre(d0, d1)));
      } else if (abertoSt(c)) aguardando++;
      else resolvidosSem++;
    });

    var precisa = [{ rotulo: 'respostas para aprovar', n: fila.length }];
    if (semTexto.length) precisa.push({ rotulo: 'rascunhos só no Zendesk', n: semTexto.length });
    return {
      rascunhos_ativo: !!(f.rascunhos && f.rascunhos.linhas),
      itens: itens, fila: fila.map(function (x) { return x.item_id; }),
      sem_texto: semTexto,
      abertos: { total: abertos.length, por_evento: contarPor(abertos, 'evento'), por_tipo: contarPor(abertos, 'tipo') },
      parados: parados, alertas: alertas,
      primeira_resposta: { de: diaIso(semanaIni), ate: diaIso(agora), criados: daSemana.length, com_hora: horas.length, mediana_horas: horas.length ? arred(mediana(horas)) : null, media_horas: horas.length ? arred(horas.reduce(function (s, x) { return s + x; }, 0) / horas.length) : null, so_data: soData, resolvidos_sem_resposta: resolvidosSem, aguardando: aguardando },
      precisa: { total: precisa.reduce(function (s, p) { return s + p.n; }, 0), partes: precisa }
    };
  }

  registrarModuloV3({
    id: 'suporte', rotulo: 'Suporte RN Sports', agente: 'Agente de Suporte RN Sports', chave: 'SUPORTE_INTEGRADO',
    fontes: {
      chamados: { arquivo: 'Chamados.csv', rotulo: 'Chamados (Suporte)', obrigatorias: ['id', 'status'] },
      respostas: { arquivo: 'Respostas.csv', rotulo: 'Respostas (Suporte)', obrigatorias: ['id_chamado', 'versao'] },
      alertas: { arquivo: 'Alerts.csv', rotulo: 'Alertas (Suporte)', obrigatorias: ['tier'] },
      rascunhos: { arquivo: 'Rascunhos-painel.csv', rotulo: 'Rascunhos para o painel (Suporte)', obrigatorias: CABECALHO_RASCUNHOS_SUPORTE, opcional: true }
    },
    decisoes: {
      resposta: {
        aprovar: { rotulo: 'Aprovar e enviar como está', estados: ['aguardando_aprovo'], campos: [], primario: true },
        refazer: { rotulo: 'Pedir ajuste', estados: ['aguardando_aprovo'], campos: [{ k: 'texto', obrigatorio: true, rotulo: 'O que precisa mudar no rascunho?' }] },
        recusar: { rotulo: 'Recusar', estados: ['aguardando_aprovo'], campos: [{ k: 'texto', obrigatorio: false, rotulo: 'Motivo' }] }
      }
    },
    montar: montarSuporte
  });

  /* ================= v3: E-mails ================= */
  /*
   * Privacidade: o painel mostra só o que já está no Drive (conta, pasta, motivo, remetente,
   * assunto, chegou_em, estado). Nunca corpo nem anexos. Contrato em docs/contrato-emails.md.
   */
  var ESTADOS_MOVIMENTO = [[/^propost/, 'proposto'], [/^aguardando novo sim/, 'proposto'], [/^movid/, 'movido'], [/^recusad/, 'recusado'], [/^(fora da entrada|ja fora da entrada)/, 'fora'], [/^substituid/, 'substituido']];
  var ESTADOS_PENDENCIA = [[/^aberta/, 'aberta'], [/^fechada/, 'fechada'], [/^duplicad/, 'duplicado'], [/^saiu da entrada/, 'saiu']];

  /** Última linha por chave (linhas repetidas: vale a mais abaixo no arquivo). */
  function ultimaPor(linhas, campo) {
    var ordem = [], m = {};
    linhas.forEach(function (x) {
      var k = String(x[campo] || '').trim(); if (!k) return;
      if (!(k in m)) ordem.push(k);
      m[k] = x;
    });
    return ordem.map(function (k) { return m[k]; });
  }
  function ehLote(id) { return /^[a-z]+:lote-/i.test(String(id || '').trim()); }
  /** Quantos e-mails a linha representa: lote "13 e-mails por regras no Mac" = 13; e-mail avulso = 1. */
  function emailsDaLinha(x) {
    if (!ehLote(x.message_id)) return 1;
    var m = String(x.motivo || '').match(/^\s*(\d+)\s+e-?mails?/i);
    return m ? +m[1] : 1;
  }
  function canonicoGrupoEmails(conta, pasta, linhas) {
    var campos = [conta, pasta];
    linhas.slice().sort(function (a, b) { return String(a.message_id).trim() < String(b.message_id).trim() ? -1 : 1; })
      .forEach(function (x) { campos.push(x.message_id, x.motivo, x.proposto_em, x.estado); });
    return canonicoV3('grupo', campos);
  }
  function canonicoPendencia(x) {
    return canonicoV3('pendencia', [x.message_id, x.conta, x.remetente, x.assunto, x.chegou_em, x.motivo, x.precisa_resposta, x.rascunho, x.estado, x.fechado_em]);
  }

  function montarEmails(f, dm, agora) {
    var L = function (k) { return (f[k] && f[k].linhas) || []; };
    var movs = ultimaPor(L('movimentos'), 'message_id');
    movs.forEach(function (x) { x._estado = classificarComeco(x.estado, ESTADOS_MOVIMENTO); });

    // Movimentações propostas, agrupadas por conta + pasta
    var grupos = {}, ordemG = [];
    movs.filter(function (x) { return x._estado === 'proposto'; }).forEach(function (x) {
      var conta = String(x.conta || '').trim(), pasta = String(x.pasta || '').trim();
      var k = conta + '|' + pasta;
      if (!grupos[k]) { grupos[k] = { conta: conta, pasta: pasta, linhas: [], lotes: [] }; ordemG.push(k); }
      (ehLote(x.message_id) ? grupos[k].lotes : grupos[k].linhas).push(x);
    });
    var itens = [];
    ordemG.forEach(function (k) {
      var g = grupos[k];
      // Vários lotes do mesmo destino: vale o mais recente; os antigos aparecem como observação e ficam fora do hash.
      g.lotes.sort(function (a, b) { return (parseData(b.proposto_em) || 0) - (parseData(a.proposto_em) || 0); });
      var validas = g.linhas.concat(g.lotes.slice(0, 1)), antigos = g.lotes.slice(1);
      var ultimo = validas.reduce(function (m, x) { var d = parseData(x.proposto_em); return d && (!m || d > m) ? d : m; }, null);
      itens.push({
        item_id: 'grupo:' + k, tipo_item: 'grupo', versao: '', proposto_em: ultimo ? dataIso(ultimo) : '', estado: 'proposto',
        conta: g.conta, pasta: g.pasta,
        emails: validas.reduce(function (s, x) { return s + emailsDaLinha(x); }, 0),
        linhas: validas.map(function (x) { return { message_id: String(x.message_id).trim(), motivo: x.motivo || '', proposto_em: x.proposto_em || '', estado_texto: x.estado || '', lote: ehLote(x.message_id), emails: emailsDaLinha(x) }; }),
        lotes_antigos: antigos.map(function (x) { return { message_id: String(x.message_id).trim(), motivo: x.motivo || '', proposto_em: x.proposto_em || '', estado_texto: x.estado || '' }; }),
        snapshot_hash: sha256(canonicoGrupoEmails(g.conta, g.pasta, validas))
      });
    });
    itens.sort(function (a, b) { return b.emails - a.emails || a.conta.localeCompare(b.conta) || a.pasta.localeCompare(b.pasta); });

    // Pendências
    var pends = ultimaPor(L('pendencias'), 'message_id').map(function (x) {
      var d = parseData(x.chegou_em);
      return {
        item_id: 'pendencia:' + String(x.message_id).trim(), tipo_item: 'pendencia', versao: '', message_id: String(x.message_id).trim(),
        estado: classificarComeco(x.estado, ESTADOS_PENDENCIA), estado_texto: x.estado || '',
        conta: x.conta || '', remetente: x.remetente || '', assunto: x.assunto || '', chegou_em: x.chegou_em || '',
        motivo: x.motivo || '', precisa_resposta: /^s/i.test(String(x.precisa_resposta || '').trim()), rascunho: x.rascunho || '', fechado_em: x.fechado_em || '',
        dias: d ? Math.max(0, Math.floor((soDia(agora) - soDia(d)) / DIA_MS)) : null,
        snapshot_hash: sha256(canonicoPendencia(x))
      };
    });
    var abertas = pends.filter(function (x) { return x.estado === 'aberta'; }).sort(function (a, b) {
      return (b.precisa_resposta - a.precisa_resposta) || ((b.dias || 0) - (a.dias || 0)) || a.remetente.localeCompare(b.remetente);
    });
    itens = itens.concat(abertas);

    // Alertas recentes (todos os tiers, os mais novos primeiro)
    var alertas = L('alertas').filter(function (a) { return String(a.alert_id || a.subject || '').trim(); }).map(function (a, i) {
      return { id: a.alert_id || '', i: i, quando: a.created_at || '', tier: String(a.tier || '').trim(), assunto: a.subject || '', sinais: a.signals || '', score: a.score || '', enviado: a.sent || '', motivo: a.reason || '', resultado: a.outcome || '' };
    }).sort(function (a, b) { return ((parseData(b.quando) || 0) - (parseData(a.quando) || 0)) || b.i - a.i; });
    var semana = new Date(soDia(agora).getTime() - 6 * DIA_MS);
    var daSemana = alertas.filter(function (a) { var d = parseData(a.quando); return d && d >= semana; });

    // Rascunhos (quando houver), com remetente e assunto da pendência do mesmo message_id
    var porMsg = {}; pends.forEach(function (x) { porMsg[x.message_id] = x; });
    var rascunhos = L('rascunhos').filter(function (r) { return String(r.draft_id || r.message_id || '').trim(); }).map(function (r) {
      var p = porMsg[String(r.message_id || '').trim()] || {};
      return { draft_id: r.draft_id || '', message_id: r.message_id || '', conta: r.conta || p.conta || '', criado_em: r.criado_em || '', chegou_em: r.chegou_em || '', estado: r.estado || '', resultado: r.resultado || '', remetente: p.remetente || '', assunto: p.assunto || '' };
    });

    var precisa = [{ rotulo: 'grupos de movimentação para aprovar', n: ordemG.length }, { rotulo: 'pendências abertas', n: abertas.length }];
    var pc = contarPor(movs.map(function (x) { return { e: x._estado }; }), 'e');
    return {
      itens: itens,
      grupos: ordemG.length, emails_propostos: itens.filter(function (x) { return x.tipo_item === 'grupo'; }).reduce(function (s, x) { return s + x.emails; }, 0),
      abertas: abertas.map(function (x) { return x.item_id; }),
      pendencias: { total: pends.length, abertas: abertas.length, precisam_resposta: abertas.filter(function (x) { return x.precisa_resposta; }).length, por_estado: contarPor(pends, 'estado') },
      movimentos: { linhas: L('movimentos').length, unicos: movs.length, por_estado: pc },
      alertas: alertas.slice(0, 10), alertas_semana: { total: daSemana.length, por_tier: contarPor(daSemana, 'tier') },
      rascunhos: rascunhos,
      precisa: { total: precisa.reduce(function (s, p) { return s + p.n; }, 0), partes: precisa }
    };
  }

  registrarModuloV3({
    id: 'emails', rotulo: 'E-mails', agente: 'Gestor de E-mails', chave: 'EMAILS_INTEGRADO',
    fontes: {
      movimentos: { arquivo: 'Movimentos.csv', rotulo: 'Movimentos (E-mails)', obrigatorias: ['message_id', 'conta', 'pasta', 'motivo', 'proposto_em', 'estado'] },
      pendencias: { arquivo: 'Pendencias.csv', rotulo: 'Pendências (E-mails)', obrigatorias: ['message_id', 'conta', 'remetente', 'assunto', 'estado'] },
      alertas: { arquivo: 'Alerts.csv', rotulo: 'Alertas (E-mails)', obrigatorias: ['tier'], opcional: true },
      rascunhos: { arquivo: 'Rascunhos.csv', rotulo: 'Rascunhos (E-mails)', obrigatorias: ['message_id', 'estado'], opcional: true }
    },
    decisoes: {
      grupo: {
        aprovar: { rotulo: 'Aprovar o grupo', estados: ['proposto'], campos: [{ k: 'texto', obrigatorio: false, rotulo: 'Comentário' }], primario: true },
        recusar: { rotulo: 'Recusar', estados: ['proposto'], campos: [{ k: 'texto', obrigatorio: false, rotulo: 'Motivo' }] }
      },
      pendencia: {
        resolvida: { rotulo: 'Marcar como resolvida', estados: ['aberta'], campos: [{ k: 'texto', obrigatorio: false, rotulo: 'Comentário' }], primario: true },
        pedir_rascunho: { rotulo: 'Pedir rascunho', estados: ['aberta'], campos: [{ k: 'texto', obrigatorio: false, rotulo: 'O que a resposta deve dizer?' }] }
      }
    },
    montar: montarEmails
  });

  /* ================= v3: Finanças ================= */

  var ESTADOS_CONTA = [[/^a pagar/, 'a_pagar'], [/^pag[oa]/, 'pago'], [/^(em atraso|atrasad|vencid)/, 'atraso'], [/^sem confirma/, 'sem_confirmacao']];

  /** "2.468,10", "1469,05", "-48,32", "R$ 10", "12.5" -> número; "a informar" -> null. */
  function numBr(txt) {
    var s = String(txt === null || txt === undefined ? '' : txt).replace(/R\$|\s/g, '');
    if (/^-?\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(s) || /^-?\d+,\d{1,2}$/.test(s)) return +s.replace(/\./g, '').replace(',', '.');
    if (/^-?\d+(\.\d{1,2})?$/.test(s)) return +s;
    return null;
  }

  /**
   * Conserta a linha em que um valor "R$ 321,45" foi escrito sem aspas: a vírgula dos centavos
   * partiu o campo em dois e empurrou os seguintes uma coluna para a direita (a última coluna, sem nome,
   * recebe o que sobrou). Junta "...R$ 321" com "66..." e puxa os campos de volta.
   */
  function consertarLinha(o, cab) {
    // Só no formato atual (última coluna sem nome). No formato novo o CSV vem com aspas e nada é mexido.
    if (!cab.length || String(cab[cab.length - 1]).trim() !== '') return o;
    var l = cab.map(function (k) { return o[k] === undefined ? '' : String(o[k]); });
    var mudou = false;
    for (var i = 0; i < l.length - 1; i++) {
      if (/R\$\s?[\d.]+$/.test(l[i]) && /^\d{2}(?!\d)/.test(l[i + 1])) { l.splice(i, 2, l[i] + ',' + l[i + 1]); l.push(''); mudou = true; }
    }
    if (!mudou) return o;
    var r = {};
    cab.forEach(function (k, j) { r[k] = String(l[j] || '').trim(); });
    r._consertada = true;
    return r;
  }

  /** Código de pagamento: Pix copia e cola, linha digitável/código de barras ou outro texto. */
  function tipoCodigo(c) {
    var s = String(c || '').trim();
    if (/^000201/.test(s)) return 'pix';
    if (s.replace(/\D/g, '').length >= 44 && /^[\d\s.\-]+$/.test(s)) return 'barras';
    return s ? 'texto' : '';
  }

  /** Tira do texto mostrado os tokens que o painel já extraiu (message_id gmail:/outlook:/icloud: e "pdf <fileId>"). */
  function limparTokens(t) {
    return String(t || '').replace(/\b(gmail|outlook|icloud):[^\s;,()]+/g, '').replace(/\bpdf\s+[A-Za-z0-9_-]{25,}/g, '')
      .replace(/\(\s*\)/g, '').replace(/\s*;\s*(?=;|$)/g, '').replace(/^\s*;\s*/, '').replace(/\s{2,}/g, ' ').replace(/\s+([;,.)])/g, '$1').trim();
  }
  function canonicoConta(x) {
    return canonicoV3('conta', [x.emissor, x.mes_ref, x.valor_texto, x.vencimento, x.forma, x.estado_texto, x.link, x.pago_em, x.codigo, x.pdf_fileId]);
  }
  /** Formato atual: 5 campos. Formato novo (Rateios.csv com emissor e pagaram; 'pagantes' também vale): os dois entram no fim. */
  function canonicoRateio(r, novo) {
    var c = [r.mes_ref, r.total, r.por_pessoa, r.enviado, r.recebidos];
    if (novo) c = c.concat([r.emissor, r.pagaram !== undefined ? r.pagaram : r.pagantes]);
    return canonicoV3('rateio', c);
  }
  /** "Ana; João, Rita" -> ['Ana', 'João', 'Rita']. */
  function listaNomes(t) { return String(t || '').split(/[;,]/).map(function (x) { return x.trim(); }).filter(Boolean); }

  function resumoMes(linhas) {
    var r = { entradas: 0, saidas: 0, essenciais: 0, nao_essenciais: 0, pessoal: 0, empresa: 0, sem_dono: 0, a_pagar: 0, a_pagar_valor: 0, lancamentos: linhas.length, sem_valor: 0, cat: {} };
    linhas.forEach(function (x) {
      if (x.valor === null) { r.sem_valor++; return; }
      if (x.tipo === 'entrada') { r.entradas += x.valor; return; }
      r.saidas += x.valor;
      if (x.essencial === 's') r.essenciais += x.valor; else r.nao_essenciais += x.valor;
      if (x.dono === 'pessoal') r.pessoal += x.valor; else if (x.dono === 'empresa') r.empresa += x.valor; else r.sem_dono += x.valor;
      if (x.a_pagar) { r.a_pagar++; r.a_pagar_valor += x.valor; }
      var c = r.cat[x.categoria] || (r.cat[x.categoria] = { nome: x.categoria, valor: 0, n: 0, essencial: 0 });
      c.valor += x.valor; c.n++; if (x.essencial === 's') c.essencial += x.valor;
    });
    var cats = Object.keys(r.cat).map(function (k) { var c = r.cat[k]; return { nome: c.nome, valor: arred(c.valor), n: c.n, essencial: arred(c.essencial) }; })
      .sort(function (a, b) { return b.valor - a.valor || a.nome.localeCompare(b.nome); });
    ['entradas', 'saidas', 'essenciais', 'nao_essenciais', 'pessoal', 'empresa', 'sem_dono', 'a_pagar_valor'].forEach(function (k) { r[k] = arred(r[k]); });
    r.saldo = arred(r.entradas - r.saidas);
    delete r.cat; r.categorias = cats;
    return r;
  }

  function montarFinancas(f, dm, agora) {
    var L = function (k) { return (f[k] && f[k].linhas) || []; };
    var hoje = soDia(agora), consertadas = 0;

    // contas-recebidas: código Pix/barras e PDF, ligados à conta pelo message_id citado no texto da conta
    var recebidas = L('recebidas').filter(function (r) { return String(r.emissor || r.message_id || '').trim(); }).map(function (r) {
      return { recebido_em: r.recebido_em || '', caixa: r.caixa || '', emissor: r.emissor || '', tipo: r.tipo || '', valor_texto: r.valor || '', valor: numBr(r.valor), vencimento: r.vencimento || '',
        codigo: String(r.codigo_ou_pix || '').trim(), tipo_codigo: tipoCodigo(r.codigo_ou_pix), pdf_fileId: String(r.pdf_fileId || '').trim(), message_id: String(r.message_id || '').trim(), ligada: false };
    });

    var cabC = (f.contas && f.contas.cabecalho) || [];
    var contas = ultimaPor(L('contas').map(function (o) { var r = consertarLinha(o, cabC); if (r !== o) consertadas++; return r; })
      .filter(function (x) { return String(x.emissor || '').trim(); }).map(function (x) { x._k = String(x.emissor).trim() + '|' + String(x.mes_ref || '').trim(); return x; }), '_k').map(function (x) {
      var texto = [x.link, x.estado].join(' ');
      var rec = null, mid = String(x.message_id || '').trim();
      // Formato novo: coluna message_id; formato atual: message_id citado no texto de link/estado.
      recebidas.forEach(function (r) { if (r.message_id && (mid ? r.message_id === mid : texto.indexOf(r.message_id) >= 0)) { rec = r; r.ligada = true; } });
      var pdf = String(x.pdf_fileId || '').trim() || (String(x.link || '').match(/\bpdf\s+([A-Za-z0-9_-]{25,})/) || [])[1] || (rec && rec.pdf_fileId) || '';
      var codCol = String(x.codigo || '').trim(), tipoCol = tipoCodigo(codCol);
      var codigo = tipoCol === 'pix' || tipoCol === 'barras' ? codCol : rec && (rec.tipo_codigo === 'pix' || rec.tipo_codigo === 'barras') ? rec.codigo : '';
      var tipoCod = codigo ? tipoCodigo(codigo) : '';
      var codObs = tipoCol === 'texto' ? codCol : rec && rec.tipo_codigo === 'texto' ? rec.codigo : '';
      var venc = parseData(x.vencimento);
      var est = classificarComeco(x.estado, ESTADOS_CONTA);
      var dias = venc ? Math.round((soDia(venc) - hoje) / DIA_MS) : null;
      var situacao = est === 'pago' ? 'pago' : est === 'atraso' || (est === 'a_pagar' && dias !== null && dias < 0) ? 'atraso' : est === 'sem_confirmacao' ? 'sem_confirmacao' : est === 'a_pagar' ? 'a_pagar' : 'outro';
      var pago = parseData(x.pago_em);
      var c = {
        item_id: 'conta:' + x._k, tipo_item: 'conta', versao: '', estado: est, estado_texto: String(x.estado || '').trim(), estado_mostrado: limparTokens(x.estado), link_mostrado: limparTokens(x.link), situacao: situacao,
        emissor: String(x.emissor).trim(), mes_ref: String(x.mes_ref || '').trim(), valor_texto: String(x.valor || '').trim(), valor: numBr(x.valor),
        vencimento: String(x.vencimento || '').trim(), dias: dias, forma: String(x.forma || '').trim(), link: String(x.link || '').trim(),
        pago_em: pago ? diaIso(pago) : '', pago_em_texto: String(x.pago_em || '').trim(),
        codigo: codigo, tipo_codigo: tipoCod, codigo_obs: codObs, pdf_fileId: pdf, message_id: mid || (rec ? rec.message_id : ''),
        recebida: rec ? { caixa: rec.caixa, recebido_em: rec.recebido_em } : null, consertada: !!x._consertada
      };
      c.snapshot_hash = sha256(canonicoConta(c));
      return c;
    });
    var abertas = contas.filter(function (c) { return c.situacao !== 'pago'; }).sort(function (a, b) {
      var o = { atraso: 0, sem_confirmacao: 1, a_pagar: 2, outro: 3 };
      return (o[a.situacao] - o[b.situacao]) || ((a.dias === null ? 9999 : a.dias) - (b.dias === null ? 9999 : b.dias)) || a.emissor.localeCompare(b.emissor);
    });
    var urgentes = abertas.filter(function (c) { return c.situacao === 'atraso' || c.situacao === 'sem_confirmacao'; });
    var proximas = abertas.filter(function (c) { return c.situacao !== 'atraso' && c.situacao !== 'sem_confirmacao' && c.dias !== null && c.dias >= 0 && c.dias <= 30; });
    var depois = abertas.filter(function (c) { return urgentes.indexOf(c) < 0 && proximas.indexOf(c) < 0; });
    var pagas = contas.filter(function (c) { return c.situacao === 'pago'; }).sort(function (a, b) { return String(b.pago_em || b.vencimento).localeCompare(String(a.pago_em || a.vencimento)); });
    var semana = proximas.filter(function (c) { return c.dias <= 7; });
    var soma = function (l) { return arred(l.reduce(function (s, c) { return s + (c.valor || 0); }, 0)); };

    // Recebidas no e-mail sem conta na lista, com código para pagar (últimos 30 dias)
    var soltas = recebidas.filter(function (r) {
      var d = parseData(r.recebido_em);
      return !r.ligada && (r.tipo_codigo === 'pix' || r.tipo_codigo === 'barras') && d && (hoje - soDia(d)) / DIA_MS <= 30;
    });

    // Lançamentos por mês
    var lanc = L('lancamentos').filter(function (x) { return /^\d{4}-\d{2}/.test(String(x.data || '').trim()); }).map(function (x) {
      return { mes: String(x.data).trim().slice(0, 7), categoria: String(x.categoria || '').trim() || 'Sem categoria', essencial: /^s/i.test(String(x.essencial || '').trim()) ? 's' : 'n',
        tipo: /^entrada/i.test(semAcento(x.tipo)) ? 'entrada' : 'saida', valor: numBr(x.valor), dono: semAcento(x.dono), a_pagar: /^a pagar/.test(semAcento(x.estado)) };
    });
    var porMes = {};
    lanc.forEach(function (x) { (porMes[x.mes] = porMes[x.mes] || []).push(x); });
    var mesHoje = diaIso(agora).slice(0, 7);
    var meses = Object.keys(porMes).sort().map(function (m) { var r = resumoMes(porMes[m]); r.mes = m; return r; });
    var mesAtual = porMes[mesHoje] ? mesHoje : (meses.length ? meses[meses.length - 1].mes : '');

    // Rateio SKY: a linha mais recente
    var rateios = L('rateios').filter(function (r) { return String(r.mes_ref || '').trim(); }).sort(function (a, b) { return String(a.mes_ref).localeCompare(String(b.mes_ref)); });
    var rateio = null, itensRateio = [];
    if (rateios.length) {
      var r = rateios[rateios.length - 1];
      var cabR = (f.rateios && f.rateios.cabecalho) || [];
      var novo = cabR.indexOf('emissor') >= 0 || cabR.indexOf('pagaram') >= 0 || cabR.indexOf('pagantes') >= 0;
      var pagaram = listaNomes(r.pagaram !== undefined ? r.pagaram : r.pagantes);
      var m = String(r.recebidos || '').match(/(\d+)\s*\/\s*(\d+)/);
      var rec = m ? Math.max(+m[1], pagaram.length) : pagaram.length, de = m ? +m[2] : null;
      var enviado = /^s/i.test(String(r.enviado || '').trim());
      rateio = {
        item_id: 'rateio:' + String(r.mes_ref).trim(), tipo_item: 'rateio', versao: '', mes_ref: String(r.mes_ref).trim(),
        total_texto: r.total || '', total: numBr(r.total), por_pessoa_texto: r.por_pessoa || '', por_pessoa: numBr(r.por_pessoa),
        enviado: enviado, enviado_texto: String(r.enviado || '').trim(), recebidos: rec, emissor: String(r.emissor || '').trim() || 'SKY', pagaram: pagaram, formato_novo: novo, de: de, recebidos_texto: String(r.recebidos || '').trim(),
        estado: !enviado ? 'nao_enviado' : de !== null && rec >= de ? 'completo' : 'aberto',
        anteriores: rateios.length - 1
      };
      rateio.snapshot_hash = sha256(canonicoRateio(r, novo));
      itensRateio = [rateio];
    }

    var tabela = function (k) { var o = f[k]; return o ? { colunas: (o.cabecalho || []).filter(Boolean), linhas: o.linhas || [] } : null; };
    var alertas = L('alertas').filter(function (a) { return String(a.alert_id || a.item_link || '').trim(); }).map(function (a, i) {
      return { id: a.alert_id || '', i: i, quando: a.created_at || '', tier: String(a.tier || '').trim(), assunto: a.item_link || '', objeto: a.object_id || '', sinais: a.signals || '', score: a.score || '', obs: a.suppressed_reason || '', resultado: String(a.outcome || '').trim(), base: a.outcome_basis || '' };
    }).sort(function (a, b) { return ((parseData(b.quando) || 0) - (parseData(a.quando) || 0)) || b.i - a.i; });
    var recorrentes = L('recorrentes').filter(function (x) { return String(x.emissor || '').trim(); }).map(function (x) {
      return { emissor: x.emissor, caixa: x.caixa || '', dia: x.dia_tipico || '', valor: x.valor_medio || '', forma: x.forma || '', categoria: x.categoria || '' };
    });

    var precisa = [
      { rotulo: urgentes.length === 1 ? 'conta atrasada ou sem confirmação' : 'contas atrasadas ou sem confirmação', n: urgentes.length },
      { rotulo: semana.length === 1 ? 'conta vence em 7 dias' : 'contas vencem em 7 dias', n: semana.length },
      { rotulo: 'rateio ' + (rateio ? rateio.emissor : 'SKY') + ' esperando', n: rateio && rateio.estado === 'aberto' ? 1 : 0 }
    ];
    return {
      itens: abertas.concat(itensRateio),
      contas: { urgentes: urgentes.map(function (c) { return c.item_id; }), proximas: proximas.map(function (c) { return c.item_id; }), depois: depois.map(function (c) { return c.item_id; }),
        total: contas.length, abertas: abertas.length, valor_urgente: soma(urgentes), valor_30d: soma(proximas), valor_semana: soma(semana), sem_valor: abertas.filter(function (c) { return c.valor === null; }).length,
        pagas: pagas.slice(0, 8).map(function (c) { return { emissor: c.emissor, mes_ref: c.mes_ref, valor: c.valor, valor_texto: c.valor_texto, pago_em: c.pago_em, estado_texto: c.estado_texto }; }), pagas_total: pagas.length,
        consertadas: consertadas },
      recebidas_soltas: soltas.map(function (r) { return { emissor: r.emissor, caixa: r.caixa, recebido_em: r.recebido_em, valor: r.valor, valor_texto: r.valor_texto, vencimento: r.vencimento, codigo: r.codigo, tipo_codigo: r.tipo_codigo, pdf_fileId: r.pdf_fileId }; }),
      meses: meses, mes_atual: mesAtual,
      rateio: rateio ? rateio.item_id : '',
      fechamentos: tabela('fechamentos'), orcamento: tabela('orcamento'),
      alertas: alertas.slice(0, 10), alertas_pendentes: alertas.filter(function (a) { return /^pending/i.test(a.resultado); }).length,
      recorrentes: recorrentes,
      precisa: { total: precisa.reduce(function (s, p) { return s + p.n; }, 0), partes: precisa }
    };
  }

  registrarModuloV3({
    id: 'financas', rotulo: 'Finanças', agente: 'Assistente Financeiro', chave: 'FINANCAS_INTEGRADO',
    fontes: {
      contas: { arquivo: 'Contas.csv', rotulo: 'Contas (Finanças)', obrigatorias: ['emissor', 'mes_ref', 'valor', 'vencimento', 'estado'] },
      recebidas: { arquivo: 'contas-recebidas.csv', rotulo: 'Contas recebidas (Finanças)', obrigatorias: ['emissor', 'codigo_ou_pix', 'message_id'], opcional: true },
      lancamentos: { arquivo: 'Lancamentos.csv', rotulo: 'Lançamentos (Finanças)', obrigatorias: ['data', 'categoria', 'essencial', 'tipo', 'valor'] },
      recorrentes: { arquivo: 'Recorrentes.csv', rotulo: 'Recorrentes (Finanças)', obrigatorias: ['emissor'], opcional: true },
      rateios: { arquivo: 'Rateios.csv', rotulo: 'Rateios (Finanças)', obrigatorias: ['mes_ref', 'recebidos'], opcional: true },
      fechamentos: { arquivo: 'Fechamentos.csv', rotulo: 'Fechamentos (Finanças)', obrigatorias: [], opcional: true },
      orcamento: { arquivo: 'Orcamento.csv', rotulo: 'Orçamento (Finanças)', obrigatorias: [], opcional: true },
      alertas: { arquivo: 'Alerts.csv', rotulo: 'Alertas (Finanças)', obrigatorias: ['tier'], opcional: true }
    },
    decisoes: {
      conta: {
        paguei: { rotulo: 'Paguei', estados: ['a_pagar', 'atraso', 'sem_confirmacao', 'outro'], campos: [{ k: 'data', obrigatorio: false, rotulo: 'Data do pagamento' }, { k: 'valor', obrigatorio: false, rotulo: 'Valor pago (R$)' }, { k: 'texto', obrigatorio: false, rotulo: 'Comentário' }], primario: true }
      },
      rateio: {
        recebi_mais_um: { rotulo: 'Recebi de mais um', estados: ['aberto'], campos: [{ k: 'texto', obrigatorio: false, rotulo: 'De quem?' }], primario: true }
      }
    },
    montar: montarFinancas
  });

  /* ---------- v3: Investimentos (Analista de Investimentos) ---------- */
  /** Número com ponto decimal e qualquer casa ("0.00531465", "5.5056") ou no formato BR (numBr). */
  function numDec(t) { var x = String(t === null || t === undefined ? '' : t).trim(); return /^-?\d+\.\d+$/.test(x) || /^-?\d+$/.test(x) ? +x : numBr(x); }

  var ESTADOS_APORTE = [[/^confirmad/, 'confirmado'], [/^(nao fiz|nao feito|cancelad|desistiu)/, 'nao_feito']];

  /**
   * Hora da cotação em horário de Brasília: "2026-11-06 16:17 BRT", "2026-11-06 16:00 NY" (NY = BRT - 2 h
   * no horário de inverno de lá) ou só a data (ação dos EUA: fechamento às 18:00 BRT; outros: 00:00).
   */
  function quandoPreco(txt, moeda) {
    var s = String(txt || '').trim();
    var m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{1,2}):(\d{2}))?\s*([A-Za-z]+)?/);
    if (!m) return null;
    var h = m[4] ? +m[4] : (moeda === 'USD' ? 18 : 0), mi = m[5] ? +m[5] : 0;
    if (m[4] && /^NY$/i.test(m[6] || '')) h += 2;
    return new Date(+m[1], +m[2] - 1, +m[3], h, mi);
  }

  function canonicoAporte(a) { return canonicoV3('aporte', [a.data, a.destino, a.categoria_arca, a.ativo, a.valor_brl, a.origem, a.estado_texto]); }

  /** Série de preços por ativo, em ordem de hora; pontos intradiários ("não é fechamento") ficam marcados. */
  function seriesPrecos(linhas) {
    var s = {};
    linhas.forEach(function (x, i) {
      var ativo = String(x.ativo || '').trim(), v = numDec(x.fechamento), moeda = String(x.moeda || '').trim();
      var q = quandoPreco(x.data, moeda);
      if (!ativo || v === null || !q) return;
      (s[ativo] = s[ativo] || []).push({ quando: dataIso(q), t: q.getTime(), i: i, valor: v, moeda: moeda, fonte: String(x.fonte || '').trim(),
        intradiario: /intradi|nao e fechamento/.test(semAcento(x.fonte)) });
    });
    Object.keys(s).forEach(function (k) {
      // mesma hora repetida: vale a última linha do arquivo
      var por = {};
      s[k].forEach(function (p) { por[p.t] = p; });
      s[k] = Object.keys(por).map(function (t) { return por[t]; }).sort(function (a, b) { return a.t - b.t || a.i - b.i; });
    });
    return s;
  }

  function resumoAtivo(serie, nome) {
    var pts = (serie || []).filter(function (p) { return !p.intradiario; });
    if (!pts.length) return null;
    var ult = pts[pts.length - 1], ant = pts.length > 1 ? pts[pts.length - 2] : null, pri = pts[0];
    var pct = function (a, b) { return b ? arred((a / b - 1) * 100) : null; };
    return { ativo: nome, ultimo: ult.valor, moeda: ult.moeda, quando: ult.quando, fonte: ult.fonte,
      anterior: ant ? ant.valor : null, anterior_quando: ant ? ant.quando : '', var_pct: ant ? pct(ult.valor, ant.valor) : null,
      inicio: pri.valor, inicio_quando: pri.quando, var_periodo_pct: pts.length > 1 ? pct(ult.valor, pri.valor) : null,
      pontos: pts.slice(-30).map(function (p) { return { quando: p.quando, valor: p.valor }; }),
      intradiarios_fora: (serie || []).length - pts.length };
  }

  function montarInvestimentos(f, dm, agora) {
    var L = function (k) { return (f[k] && f[k].linhas) || []; };
    var hoje = soDia(agora), mesHoje = diaIso(agora).slice(0, 7);
    var series = seriesPrecos(L('precos'));
    var ultimo = function (a) { var s = series[a]; return s && s.length ? s[s.length - 1].valor : null; };
    var usdbrl = ultimo('USDBRL');
    var btc = resumoAtivo(series.BTCBRL, 'BTC'), btcUsd = resumoAtivo(series.BTCUSD, 'BTCUSD'), aapl = resumoAtivo(series.AAPL, 'AAPL');
    var precoAgora = function (ativo, moeda) {
      if (ativo === 'BTC') return moeda === 'USD' ? ultimo('BTCUSD') : ultimo('BTCBRL');
      return ultimo(ativo);
    };

    // Posições: valor ao último preço, em reais
    var posicoes = L('posicoes').filter(function (x) { return String(x.ativo || '').trim(); }).map(function (x) {
      var qtd = numDec(x.quantidade), moeda = String(x.moeda || '').trim() || 'BRL', pm = numDec(x.preco_medio);
      var p = qtd !== null ? precoAgora(String(x.ativo).trim(), moeda) : null;
      var pBrl = p === null ? null : moeda === 'USD' ? (usdbrl ? p * usdbrl : null) : p;
      return { ativo: String(x.ativo).trim(), plataforma: String(x.plataforma || '').trim(), categoria: String(x.categoria_arca || '').trim(),
        quantidade: qtd, quantidade_texto: String(x.quantidade || '').trim(), preco_medio: pm, moeda: moeda, custo_total: numDec(x.custo_total),
        preco_atual: p, valor_brl: qtd !== null && pBrl !== null ? arred(qtd * pBrl) : null,
        ganho_pct: p !== null && pm ? arred((p / pm - 1) * 100) : null,
        data: String(x.data || '').trim(), notas: String(x.notas || '').trim(), estado: String(x.estado || '').trim() };
    });

    // Carteira ARCA: linhas da data mais recente de Metas_ARCA
    var metas = L('metas').filter(function (x) { return /^\d{4}-\d{2}-\d{2}/.test(String(x.data || '').trim()); });
    var dataMeta = metas.reduce(function (d, x) { var t = String(x.data).trim().slice(0, 10); return t > d ? t : d; }, '');
    var daData = metas.filter(function (x) { return String(x.data).trim().slice(0, 10) === dataMeta; });
    var arca = [], fora = [];
    daData.forEach(function (x) {
      var meta = numDec(x.meta_pct), o = { categoria: String(x.categoria || '').trim(), valor: numDec(x.valor_brl), valor_texto: String(x.valor_brl || '').trim(),
        peso_pct: numDec(x.peso_pct), meta_pct: meta, meta_texto: String(x.meta_pct || '').trim() };
      (meta !== null ? arca : fora).push(o);
    });
    var totalArca = arred(arca.reduce(function (s, x) { return s + (x.valor || 0); }, 0));
    arca.forEach(function (x) {
      x.peso_pct = x.peso_pct !== null ? x.peso_pct : (totalArca ? arred(x.valor / totalArca * 100) : 0);
      x.dif_pp = arred(x.peso_pct - x.meta_pct);
      x.falta_brl = totalArca ? arred(x.meta_pct / 100 * totalArca - (x.valor || 0)) : null;
    });
    var somaMeta = arca.reduce(function (s, x) { return s + x.meta_pct; }, 0);
    // Valor das posições ARCA ao último preço, por categoria (comparação com o Metas_ARCA do agente)
    var hojePorCat = {};
    posicoes.forEach(function (p) { if (p.valor_brl !== null) hojePorCat[p.categoria] = arred((hojePorCat[p.categoria] || 0) + p.valor_brl); });

    // Recomendações: mais recentes primeiro
    var recs = L('recomendacoes').filter(function (x) { return String(x.ativo || '').trim() && /^\d{4}-\d{2}-\d{2}/.test(String(x.data || '').trim()); }).map(function (x, i) {
      var d = parseData(x.data), ativo = String(x.ativo).trim(), preco = numDec(x.preco);
      var agoraP = ativo === 'BTC' ? ultimo('BTCUSD') : ultimo(ativo);
      var vence = d ? new Date(d.getTime() + 30 * DIA_MS) : null;
      return { i: i, data: String(x.data).trim().slice(0, 10), ativo: ativo, preco: preco, sinal: String(x.sinal || '').trim().toUpperCase(), score: String(x.score || '').trim(),
        motivo: String(x.motivo || '').trim(), resultado_30d: String(x.resultado_30d || '').trim(), vence_30d: vence ? diaIso(vence) : '',
        desde_pct: preco && agoraP !== null ? arred((agoraP / preco - 1) * 100) : null };
    }).sort(function (a, b) { return b.data.localeCompare(a.data) || b.i - a.i; });
    var ultimaRec = {};
    recs.forEach(function (r) { if (!ultimaRec[r.ativo]) ultimaRec[r.ativo] = r; });

    // Previdência: última linha; anterior para comparar
    var prev = L('previdencia').filter(function (x) { return String(x.data_ref || '').trim(); }).map(function (x) {
      var ref = String(x.data_ref).trim(), m = ref.match(/^(\d{4}-\d{2}(?:-\d{2})?)\s*(?:\((.*)\))?/);
      return { ref: m ? m[1] : ref, obs: m && m[2] ? m[2].trim() : '', ref_texto: ref, saldo: numDec(x.saldo_oficial), aporte_pessoal: numDec(x.aporte_pessoal),
        aporte_empresa: numDec(x.aporte_empresa), rendimento: numDec(x.rendimento), rentabilidade_pct: String(x.rentabilidade_pct || '').trim() };
    });
    var previdencia = prev.length ? Object.assign({}, prev[prev.length - 1], { anterior: prev.length > 1 ? prev[prev.length - 2] : null, linhas: prev.length }) : null;

    // Reserva: última linha (a de data maior; empate = a mais abaixo no arquivo)
    var res = L('reserva').filter(function (x) { return String(x.data || '').trim(); }).map(function (x, i) {
      return { i: i, data: String(x.data).trim(), saldo: numDec(x.saldo), aporte: numDec(x.aporte), produto: String(x.produto || '').trim() };
    }).sort(function (a, b) { return a.data.localeCompare(b.data) || a.i - b.i; });
    var notaReserva = '';
    posicoes.forEach(function (p) { if (/reserva/i.test(p.ativo)) notaReserva = p.notas; });
    var reserva = res.length ? Object.assign({}, res[res.length - 1], { nota: notaReserva }) : null;

    // Aportes: os do mês e os que esperam confirmação (aceitam decisão)
    var aportes = L('aportes').filter(function (x) { return String(x.data || '').trim() && String(x.destino || x.ativo || '').trim(); }).map(function (x, i) {
      var et = String(x.estado || '').trim();
      var a = { i: i, data: String(x.data).trim(), destino: String(x.destino || '').trim(), categoria_arca: String(x.categoria_arca || '').trim(), ativo: String(x.ativo || '').trim(),
        valor_brl: String(x.valor_brl || '').trim(), valor: numDec(x.valor_brl), origem: String(x.origem || '').trim(), estado_texto: et, estado: classificarComeco(et, ESTADOS_APORTE, 'pendente') };
      a.item_id = 'aporte:' + a.data + '|' + a.destino + '|' + a.origem;
      a.tipo_item = 'aporte'; a.versao = '';
      a.snapshot_hash = sha256(canonicoAporte(a));
      return a;
    });
    aportes = ultimaPor(aportes, 'item_id');
    var pendentes = aportes.filter(function (a) { return a.estado === 'pendente'; }).sort(function (a, b) { return a.data.localeCompare(b.data); });
    var doMes = aportes.filter(function (a) { return a.data.slice(0, 7) === mesHoje; }).sort(function (a, b) { return b.data.localeCompare(a.data) || b.i - a.i; });
    var somaMes = arred(doMes.reduce(function (s, a) { return s + (a.estado === 'confirmado' && a.valor ? a.valor : 0); }, 0));

    var alertas = L('alertas').filter(function (a) { return String(a.alert_id || a.item_link || '').trim(); }).map(function (a, i) {
      return { id: a.alert_id || '', i: i, quando: a.created_at || '', tier: String(a.tier || '').trim(), assunto: a.item_link || '', objeto: a.object_id || '', sinais: a.signals || '', resultado: String(a.outcome || '').trim() };
    }).sort(function (a, b) { return ((parseData(b.quando) || 0) - (parseData(a.quando) || 0)) || b.i - a.i; });
    var nowPend = alertas.filter(function (a) { return /^now/i.test(a.tier) && (!a.resultado || /^pending/i.test(a.resultado)); }).length;

    var precisa = [
      { rotulo: pendentes.length === 1 ? 'aporte esperando confirmação' : 'aportes esperando confirmação', n: pendentes.length },
      { rotulo: nowPend === 1 ? 'alerta Now pendente' : 'alertas Now pendentes', n: nowPend }
    ];
    return {
      itens: pendentes,
      precos: { btc: btc, btc_usd: btcUsd, aapl: aapl, usdbrl: usdbrl, aapl_brl: aapl && usdbrl ? arred(aapl.ultimo * usdbrl) : null },
      posicoes: posicoes,
      carteira: { data: dataMeta, arca: arca, fora: fora, total_arca: totalArca, soma_meta: somaMeta, hoje_por_categoria: hojePorCat },
      recomendacoes: recs.slice(0, 12), ultima_por_ativo: Object.keys(ultimaRec).sort().map(function (k) { return ultimaRec[k]; }), recomendacoes_total: recs.length,
      previdencia: previdencia, reserva: reserva,
      aportes: { pendentes: pendentes.map(function (a) { return a.item_id; }), mes: mesHoje, do_mes: doMes, soma_mes: somaMes },
      alertas: alertas.slice(0, 10),
      precisa: { total: precisa.reduce(function (s, p) { return s + p.n; }, 0), partes: precisa }
    };
  }

  registrarModuloV3({
    id: 'investimentos', rotulo: 'Investimentos', agente: 'Analista de Investimentos', chave: 'INVESTIMENTOS_INTEGRADO',
    fontes: {
      posicoes: { arquivo: 'Posicoes.csv', rotulo: 'Posições (Investimentos)', obrigatorias: ['ativo', 'categoria_arca', 'quantidade', 'moeda'] },
      precos: { arquivo: 'Precos.csv', rotulo: 'Preços (Investimentos)', obrigatorias: ['data', 'ativo', 'fechamento'] },
      metas: { arquivo: 'Metas_ARCA.csv', rotulo: 'Metas ARCA (Investimentos)', obrigatorias: ['data', 'categoria', 'valor_brl', 'meta_pct'] },
      recomendacoes: { arquivo: 'Recomendacoes.csv', rotulo: 'Recomendações (Investimentos)', obrigatorias: ['data', 'ativo', 'sinal'], opcional: true },
      aportes: { arquivo: 'Aportes.csv', rotulo: 'Aportes (Investimentos)', obrigatorias: ['data', 'destino', 'valor_brl', 'estado'] },
      previdencia: { arquivo: 'Previdencia.csv', rotulo: 'Previdência (Investimentos)', obrigatorias: ['data_ref', 'saldo_oficial'], opcional: true },
      reserva: { arquivo: 'Reserva.csv', rotulo: 'Reserva (Investimentos)', obrigatorias: ['data', 'saldo'], opcional: true },
      alertas: { arquivo: 'Alerts.csv', rotulo: 'Alertas (Investimentos)', obrigatorias: ['tier'], opcional: true }
    },
    decisoes: {
      aporte: {
        fiz_aporte: { rotulo: 'Fiz o aporte', estados: ['pendente'], campos: [{ k: 'data', obrigatorio: false, rotulo: 'Data do aporte' }, { k: 'valor', obrigatorio: false, rotulo: 'Valor (R$)' }, { k: 'texto', obrigatorio: false, rotulo: 'Comentário' }], primario: true },
        nao_fiz: { rotulo: 'Não fiz', estados: ['pendente'], campos: [{ k: 'texto', obrigatorio: false, rotulo: 'Motivo' }] }
      }
    },
    montar: montarInvestimentos
  });

  /* ---------- v3: Estudos (Assistente de Estudos, só leitura) ---------- */
  /** Texto do arquivo em NFC (o Mac grava acentos decompostos) e sem espaços nas pontas. */
  function nfc(s) { return String(s === null || s === undefined ? '' : s).normalize('NFC').trim(); }

  /** "2026-11-17 23:59" ou "2026-11-17" (vale 23:59) -> Date local; "a confirmar" e outros textos -> null. */
  function quandoEstudo(txt) {
    var m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?/.exec(nfc(txt));
    if (!m) return null;
    return m[4] !== undefined ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : new Date(+m[1], +m[2] - 1, +m[3], 23, 59);
  }

  /** Contagem regressiva em texto: "hoje às 23:59", "amanhã às 08:00", "em 5 dias", "passou há 2 dias". */
  function prazoEstudo(q, agora) {
    function p(n) { return (n < 10 ? '0' : '') + n; }
    var dias = Math.round((soDia(q).getTime() - soDia(agora).getTime()) / DIA_MS);
    var hora = p(q.getHours()) + ':' + p(q.getMinutes());
    if (q.getTime() < agora.getTime()) return { dias: dias, texto: dias === 0 ? 'hoje, já passou das ' + hora : 'passou há ' + (-dias) + (dias === -1 ? ' dia' : ' dias') };
    if (dias === 0) return { dias: 0, texto: 'hoje às ' + hora };
    if (dias === 1) return { dias: 1, texto: 'amanhã às ' + hora };
    return { dias: dias, texto: 'em ' + dias + ' dias' };
  }

  /** resumo_arquivo -> caminho relativo à pasta de materiais + nota ("materiais/x/y.md", "y.md seção 8.3"). */
  function caminhoResumo(txt) {
    var t = nfc(txt);
    if (!t) return { caminho: '', nota: '' };
    var m = /^(.*?\.(?:md|pdf|docx?|txt|html))(?:\s+(.*))?$/i.exec(t);
    var c = m ? m[1] : t, nota = m && m[2] ? m[2].trim() : '';
    c = c.replace(/^\.?\/+/, '').replace(/^materiais\//i, '');
    return { caminho: c, nota: nota };
  }

  var ESTADOS_RESUMO = [[/^parcial/, 'parcial'], [/^\d{4}-\d{2}-\d{2}/, 'resumido'], [/^(nao|sem|pendente|a fazer)/, 'sem_resumo']];
  var ESTADOS_PEDIDO_ESTUDO = [[/^entregue/, 'entregue'], [/^(cancelad|desistiu)/, 'cancelado']];
  var ORDEM_RESUMO = { resumido: 3, parcial: 2, outro: 1, sem_resumo: 0 };

  function numeroModulo(nome) { var m = /m[oó]?dulo\s*(\d+)/i.exec(semAcento(nome)); return m ? +m[1] : null; }
  function numeroFase(f) { var m = /(\d+)/.exec(String(f || '')); return m ? +m[1] : 99; }

  function montarEstudos(f, dm, agora) {
    var L = function (k) { return (f[k] && f[k].linhas) || []; };
    // entregas e provas
    var eventos = [];
    [['entregas', 'entrega'], ['provas', 'prova']].forEach(function (par) {
      L(par[0]).forEach(function (x, i) {
        if (!nfc(x.titulo) && !nfc(x.data)) return;
        var q = quandoEstudo(x.data), pr = q ? prazoEstudo(q, agora) : null, cr = caminhoResumo(x.simulado_arquivo);
        eventos.push({ tipo: par[1], i: i, curso: nfc(x.curso), titulo: nfc(x.titulo), data_texto: nfc(x.data), quando: q ? dataIso(q).slice(0, 16).replace('T', ' ') : '',
          a_confirmar: !q, dias: pr ? pr.dias : null, prazo: pr ? pr.texto : nfc(x.data) || 'sem data', passou: !!(q && q.getTime() < agora.getTime()),
          fonte: nfc(x.fonte), plano_em: nfc(x.plano_em), rascunho_em: nfc(x.rascunho_em), arquivos: nfc(x.arquivos), modulos: nfc(x.modulos),
          simulado_em: nfc(x.simulado_em), simulado_caminho: cr.caminho, simulado_nota: cr.nota });
      });
    });
    var proximas = eventos.filter(function (e) { return !e.passou; }).sort(function (a, b) {
      if (a.a_confirmar !== b.a_confirmar) return a.a_confirmar ? 1 : -1;
      return a.quando.localeCompare(b.quando) || a.titulo.localeCompare(b.titulo);
    });
    var passadas = eventos.filter(function (e) { return e.passou && e.dias >= -30; }).sort(function (a, b) { return b.quando.localeCompare(a.quando); });

    // módulos: linhas da pasta do Mac + linhas de resumo no Drive (mesmo curso, fase e número do módulo)
    var linhas = L('modulos').filter(function (x) { return nfc(x.modulo); }).map(function (x, i) {
      var re = nfc(x.resumo_em), cr = caminhoResumo(x.resumo_arquivo);
      var sit = re ? classificarComeco(re, ESTADOS_RESUMO, 'outro') : 'sem_resumo';
      var obs = (/\((.*)\)\s*$/.exec(re) || [])[1] || '';
      return { i: i, curso: nfc(x.curso), fase: nfc(x.fase), modulo: nfc(x.modulo), arquivo: nfc(x.arquivo), tipo: nfc(x.tipo), chegou_em: nfc(x.chegou_em),
        resumo_texto: re, situacao: sit, resumo_data: sit === 'resumido' ? re.slice(0, 10) : '', resumo_obs: obs, caminho: cr.caminho, nota: cr.nota,
        no_drive: /^google drive$/i.test(nfc(x.arquivo)), numero: numeroModulo(x.modulo) };
    });
    var mestres = linhas.filter(function (x) { return /^todas$/i.test(x.fase) || /resumo mestre/i.test(x.modulo); });
    var resto = linhas.filter(function (x) { return mestres.indexOf(x) < 0; });
    var chave = function (x) { return x.numero === null ? null : semAcento(x.curso) + '|' + semAcento(x.fase) + '|' + x.numero; };
    var doMac = resto.filter(function (x) { return !x.no_drive; }), doDrive = resto.filter(function (x) { return x.no_drive; });
    var porChave = {};
    doMac.forEach(function (x) { var k = chave(x); if (k && !porChave[k]) porChave[k] = x; });
    var modulos = doMac.map(function (x) { return Object.assign({}, x, { resumos: [x].filter(function (r) { return r.resumo_texto || r.caminho; }) }); });
    var achar = function (x) { for (var j = 0; j < modulos.length; j++) if (modulos[j].i === x.i) return modulos[j]; return null; };
    doDrive.forEach(function (d) {
      var k = chave(d), alvo = k && porChave[k] ? achar(porChave[k]) : null;
      if (alvo) alvo.resumos.push(d);
      else modulos.push(Object.assign({}, d, { resumos: [d] }));
    });
    modulos.forEach(function (x) {
      x.resumos.sort(function (a, b) { return (ORDEM_RESUMO[b.situacao] - ORDEM_RESUMO[a.situacao]) || b.resumo_data.localeCompare(a.resumo_data); });
      var r = x.resumos[0];
      x.situacao_final = r ? r.situacao : 'sem_resumo';
      x.resumo = r ? { situacao: r.situacao, data: r.resumo_data, texto: r.resumo_texto, obs: r.resumo_obs, caminho: r.caminho, nota: r.nota, no_drive: r.no_drive } : null;
      x.outros_resumos = x.resumos.slice(1).map(function (o) { return { situacao: o.situacao, data: o.resumo_data, texto: o.resumo_texto, caminho: o.caminho, nota: o.nota }; });
      delete x.resumos;
    });
    modulos.sort(function (a, b) {
      return a.curso.localeCompare(b.curso) || numeroFase(a.fase) - numeroFase(b.fase) ||
        ((a.numero === null ? 99 : a.numero) - (b.numero === null ? 99 : b.numero)) || a.modulo.localeCompare(b.modulo);
    });

    // cursos (sem o caminho do Mac: só o nome da pasta)
    var cursos = L('cursos').filter(function (x) { return nfc(x.curso); }).map(function (x) {
      var pasta = nfc(x.pasta).replace(/\/+$/, '');
      return { curso: nfc(x.curso), pasta_nome: pasta.split('/').pop(), calendario: nfc(x.calendario), situacao: nfc(x.situacao) };
    });
    // liga módulos e mestres ao curso: "POS X" casa com "POS X - Gestão Ambiental"
    var doCurso = function (nome) {
      var n = semAcento(nome);
      return function (x) { var c = semAcento(x.curso); return c && (n === c || n.indexOf(c + ' ') === 0 || n.indexOf(c + ' -') === 0 || c.indexOf(n) === 0); };
    };
    var usados = {};
    var grupos = cursos.map(function (c) {
      var ms = modulos.filter(doCurso(c.curso)), me = mestres.filter(doCurso(c.curso));
      ms.forEach(function (x) { usados[x.i + (x.no_drive ? 'd' : 'm')] = 1; });
      var cont = { resumido: 0, parcial: 0, sem_resumo: 0, outro: 0 };
      ms.forEach(function (x) { cont[x.situacao_final]++; });
      return Object.assign({}, c, { modulos: ms, contagem: cont,
        mestres: me.map(function (r) { return { modulo: r.modulo, data: r.resumo_data, texto: r.resumo_texto, caminho: r.caminho, nota: r.nota }; }) });
    });
    var soltos = modulos.filter(function (x) { return !usados[x.i + (x.no_drive ? 'd' : 'm')]; });
    if (soltos.length) {
      var porC = {};
      soltos.forEach(function (x) { (porC[x.curso] = porC[x.curso] || []).push(x); });
      Object.keys(porC).forEach(function (k) {
        var cont = { resumido: 0, parcial: 0, sem_resumo: 0, outro: 0 };
        porC[k].forEach(function (x) { cont[x.situacao_final]++; });
        grupos.push({ curso: k, pasta_nome: '', calendario: '', situacao: 'não está no Cursos.csv', modulos: porC[k], contagem: cont, mestres: [] });
      });
    }

    // pedidos
    var pedidos = L('pedidos').filter(function (x) { return nfc(x.pedido); }).map(function (x, i) {
      var et = nfc(x.estado);
      return { i: i, data: nfc(x.data), pedido: nfc(x.pedido), tipo: nfc(x.tipo), estado_texto: et, estado: classificarComeco(et, ESTADOS_PEDIDO_ESTUDO, 'andamento'), entregue_em: nfc(x.entregue_em) };
    });
    var andamento = pedidos.filter(function (p) { return p.estado === 'andamento'; }).sort(function (a, b) { return a.data.localeCompare(b.data); });
    var entregues = pedidos.filter(function (p) { return p.estado === 'entregue'; }).sort(function (a, b) { return (b.entregue_em || b.data).localeCompare(a.entregue_em || a.data) || b.i - a.i; }).slice(0, 5);

    // caminhos para o servidor achar o fileId na pasta de materiais
    var caminhos = {};
    modulos.forEach(function (x) { if (x.resumo && x.resumo.caminho) caminhos[x.resumo.caminho] = 1; x.outros_resumos.forEach(function (o) { if (o.caminho) caminhos[o.caminho] = 1; }); });
    mestres.forEach(function (r) { if (r.caminho) caminhos[r.caminho] = 1; });
    eventos.forEach(function (e) { if (e.simulado_caminho) caminhos[e.simulado_caminho] = 1; });

    var em7 = proximas.filter(function (e) { return !e.a_confirmar && e.dias <= 7; }).length;
    return {
      itens: [], proximas: proximas, passadas: passadas, a_confirmar: proximas.filter(function (e) { return e.a_confirmar; }).length,
      cursos: grupos, modulos_total: modulos.length, pedidos_andamento: andamento, pedidos_entregues: entregues, pedidos_total: pedidos.length,
      caminhos: Object.keys(caminhos).sort(), links: {},
      precisa: { total: em7, partes: [{ rotulo: em7 === 1 ? 'entrega ou prova em 7 dias' : 'entregas ou provas em 7 dias', n: em7 }] }
    };
  }

  registrarModuloV3({
    id: 'estudos', rotulo: 'Estudos', agente: 'Assistente de Estudos', chave: null,
    fontes: {
      cursos: { arquivo: 'Cursos.csv', rotulo: 'Cursos (Estudos)', obrigatorias: ['curso'] },
      entregas: { arquivo: 'Entregas.csv', rotulo: 'Entregas (Estudos)', obrigatorias: ['curso', 'titulo', 'data'] },
      modulos: { arquivo: 'Modulos.csv', rotulo: 'Módulos (Estudos)', obrigatorias: ['curso', 'fase', 'modulo', 'resumo_em', 'resumo_arquivo'] },
      provas: { arquivo: 'Provas.csv', rotulo: 'Provas (Estudos)', obrigatorias: ['curso', 'titulo', 'data'], opcional: true },
      pedidos: { arquivo: 'Pedidos.csv', rotulo: 'Pedidos (Estudos)', obrigatorias: ['pedido', 'estado'], opcional: true }
    },
    decisoes: null,
    montar: montarEstudos
  });

  /** Todas as decisões que os módulos v3 aceitam. */
  function decisoesV3() {
    var r = [];
    ORDEM_V3.forEach(function (id) { var d = MODULOS_V3[id].decisoes || {}; Object.keys(d).forEach(function (t) { Object.keys(d[t]).forEach(function (k) { if (r.indexOf(k) < 0) r.push(k); }); }); });
    return r;
  }

  /** Valida uma decisão vinda da tela. */
  function validarDecisao(d) {
    if (!d || typeof d !== 'object') throw new Error('decisão vazia');
    if (['aprovar', 'refazer', 'recusar', 'pausar'].indexOf(d.decisao) < 0 && decisoesV3().indexOf(d.decisao) < 0) throw new Error('decisão inválida');
    // módulos v3: item_id carrega message_id e pasta ("=", "@", "|", espaço, acento); o item ainda precisa existir no modelo
    var reItem = MODULOS_V3[d.modulo] ? /^[a-z_]+:[^\u0000-\u001f\u007f]{1,200}$/ : /^[\w:.\-]{1,80}$/;
    if (!d.item_id || !reItem.test(d.item_id)) throw new Error('item inválido');
    if (!d.modulo || !/^[a-z_]{1,30}$/.test(d.modulo)) throw new Error('módulo inválido');
    var c = String(d.comentario || '').trim();
    if (d.modulo === 'anuncios' || MODULOS_V3[d.modulo]) c = c.replace(/[\r\n]+/g, ' ');
    if (d.decisao === 'refazer' && !c) throw new Error('o pedido de ajuste precisa de um comentário');
    if (c.length > 2000) throw new Error('comentário muito longo');
    if (!/^[0-9a-f]{64}$/.test(String(d.snapshot_hash || ''))) throw new Error('decisão sem a versão exibida; atualize o painel');
    return { modulo: d.modulo, item_id: d.item_id, decisao: d.decisao, comentario: c, snapshot_hash: d.snapshot_hash };
  }

  /** Versão exibida no topo do painel. Atualize a cada implantação. */
  var VERSAO_PAINEL = '3.0.1';
  var POSTS_INTEGRADOS = false;
  var ESTADOS_DECIDIVEIS = { design: ['entregue'], post: ['rascunho', 'aguardando_aprovo'] };

  /**
   * Confere a decisão contra o estado atual lido do Drive.
   * Rejeita: item inexistente, estado que não aceita decisão, versão diferente da exibida
   * e decisão repetida ainda sem recibo. Devolve o vínculo de versão para gravar.
   */
  function conferirDecisao(modelo, d) {
    if (d.modulo === 'anuncios') return conferirDecisaoAnuncio(modelo, d);
    if (MODULOS_V3[d.modulo]) return conferirDecisaoV3(modelo, d);
    if (d.decisao && ['aprovar', 'refazer'].indexOf(d.decisao) < 0) throw new Error('decisão "' + d.decisao + '" não vale para designs');
    var ehPost = d.item_id.indexOf('post:') === 0;
    // Posts ainda sem consumidor (fluxo do Tráfego pendente): o painel não grava decisão de post.
    if (ehPost && !POSTS_INTEGRADOS) throw new Error('decisão de post pelo painel ainda não está integrada (fluxo do Tráfego pendente); nada foi gravado');
    var id = ehPost ? d.item_id.slice(5) : d.item_id;
    var lista = ehPost ? modelo.posts : modelo.designs;
    var item = null;
    for (var i = 0; i < lista.length; i++) if (lista[i].id === id) { item = lista[i]; break; }
    if (!item) throw new Error('item ' + d.item_id + ' não existe mais nos arquivos do agente');
    var tipo = ehPost ? 'post' : 'design';
    if (ESTADOS_DECIDIVEIS[tipo].indexOf(item.estado) < 0) throw new Error('item ' + d.item_id + ' está "' + item.estado + '" e não aceita decisão agora; atualize o painel');
    if (item.snapshot_hash !== d.snapshot_hash) throw new Error('o item ' + d.item_id + ' mudou desde que a tela foi carregada; atualize o painel e confira de novo');
    var pend = item.decisao_pendente;
    if (pend && pend.snapshot_hash === d.snapshot_hash) throw new Error('já existe uma decisão enviada para esta versão (' + pend.id + ')');
    return { tipo_item: tipo, versao: item.versao || '', arte_fileId: item.arte_fileId || '', snapshot_hash: item.snapshot_hash };
  }

  /** Lê um recibo JSON do agente. Lança se faltar campo. */
  function parseRecibo(texto, nomeArquivo) {
    var r = JSON.parse(texto);
    var id = String(nomeArquivo || '').replace(/\.json$/, '');
    if (!r || r.decision_id !== id) throw new Error('decision_id diferente do nome do arquivo');
    if (['aplicado', 'rejeitado'].indexOf(r.resultado) < 0) throw new Error('resultado inválido');
    if (!r.processado_em) throw new Error('sem processado_em');
    return { decision_id: r.decision_id, resultado: r.resultado, motivo: String(r.motivo || ''), processado_em: r.processado_em, agente: String(r.agente || ''), snapshot_hash: String(r.snapshot_hash || ''), link: ehLink(r.link) ? String(r.link).trim() : '' };
  }

  var CABECALHO_DECISOES = ['id', 'quando', 'modulo', 'item_id', 'tipo_item', 'versao', 'arte_fileId', 'snapshot_hash', 'decisao', 'comentario', 'origem'];

  return {
    parseCsv: parseCsv,
    csvParaObjetos: csvParaObjetos,
    csvLinha: csvLinha,
    parseData: parseData,
    dataIso: dataIso,
    parsePostObs: parsePostObs,
    parsePostMd: parsePostMd,
    montarModelo: montarModelo,
    validarDecisao: validarDecisao,
    conferirDecisao: conferirDecisao,
    parseRecibo: parseRecibo,
    sha256: sha256,
    VERSAO_PAINEL: VERSAO_PAINEL,
    canonicoDesign: canonicoDesign,
    canonicoPost: canonicoPost,
    CABECALHO_DECISOES: CABECALHO_DECISOES,
    diasDesde: diasDesde,
    montarAnuncios: montarAnuncios,
    canonicoPostV2: canonicoPostV2,
    canonicoCampanha: canonicoCampanha,
    parseComentarioAnuncio: parseComentarioAnuncio,
    montarComentarioAnuncio: montarComentarioAnuncio,
    validarComentarioAnuncio: validarComentarioAnuncio,
    contasDoTexto: contasDoTexto,
    estadoPublicacao: estadoPublicacao,
    parsePlanoMd: parsePlanoMd,
    midias: midias,
    CABECALHO_PROPOSTAS: CABECALHO_PROPOSTAS,
    CHAVES: CHAVES,
    DECISOES_ANUNCIOS: DECISOES_ANUNCIOS,
    MODULOS_V3: MODULOS_V3,
    ORDEM_V3: ORDEM_V3,
    AVISO_CHAVE_V3: AVISO_CHAVE_V3,
    canonicoV3: canonicoV3,
    canonicoGrupoEmails: canonicoGrupoEmails,
    canonicoPendencia: canonicoPendencia,
    ESTADOS_MOVIMENTO: ESTADOS_MOVIMENTO,
    ESTADOS_PENDENCIA: ESTADOS_PENDENCIA,
    decisoesComRecibos: decisoesComRecibos,
    montarModulosV3: montarModulosV3,
    conferirDecisaoV3: conferirDecisaoV3,
    numBr: numBr, tipoCodigo: tipoCodigo, consertarLinha: consertarLinha, canonicoConta: canonicoConta, canonicoRateio: canonicoRateio, limparTokens: limparTokens, quandoPreco: quandoPreco, numDec: numDec, seriesPrecos: seriesPrecos, canonicoAporte: canonicoAporte, ESTADOS_APORTE: ESTADOS_APORTE, quandoEstudo: quandoEstudo, prazoEstudo: prazoEstudo, caminhoResumo: caminhoResumo, nfc: nfc, ESTADOS_RESUMO: ESTADOS_RESUMO, ESTADOS_CONTA: ESTADOS_CONTA,
    parseComentarioV3: parseComentarioV3,
    montarComentarioV3: montarComentarioV3,
    classificarComeco: classificarComeco,
    canonicoResposta: canonicoResposta,
    CABECALHO_RASCUNHOS_SUPORTE: CABECALHO_RASCUNHOS_SUPORTE,
    prazoDoEvento: prazoDoEvento
  };
})();

if (typeof module !== 'undefined') module.exports = PainelLib;
