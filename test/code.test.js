// Teste do servidor (Code.gs) com DriveApp, CacheService etc. simulados.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const src = (n) => fs.readFileSync(path.join(__dirname, '..', 'src', n), 'utf8');
const fx = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8');

function ambiente(arquivos) {
  const props = {}, cache = {};
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
    LockService: { getUserLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
    Utilities: { formatDate: (d, tz, f) => f.indexOf('HH:mm:ss') > 0 && f.indexOf('yyyy-MM-dd') === 0 ? '2026-11-11T15:00:00-03:00' : '20261111-150000' }
  };
  const m = { exports: {} };
  const nomes = Object.keys(g);
  const corpo = src('Lib.gs') + '\n' + src('Code.gs') + '\nreturn { obterDados, salvarDecisao, PainelLib };';
  return Object.assign(new Function('module', ...nomes, corpo)(m, ...nomes.map((k) => g[k])), { arquivos, cache });
}

function arquivosBase(cfgExtra) {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'painel-fontes.example.json'), 'utf8'));
  cfg.decisoes.fileId = 'DEC';
  const d = cfg.modulos[0].fontes;
  d.pedidos.fileId = 'PED'; d.produtos.fileId = 'PROD'; d.ledger.folderId = 'LEDGER'; d.criativos.folderId = 'CRIAT';
  Object.assign(cfg, cfgExtra || {});
  return {
    CFG: { nome: 'painel-fontes.json', texto: JSON.stringify(cfg) },
    DEC: { nome: 'decisoes.csv', texto: 'id,quando,modulo,item_id,decisao,comentario,origem,processado_em\n' },
    PED: { nome: 'pedidos-de-arte.csv', texto: fx('pedidos-de-arte.csv') },
    PROD: { nome: 'produtos.csv', texto: fx('produtos.csv') },
    A: { nome: 'Artes.csv', pasta: 'LEDGER', texto: fx('Artes.csv') },
    P: { nome: 'Posts.csv', pasta: 'LEDGER', texto: fx('Posts.csv') },
    M: { nome: 'Midia.csv', pasta: 'LEDGER', texto: fx('Midia.csv') },
    C: { nome: 'Checkpoints.csv', pasta: 'LEDGER', texto: fx('Checkpoints.csv') },
    R3: { nome: 'post-P-20261109-03.md', pasta: 'CRIAT', texto: fx('post-P-20261109-03.md') },
    PL: { nome: 'plano-semana.md', pasta: 'CRIAT', texto: '# plano' }
  };
}

test('obterDados lê todas as fontes e usa o cache na segunda chamada', () => {
  const e = ambiente(arquivosBase());
  const d1 = e.obterDados(false);
  assert.equal(d1.do_cache, false);
  assert.ok(d1.fontes.every((f) => f.ok), JSON.stringify(d1.fontes));
  assert.equal(d1.designs.length, 11);
  assert.equal(d1.modulos.filter((m) => !m.ativo).length, 6);
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

test('salvarDecisao só acrescenta uma linha em decisoes.csv e limpa o cache', () => {
  const e = ambiente(arquivosBase());
  e.obterDados(false);
  const r = e.salvarDecisao({ modulo: 'design', item_id: 'P-20261111-03', decisao: 'refazer', comentario: 'Trocar a foto, "maior"' });
  assert.equal(r.ok, true);
  const linhas = e.PainelLib.csvParaObjetos(e.arquivos.DEC.texto).linhas;
  assert.equal(linhas.length, 1);
  assert.equal(linhas[0].comentario, 'Trocar a foto, "maior"');
  assert.equal(linhas[0].origem, 'painel');
  assert.equal(linhas[0].processado_em, '');
  const d = e.obterDados(false);
  assert.equal(d.do_cache, false);
  assert.equal(d.designs.find((x) => x.id === 'P-20261111-03').decisao_pendente.decisao, 'refazer');
  assert.throws(() => e.salvarDecisao({ modulo: 'design', item_id: 'P-1', decisao: 'refazer', comentario: '' }), /comentário/);
  assert.equal(e.PainelLib.csvParaObjetos(e.arquivos.DEC.texto).linhas.length, 1);
});
