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
  var CHAVES = { ANUNCIOS_INTEGRADOS: false };
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

  /** Valida uma decisão vinda da tela. */
  function validarDecisao(d) {
    if (!d || typeof d !== 'object') throw new Error('decisão vazia');
    if (['aprovar', 'refazer', 'recusar', 'pausar'].indexOf(d.decisao) < 0) throw new Error('decisão inválida');
    if (!d.item_id || !/^[\w:.\-]{1,80}$/.test(d.item_id)) throw new Error('item inválido');
    if (!d.modulo || !/^[a-z_]{1,30}$/.test(d.modulo)) throw new Error('módulo inválido');
    var c = String(d.comentario || '').trim();
    if (d.modulo === 'anuncios') c = c.replace(/[\r\n]+/g, ' ');
    if (d.decisao === 'refazer' && !c) throw new Error('o pedido de ajuste precisa de um comentário');
    if (c.length > 2000) throw new Error('comentário muito longo');
    if (!/^[0-9a-f]{64}$/.test(String(d.snapshot_hash || ''))) throw new Error('decisão sem a versão exibida; atualize o painel');
    return { modulo: d.modulo, item_id: d.item_id, decisao: d.decisao, comentario: c, snapshot_hash: d.snapshot_hash };
  }

  /** Versão exibida no topo do painel. Atualize a cada implantação. */
  var VERSAO_PAINEL = '2.0.1';
  var POSTS_INTEGRADOS = false;
  var ESTADOS_DECIDIVEIS = { design: ['entregue'], post: ['rascunho', 'aguardando_aprovo'] };

  /**
   * Confere a decisão contra o estado atual lido do Drive.
   * Rejeita: item inexistente, estado que não aceita decisão, versão diferente da exibida
   * e decisão repetida ainda sem recibo. Devolve o vínculo de versão para gravar.
   */
  function conferirDecisao(modelo, d) {
    if (d.modulo === 'anuncios') return conferirDecisaoAnuncio(modelo, d);
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
    DECISOES_ANUNCIOS: DECISOES_ANUNCIOS
  };
})();

if (typeof module !== 'undefined') module.exports = PainelLib;
