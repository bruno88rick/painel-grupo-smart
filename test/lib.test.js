// Testes de leitura e parsing do Painel. Rodar: node --test test/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const L = carregarLib();

function carregarLib() {
  // Lib.gs é JavaScript puro; roda no mesmo contexto do Node para os testes
  const m = { exports: {} };
  new Function('module', fs.readFileSync(path.join(__dirname, '..', 'src', 'Lib.gs'), 'utf8'))(m);
  return m.exports;
}
const fx = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8');
const ler = (n, obrig) => L.csvParaObjetos(fx(n), obrig);
const AGORA = new Date(2026, 10, 11, 15, 0);

function fontesReais() {
  return {
    pedidos: ler('pedidos-de-arte.csv', ['id', 'estado']),
    artes: ler('Artes.csv', ['id', 'arte_fileId']),
    posts: ler('Posts.csv'),
    midia: ler('Midia.csv', ['fileId']),
    produtos: ler('produtos.csv'),
    rascunhos: [{ nome: 'post-P-20261109-03.md', texto: fx('post-P-20261109-03.md'), fileId: 'md03', atualizado: '2026-11-11T12:00:00Z' }]
  };
}

test('CSV com BOM, CRLF, aspas e quebra de linha no campo', () => {
  const t = '\ufeffid,txt\r\n1,"a, ""b""\r\nc"\r\n2,simples\r\n';
  const r = L.parseCsv(t);
  assert.deepEqual(r, [['id', 'txt'], ['1', 'a, "b"\nc'], ['2', 'simples']]);
});

test('CSV quebrado lança erro', () => {
  assert.throws(() => L.parseCsv('id,txt\n1,"sem fechar\n'), /aspas sem fechar/);
  assert.throws(() => L.parseCsv('id,txt\n1,ab"c"\n'), /aspas no meio/);
  assert.throws(() => L.csvParaObjetos(''), /sem cabeçalho/);
});

test('coluna obrigatória ausente vira erro; linha curta vira aviso', () => {
  assert.throws(() => L.csvParaObjetos('a,b\n1,2\n', ['id']), /faltam colunas: id/);
  const o = L.csvParaObjetos('id,b,c\n1,2\n');
  assert.equal(o.linhas[0].c, '');
  assert.equal(o.avisos.length, 1);
});

test('CSVs reais do Drive são lidos sem avisos', () => {
  for (const [n, qtd] of [['pedidos-de-arte.csv', 6], ['Artes.csv', 12], ['Midia.csv', 12], ['produtos.csv', 1], ['Posts.csv', 0], ['Checkpoints.csv', 3]]) {
    const o = ler(n);
    assert.equal(o.linhas.length, qtd, n);
    assert.deepEqual(o.avisos, [], n);
  }
});

test('csvLinha escapa vírgula, aspas e quebra', () => {
  assert.equal(L.csvLinha(['a', 'b,c', 'd"e', 'f\ng', '']), 'a,"b,c","d""e","f\ng",');
  assert.deepEqual(L.parseCsv(L.csvLinha(['x,y', 'z"w']))[0], ['x,y', 'z"w']);
});

test('parsePostObs do P-20261109-01 (story publicado + reels programado)', () => {
  const p = ler('pedidos-de-arte.csv').linhas.find((x) => x.id === 'P-20261109-01');
  const m = L.parsePostObs(p.obs);
  assert.equal(m.length, 2);
  assert.equal(m[0].tipo, 'publicado');
  assert.equal(m[0].link, 'https://www.instagram.com/stories/bd3doficial/');
  assert.equal(m[0].formato, 'story');
  assert.equal(m[0].quando, '2026-11-11');
  assert.equal(m[1].tipo, 'programado');
  assert.equal(m[1].quando, '2026-11-11 18:30');
  assert.equal(m[1].formato, 'reels');
  assert.deepEqual(L.parsePostObs('post:manual'), [{ tipo: 'manual', link: null, quando: null, texto: 'manual' }]);
  assert.deepEqual(L.parsePostObs(''), []);
});

test('parsePostMd do post-P-20261109-03.md', () => {
  const r = L.parsePostMd(fx('post-P-20261109-03.md'), 'post-P-20261109-03.md');
  assert.equal(r.pedido_id, 'P-20261109-03');
  assert.equal(r.empresa, 'BD 3D');
  assert.equal(r.titulo, 'Presépio iluminado');
  assert.equal(r.aprovado, true);
  assert.match(r.legenda_versao, /APROVADA/);
  assert.match(r.legenda, /^Presépio iluminado, com vela inclusa/);
  assert.match(r.hashtags, /#BD3D .*#PresentesDeNatal/);
  assert.match(r.contas, /@bd3doficial/);
  assert.match(r.formato, /feed/);
});

test('modelo: P-20261111-02 e 03 esperam aprovação; refazer de 09/11 não está parado em 11/11', () => {
  const m = L.montarModelo(fontesReais(), [], AGORA, { dias_refazer_parado: 2 });
  assert.deepEqual(m.inicio.artes_entregues.sort(), ['P-20261111-02', 'P-20261111-03']);
  const refazer = m.designs.filter((d) => d.estado === 'refazer').map((d) => d.id).sort();
  assert.deepEqual(refazer, ['A-20261109-01', 'A-20261109-02', 'A-20261109-03', 'A-20261109-04', 'A-20261109-05']);
  assert.deepEqual(m.inicio.refazer_parados, []);
  // três dias depois já conta como parado
  const m2 = L.montarModelo(fontesReais(), [], new Date(2026, 10, 12, 9), { dias_refazer_parado: 2 });
  assert.equal(m2.inicio.refazer_parados.length, 5);
  assert.ok(m.empresas.includes('BD 3D'));
  assert.equal(m.midia.length, 12);
  assert.equal(m.produtos[0].preco, 'R$ 9,97 o kit');
});

test('modelo: estados dos posts', () => {
  const m = L.montarModelo(fontesReais(), [], AGORA);
  const p1 = m.posts.find((p) => p.id === 'P-20261109-01');
  assert.equal(p1.estado, 'programado'); // reels às 18:30 de 11/11, ainda no futuro às 15:00
  const p3 = m.posts.find((p) => p.id === 'P-20261109-03');
  assert.equal(p3.estado, 'aprovado'); // rascunho aprovado, sem post: ainda
  // 20:00: o reels das 18:30 não tem link; o relógio não prova publicação
  const depois = L.montarModelo(fontesReais(), [], new Date(2026, 10, 11, 20));
  assert.equal(depois.posts.find((p) => p.id === 'P-20261109-01').estado, 'aguardando_confirmacao');
  assert.deepEqual(depois.inicio.posts_sem_confirmacao, ['P-20261109-01']);
  // com o link do reels, vira publicado
  const f = fontesReais();
  const ped = f.pedidos.linhas.find((x) => x.id === 'P-20261109-01');
  ped.obs += '; post:https://www.instagram.com/reel/abc/ 2026-11-11 reels';
  assert.equal(L.montarModelo(f, [], new Date(2026, 10, 11, 20)).posts.find((p) => p.id === 'P-20261109-01').estado, 'publicado');
});

test('fonte ausente não derruba o modelo', () => {
  const f = fontesReais(); f.pedidos = null; f.midia = null; f.rascunhos = [];
  const m = L.montarModelo(f, [], AGORA);
  assert.ok(m.designs.length > 0);
  assert.deepEqual(m.midia, []);
  const vazio = L.montarModelo({}, [], AGORA);
  assert.deepEqual(vazio.designs, []);
});

test('snapshot: hash do texto canônico, igual ao sha256 do Python/Node', () => {
  const crypto = require('crypto');
  const m = L.montarModelo(fontesReais(), [], AGORA);
  const d = m.designs.find((x) => x.id === 'P-20261111-02');
  const canon = ['design', 'P-20261111-02', d.versao, d.arte_fileId, d.canva_design_id, 'entregue'].join('\u001f');
  assert.equal(L.canonicoDesign(d), canon);
  assert.equal(d.snapshot_hash, crypto.createHash('sha256').update(canon).digest('hex'));
  const p = m.posts.find((x) => x.id === 'P-20261109-03');
  assert.equal(p.snapshot_hash, crypto.createHash('sha256').update(L.canonicoPost(p)).digest('hex'));
  assert.match(L.canonicoPost(p), /Presépio iluminado, com vela inclusa/);
});

test('snapshot muda quando muda a versão, a arte ou a legenda', () => {
  const h1 = L.montarModelo(fontesReais(), [], AGORA).designs.find((x) => x.id === 'P-20261111-02').snapshot_hash;
  const f = fontesReais();
  f.artes.linhas.find((a) => a.pedido_id === 'P-20261111-02').arte_fileId = 'OUTRO_ARQUIVO_123';
  const h2 = L.montarModelo(f, [], AGORA).designs.find((x) => x.id === 'P-20261111-02').snapshot_hash;
  assert.notEqual(h1, h2);
  const f2 = fontesReais();
  f2.rascunhos[0].texto = f2.rascunhos[0].texto.replace('vela inclusa', 'vela à parte');
  const p1 = L.montarModelo(fontesReais(), [], AGORA).posts.find((x) => x.id === 'P-20261109-03').snapshot_hash;
  const p2 = L.montarModelo(f2, [], AGORA).posts.find((x) => x.id === 'P-20261109-03').snapshot_hash;
  assert.notEqual(p1, p2);
});

test('decisão pendente até existir recibo; recibo rejeitado aparece; versão antiga fica obsoleta', () => {
  const base = L.montarModelo(fontesReais(), [], AGORA);
  const h02 = base.designs.find((d) => d.id === 'P-20261111-02').snapshot_hash;
  const dec = [
    { id: 'D-1', item_id: 'P-20261111-02', versao: '1', snapshot_hash: h02, decisao: 'aprovar' },
    { id: 'D-2', item_id: 'P-20261111-03', versao: '1', snapshot_hash: 'a'.repeat(64), decisao: 'refazer', comentario: 'x' },
    { id: 'D-3', item_id: 'P-20261111-01', versao: '1', snapshot_hash: 'b'.repeat(64), decisao: 'aprovar' }
  ];
  const recibos = { 'D-3': { decision_id: 'D-3', resultado: 'rejeitado', motivo: 'versão mudou', processado_em: '2026-11-11T16:00' } };
  const m = L.montarModelo(fontesReais(), dec, AGORA, { recibos });
  const d02 = m.designs.find((d) => d.id === 'P-20261111-02').decisao_pendente;
  assert.equal(d02.id, 'D-1'); assert.equal(d02.obsoleta, false);
  assert.equal(m.designs.find((d) => d.id === 'P-20261111-03').decisao_pendente.obsoleta, true);
  assert.equal(m.designs.find((d) => d.id === 'P-20261111-01').decisao_pendente, null);
  assert.equal(m.inicio.decisoes_pendentes.length, 2);
  assert.equal(m.inicio.decisoes_recusadas[0].recibo.motivo, 'versão mudou');
});

test('conferirDecisao: aceita a versão exibida e rejeita obsoleta, estado errado e repetida', () => {
  const m = L.montarModelo(fontesReais(), [], AGORA);
  const d = m.designs.find((x) => x.id === 'P-20261111-02');
  const ok = L.conferirDecisao(m, { item_id: 'P-20261111-02', snapshot_hash: d.snapshot_hash });
  assert.deepEqual(ok, { tipo_item: 'design', versao: d.versao, arte_fileId: d.arte_fileId, snapshot_hash: d.snapshot_hash });
  assert.throws(() => L.conferirDecisao(m, { item_id: 'P-20261111-02', snapshot_hash: 'c'.repeat(64) }), /mudou/);
  const aprovado = m.designs.find((x) => x.id === 'P-20261111-01');
  assert.throws(() => L.conferirDecisao(m, { item_id: 'P-20261111-01', snapshot_hash: aprovado.snapshot_hash }), /não aceita/);
  assert.throws(() => L.conferirDecisao(m, { item_id: 'P-99999999-99', snapshot_hash: d.snapshot_hash }), /não existe/);
  const p3 = m.posts.find((x) => x.id === 'P-20261109-03');
  assert.throws(() => L.conferirDecisao(m, { item_id: 'post:P-20261109-03', snapshot_hash: p3.snapshot_hash }), /não está integrada/);
  const pr = m.posts.find((x) => x.estado === 'aguardando_aprovo' || x.estado === 'rascunho');
  if (pr) assert.throws(() => L.conferirDecisao(m, { item_id: 'post:' + pr.id, snapshot_hash: pr.snapshot_hash }), /não está integrada/);
  const m2 = L.montarModelo(fontesReais(), [{ id: 'D-9', item_id: 'P-20261111-02', snapshot_hash: d.snapshot_hash, decisao: 'aprovar' }], AGORA);
  assert.throws(() => L.conferirDecisao(m2, { item_id: 'P-20261111-02', snapshot_hash: d.snapshot_hash }), /já existe/);
});

test('parseRecibo', () => {
  const r = L.parseRecibo(JSON.stringify({ decision_id: 'D-1', resultado: 'aplicado', processado_em: '2026-11-11T16:00:00-03:00', agente: 'Agente de Design', snapshot_hash: 'a'.repeat(64) }), 'D-1.json');
  assert.equal(r.resultado, 'aplicado');
  assert.throws(() => L.parseRecibo('{"decision_id":"D-2","resultado":"aplicado","processado_em":"x"}', 'D-1.json'), /nome do arquivo/);
  assert.throws(() => L.parseRecibo('{"decision_id":"D-1","resultado":"talvez","processado_em":"x"}', 'D-1.json'), /resultado/);
  assert.throws(() => L.parseRecibo('{"decision_id":"D-1","resultado":"aplicado"}', 'D-1.json'), /processado_em/);
  assert.throws(() => L.parseRecibo('não é json', 'D-1.json'));
});

test('validarDecisao', () => {
  const H = 'a'.repeat(64);
  assert.deepEqual(L.validarDecisao({ modulo: 'design', item_id: 'P-20261111-02', decisao: 'aprovar', snapshot_hash: H }), { modulo: 'design', item_id: 'P-20261111-02', decisao: 'aprovar', comentario: '', snapshot_hash: H });
  assert.throws(() => L.validarDecisao({ modulo: 'design', item_id: 'P-1', decisao: 'aprovar' }), /versão exibida/);
  assert.throws(() => L.validarDecisao({ modulo: 'design', item_id: 'P-1', decisao: 'aprovar', snapshot_hash: 'xyz' }), /versão exibida/);
  assert.throws(() => L.validarDecisao({ modulo: 'design', item_id: 'P-1', decisao: 'refazer', comentario: '  ' }), /comentário/);
  assert.throws(() => L.validarDecisao({ modulo: 'design', item_id: 'P-1', decisao: 'apagar' }), /inválida/);
  assert.throws(() => L.validarDecisao({ modulo: 'design', item_id: '../x y', decisao: 'aprovar' }), /item/);
  assert.throws(() => L.validarDecisao({ modulo: 'Design!', item_id: 'P-1', decisao: 'aprovar' }), /módulo/);
  assert.throws(() => L.validarDecisao(null), /vazia/);
  assert.equal(L.validarDecisao({ modulo: 'design', item_id: 'post:P-1', decisao: 'refazer', comentario: 'trocar foto', snapshot_hash: H }).comentario, 'trocar foto');
});

test('versão do painel: semver e igual ao package.json', () => {
  assert.match(L.VERSAO_PAINEL, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
  assert.equal(L.VERSAO_PAINEL, require('../package.json').version);
});
