// Teste do servidor (Code.gs) com DriveApp, CacheService etc. simulados.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const src = (n) => fs.readFileSync(path.join(__dirname, '..', 'src', n), 'utf8');
const fx = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8');

function ambiente(arquivos) {
  const props = {}, cache = {}; let uuid = 0;
  const arquivo = (id) => {
    const a = arquivos[id]; if (!a) throw new Error('Arquivo não encontrado: ' + id);
    return { getId: () => id, getName: () => a.nome, isTrashed: () => false, getLastUpdated: () => new Date('2026-11-11T12:00:00Z'),
      getBlob: () => ({ getDataAsString: () => a.texto }), setContent: (t) => { a.texto = t; } };
  };
  const iter = (lista) => { let i = 0; return { hasNext: () => i < lista.length, next: () => lista[i++] }; };
  const g = {
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) },
    DriveApp: {
      getFileById: arquivo,
      getFilesByName: (n) => iter(Object.keys(arquivos).filter((id) => arquivos[id].nome === n && !arquivos[id].pasta).map(arquivo)),
      getFolderById: (fid) => ({
        getFilesByName: (n) => iter(Object.keys(arquivos).filter((id) => arquivos[id].pasta === fid && arquivos[id].nome === n).map(arquivo)),
        getFiles: () => iter(Object.keys(arquivos).filter((id) => arquivos[id].pasta === fid).map(arquivo))
      })
    },
    CacheService: { getUserCache: () => ({ get: (k) => cache[k] || null, getAll: (ks) => { const o = {}; ks.forEach((k) => { if (k in cache) o[k] = cache[k]; }); return o; }, putAll: (o) => Object.assign(cache, o), put: (k, v) => { cache[k] = v; }, remove: (k) => { delete cache[k]; } }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    Utilities: { formatDate: (d, tz, f) => f === 'yyyy-MM-dd HH:mm:ss' ? '2026-11-11 15:00:00' : f.indexOf('yyyy-MM-dd') === 0 ? '2026-11-11T15:00:00-03:00' : '20261111-150000', getUuid: () => 'abcdef12-0000-4000-8000-' + String(++uuid).padStart(12, '0') }
  };
  const m = { exports: {} };
  const nomes = Object.keys(g);
  const corpo = src('Lib.gs') + '\n' + src('Code.gs') + '\nreturn { obterDados, salvarDecisao, PainelLib };';
  return Object.assign(new Function('module', ...nomes, corpo)(m, ...nomes.map((k) => g[k])), { arquivos, cache });
}

function arquivosBase(cfgExtra) {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'painel-fontes.example.json'), 'utf8'));
  cfg.decisoes.fileId = 'DEC'; cfg.decisoes.recibos_folderId = 'RECIBOS';
  const d = cfg.modulos[0].fontes;
  d.pedidos.fileId = 'PED'; d.produtos.fileId = 'PROD'; d.ledger.folderId = 'LEDGER'; d.criativos.folderId = 'CRIAT';
  const an = cfg.modulos.find((m) => m.id === 'anuncios').fontes;
  an.ledger.folderId = 'TRAF'; an.criativos.folderId = 'CRIAT';
  Object.assign(cfg, cfgExtra || {});
  return {
    CFG: { nome: 'painel-fontes.json', texto: JSON.stringify(cfg) },
    DEC: { nome: 'decisoes.csv', texto: 'id,quando,modulo,item_id,tipo_item,versao,arte_fileId,snapshot_hash,decisao,comentario,origem\n' },
    PED: { nome: 'pedidos-de-arte.csv', texto: fx('pedidos-de-arte.csv') },
    PROD: { nome: 'produtos.csv', texto: fx('produtos.csv') },
    A: { nome: 'Artes.csv', pasta: 'LEDGER', texto: fx('Artes.csv') },
    P: { nome: 'Posts.csv', pasta: 'LEDGER', texto: fx('Posts.csv') },
    M: { nome: 'Midia.csv', pasta: 'LEDGER', texto: fx('Midia.csv') },
    C: { nome: 'Checkpoints.csv', pasta: 'LEDGER', texto: fx('Checkpoints.csv') },
    R3: { nome: 'post-P-20261109-03.md', pasta: 'CRIAT', texto: fx('post-P-20261109-03.md') },
    PL: { nome: 'plano-semana.md', pasta: 'CRIAT', texto: '# plano' },
    PL2: { nome: 'plano-teste-2026-11.md', pasta: 'CRIAT', texto: fx('anuncios/plano-teste-2026-11.md') },
    TA: { nome: 'Anuncios.csv', pasta: 'TRAF', texto: fx('anuncios/Anuncios.csv') },
    TC: { nome: 'Campanhas.csv', pasta: 'TRAF', texto: fx('anuncios/Campanhas.csv') },
    TR: { nome: 'Resultados.csv', pasta: 'TRAF', texto: fx('anuncios/Resultados.csv') },
    TE: { nome: 'Empresas.csv', pasta: 'TRAF', texto: fx('anuncios/Empresas.csv') },
    TK: { nome: 'Checkpoints.csv', pasta: 'TRAF', texto: fx('anuncios/Checkpoints.csv') },
    TU: { nome: 'Rules.csv', pasta: 'TRAF', texto: fx('anuncios/Rules.csv') }
  };
}

test('obterDados lê todas as fontes e usa o cache na segunda chamada', () => {
  const e = ambiente(arquivosBase());
  const d1 = e.obterDados(false);
  assert.equal(d1.do_cache, false);
  assert.ok(d1.fontes.every((f) => f.ok), JSON.stringify(d1.fontes));
  assert.equal(d1.designs.length, 11);
  assert.equal(d1.modulos.filter((m) => !m.ativo).length, 5);
  // agora = 11/11 15:00 em São Paulo: reels das 18:30 ainda programado
  assert.equal(d1.posts.find((p) => p.id === 'P-20261109-01').estado, 'programado');
  assert.deepEqual(d1.inicio.artes_entregues.sort(), ['P-20261111-02', 'P-20261111-03']);
  const d2 = e.obterDados(false);
  assert.equal(d2.do_cache, true);
  assert.equal(e.obterDados(true).do_cache, false);
});

test('CSV quebrado ou ausente vira aviso e o resto funciona', () => {
  const a = arquivosBase();
  a.C.texto = 'source,cursor\n"x,sem fechar\n';
  delete a.M;
  const d = ambiente(a).obterDados(true);
  const porRot = Object.fromEntries(d.fontes.map((f) => [f.rotulo, f]));
  assert.equal(porRot['Checkpoints (ledger do Design)'].ok, false);
  assert.match(porRot['Checkpoints (ledger do Design)'].erro, /aspas/);
  assert.equal(porRot['Mídia (ledger do Design)'].ok, false);
  assert.match(porRot['Mídia (ledger do Design)'].erro, /não está na pasta/);
  assert.equal(d.designs.length, 11);
  assert.deepEqual(d.midia, []);
});

test('salvarDecisao grava a versão exibida, só acrescenta e rejeita snapshot obsoleto', () => {
  const e = ambiente(arquivosBase());
  const d = e.obterDados(false);
  const item = d.designs.find((x) => x.id === 'P-20261111-03');
  const r = e.salvarDecisao({ modulo: 'design', item_id: 'P-20261111-03', decisao: 'refazer', comentario: 'Trocar a foto, "maior"', snapshot_hash: item.snapshot_hash });
  assert.equal(r.ok, true);
  assert.match(r.id, /^D-20261111-150000-abcdef12$/);
  const linhas = e.PainelLib.csvParaObjetos(e.arquivos.DEC.texto).linhas;
  assert.equal(linhas.length, 1);
  assert.equal(linhas[0].comentario, 'Trocar a foto, "maior"');
  assert.equal(linhas[0].origem, 'painel');
  assert.equal(linhas[0].tipo_item, 'design');
  assert.equal(linhas[0].versao, item.versao);
  assert.equal(linhas[0].arte_fileId, item.arte_fileId);
  assert.equal(linhas[0].snapshot_hash, item.snapshot_hash);
  // repetida para a mesma versão
  assert.throws(() => e.salvarDecisao({ modulo: 'design', item_id: 'P-20261111-03', decisao: 'aprovar', snapshot_hash: item.snapshot_hash }), /já existe/);
  // o agente troca a arte do 02 depois que a tela carregou: snapshot antigo é recusado
  const item02 = d.designs.find((x) => x.id === 'P-20261111-02');
  e.arquivos.A.texto = e.arquivos.A.texto.replace(item02.arte_fileId, 'NOVA_ARTE_v2_0000000');
  assert.throws(() => e.salvarDecisao({ modulo: 'design', item_id: 'P-20261111-02', decisao: 'aprovar', snapshot_hash: item02.snapshot_hash }), /mudou/);
  // item que não aceita decisão
  const ap = d.designs.find((x) => x.id === 'P-20261111-01');
  assert.throws(() => e.salvarDecisao({ modulo: 'design', item_id: 'P-20261111-01', decisao: 'aprovar', snapshot_hash: ap.snapshot_hash }), /não aceita/);
  assert.equal(e.PainelLib.csvParaObjetos(e.arquivos.DEC.texto).linhas.length, 1);
  const depois = e.obterDados(false);
  assert.equal(depois.do_cache, false);
  assert.equal(depois.designs.find((x) => x.id === 'P-20261111-03').decisao_pendente.versao, item.versao);
});

test('recibo imutável do agente encerra a pendência; recibo inválido vira aviso', () => {
  const a = arquivosBase();
  const e = ambiente(a);
  const d = e.obterDados(true);
  const item = d.designs.find((x) => x.id === 'P-20261111-02');
  const r = e.salvarDecisao({ modulo: 'design', item_id: 'P-20261111-02', decisao: 'aprovar', snapshot_hash: item.snapshot_hash });
  assert.equal(e.obterDados(true).inicio.decisoes_pendentes.length, 1);
  a.REC1 = { nome: r.id + '.json', pasta: 'RECIBOS', texto: JSON.stringify({ decision_id: r.id, resultado: 'aplicado', processado_em: '2026-11-11T16:00:00-03:00', agente: 'Agente de Design', snapshot_hash: item.snapshot_hash }) };
  a.REC2 = { nome: 'D-lixo.json', pasta: 'RECIBOS', texto: '{quebrado' };
  const d2 = e.obterDados(true);
  assert.equal(d2.inicio.decisoes_pendentes.length, 0);
  const fr = d2.fontes.find((f) => f.rotulo === 'Recibos dos agentes');
  assert.equal(fr.ok, true);
  assert.match(fr.avisos[0], /D-lixo\.json/);
  // o CSV de entrada não foi tocado pelo recibo
  assert.equal(e.PainelLib.csvParaObjetos(a.DEC.texto).linhas.length, 1);
});

test('cabeçalho antigo de decisoes.csv: nada é gravado', () => {
  const a = arquivosBase();
  a.DEC.texto = 'id,quando,modulo,item_id,decisao,comentario,origem,processado_em\n';
  const e = ambiente(a);
  const d = e.obterDados(true);
  const item = d.designs.find((x) => x.id === 'P-20261111-02');
  assert.throws(() => e.salvarDecisao({ modulo: 'design', item_id: 'P-20261111-02', decisao: 'aprovar', snapshot_hash: item.snapshot_hash }), /decisoes\.csv|recibos/);
  assert.equal(a.DEC.texto, 'id,quando,modulo,item_id,decisao,comentario,origem,processado_em\n');
});

// ---------- Módulo Posts e anúncios ----------

test('anuncios: sem Propostas.csv nada quebra e aparece como aviso informativo', () => {
  const d = ambiente(arquivosBase()).obterDados(true);
  assert.ok(d.anuncios, 'módulo anuncios montado');
  assert.equal(d.anuncios.propostas_ativas, false);
  const fp = d.fontes.find((f) => f.rotulo === 'Propostas (Tráfego)');
  assert.equal(fp.ok, true); assert.equal(fp.ausente, true);
  assert.ok(d.fontes.filter((f) => !f.ausente).every((f) => f.ok), JSON.stringify(d.fontes.filter((f) => !f.ok)));
  assert.equal(d.anuncios.posts.filter((p) => /^ORG-/.test(p.id)).length, 7);
  assert.deepEqual(d.anuncios.inicio.planos_aguardando, ['C01', 'C02', 'C03', 'C04', 'C05']);
  assert.ok(d.anuncios.posts.every((p) => !p.decisoes_possiveis.length));
  assert.equal(d.anuncios.campanhas.find((c) => c.id === 'C02').plano.nome, 'plano-teste-2026-11.md');
});

function comPropostas() {
  const a = arquivosBase();
  a.TP = { nome: 'Propostas.csv', pasta: 'TRAF', texto: fx('anuncios/Propostas.csv') };
  return a;
}

test('anuncios: com a chave desligada o servidor não grava nada', () => {
  const a = comPropostas();
  const e = ambiente(a);
  const d = e.obterDados(true);
  assert.equal(d.anuncios.integrados, false);
  const p = d.anuncios.posts.find((x) => x.id === 'P-20261111-01');
  assert.throws(() => e.salvarDecisao({ modulo: 'anuncios', item_id: 'post:P-20261111-01', decisao: 'aprovar', comentario: 'legenda=1', snapshot_hash: p.snapshot_hash }), /ainda não lê estas decisões/);
  assert.equal(e.PainelLib.csvParaObjetos(a.DEC.texto).linhas.length, 0);
});

test('anuncios: com a chave ligada grava post e campanha com tipo_item certo; hash velho não grava', () => {
  const a = comPropostas();
  const e = ambiente(a);
  e.PainelLib.CHAVES.ANUNCIOS_INTEGRADOS = true;
  const d = e.obterDados(true);
  const car = d.anuncios.posts.find((x) => x.id === 'P-20261112-CAT');
  const r1 = e.salvarDecisao({ modulo: 'anuncios', item_id: 'post:P-20261112-CAT', decisao: 'aprovar', comentario: 'legenda=2;horario=2026-11-16 19:00;texto=ok, pode; usar = isso', snapshot_hash: car.snapshot_hash });
  assert.equal(r1.ok, true);
  const c02 = d.anuncios.campanhas.find((x) => x.id === 'C02');
  e.salvarDecisao({ modulo: 'anuncios', item_id: 'campanha:C02', decisao: 'aprovar', comentario: 'verba=8', snapshot_hash: c02.snapshot_hash });
  let linhas = e.PainelLib.csvParaObjetos(a.DEC.texto).linhas;
  assert.equal(linhas.length, 2);
  assert.equal(linhas[0].modulo, 'anuncios'); assert.equal(linhas[0].tipo_item, 'post'); assert.equal(linhas[0].versao, '1');
  assert.equal(linhas[0].arte_fileId.split(';').length, 10);
  assert.equal(linhas[0].snapshot_hash, car.snapshot_hash);
  assert.equal(linhas[0].comentario, 'legenda=2;horario=2026-11-16 19:00;texto=ok, pode; usar = isso');
  assert.equal(linhas[1].tipo_item, 'campanha'); assert.equal(linhas[1].arte_fileId, '');
  // verba acima da proposta
  const m = d.anuncios.campanhas.find((x) => x.id === 'M-52562345108818');
  assert.throws(() => e.salvarDecisao({ modulo: 'anuncios', item_id: 'campanha:M-52562345108818', decisao: 'aprovar', comentario: '', snapshot_hash: m.snapshot_hash }), /não aceita aprovar/);
  e.salvarDecisao({ modulo: 'anuncios', item_id: 'campanha:M-52562345108818', decisao: 'pausar', comentario: '', snapshot_hash: m.snapshot_hash });
  // o Tráfego muda a legenda do P-20261111-01 depois que a tela carregou
  const p1 = d.anuncios.posts.find((x) => x.id === 'P-20261111-01');
  a.TP.texto = a.TP.texto.replace('Um detalhe que muda a mesa de Natal.', 'Um detalhe que transforma a mesa de Natal.');
  assert.throws(() => e.salvarDecisao({ modulo: 'anuncios', item_id: 'post:P-20261111-01', decisao: 'aprovar', comentario: 'legenda=1', snapshot_hash: p1.snapshot_hash }), /mudou/);
  linhas = e.PainelLib.csvParaObjetos(a.DEC.texto).linhas;
  assert.equal(linhas.length, 3);
  assert.equal(linhas[2].decisao, 'pausar');
  // pendência aparece no item
  const d2 = e.obterDados(true);
  assert.equal(d2.anuncios.posts.find((x) => x.id === 'P-20261112-CAT').decisao_pendente.decisao, 'aprovar');
  assert.equal(d2.inicio.decisoes_pendentes.length, 3);
  e.PainelLib.CHAVES.ANUNCIOS_INTEGRADOS = false;
});

test('anuncios: verba maior que a proposta e comentário fora do formato são recusados', () => {
  const a = comPropostas();
  const e = ambiente(a);
  e.PainelLib.CHAVES.ANUNCIOS_INTEGRADOS = true;
  const d = e.obterDados(true);
  const c02 = d.anuncios.campanhas.find((x) => x.id === 'C02');
  assert.throws(() => e.salvarDecisao({ modulo: 'anuncios', item_id: 'campanha:C02', decisao: 'aprovar', comentario: 'verba=12', snapshot_hash: c02.snapshot_hash }), /maior que a proposta/);
  const p1 = d.anuncios.posts.find((x) => x.id === 'P-20261111-01');
  assert.throws(() => e.salvarDecisao({ modulo: 'anuncios', item_id: 'post:P-20261111-01', decisao: 'aprovar', comentario: 'texto=sem legenda', snapshot_hash: p1.snapshot_hash }), /legenda 1 ou 2/);
  assert.throws(() => e.salvarDecisao({ modulo: 'anuncios', item_id: 'post:P-20261111-01', decisao: 'refazer', comentario: 'trocar a foto', snapshot_hash: p1.snapshot_hash }), /chave=valor/);
  // publicação do ledger (sem Propostas) não aceita decisão
  const org = d.anuncios.posts.find((x) => x.id === 'ORG-20261112-01');
  assert.throws(() => e.salvarDecisao({ modulo: 'anuncios', item_id: 'post:ORG-20261112-01', decisao: 'aprovar', comentario: 'legenda=1', snapshot_hash: 'a'.repeat(64) }), /não está em Propostas/);
  assert.equal(e.PainelLib.csvParaObjetos(a.DEC.texto).linhas.length, 0);
  e.PainelLib.CHAVES.ANUNCIOS_INTEGRADOS = false;
});
