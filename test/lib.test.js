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
  const depois = L.montarModelo(fontesReais(), [], new Date(2026, 10, 11, 20));
  assert.equal(depois.posts.find((p) => p.id === 'P-20261109-01').estado, 'publicado');
});

test('fonte ausente não derruba o modelo', () => {
  const f = fontesReais(); f.pedidos = null; f.midia = null; f.rascunhos = [];
  const m = L.montarModelo(f, [], AGORA);
  assert.ok(m.designs.length > 0);
  assert.deepEqual(m.midia, []);
  const vazio = L.montarModelo({}, [], AGORA);
  assert.deepEqual(vazio.designs, []);
});

test('decisões pendentes aparecem no item; processadas somem', () => {
  const dec = [
    { id: 'D1', item_id: 'P-20261111-02', decisao: 'aprovar', processado_em: '' },
    { id: 'D2', item_id: 'P-20261111-03', decisao: 'refazer', comentario: 'x', processado_em: '2026-11-11T10:00' }
  ];
  const m = L.montarModelo(fontesReais(), dec, AGORA);
  assert.equal(m.designs.find((d) => d.id === 'P-20261111-02').decisao_pendente.id, 'D1');
  assert.equal(m.designs.find((d) => d.id === 'P-20261111-03').decisao_pendente, null);
  assert.equal(m.inicio.decisoes_pendentes.length, 1);
});

test('validarDecisao', () => {
  assert.deepEqual(L.validarDecisao({ modulo: 'design', item_id: 'P-20261111-02', decisao: 'aprovar' }), { modulo: 'design', item_id: 'P-20261111-02', decisao: 'aprovar', comentario: '' });
  assert.throws(() => L.validarDecisao({ modulo: 'design', item_id: 'P-1', decisao: 'refazer', comentario: '  ' }), /comentário/);
  assert.throws(() => L.validarDecisao({ modulo: 'design', item_id: 'P-1', decisao: 'apagar' }), /inválida/);
  assert.throws(() => L.validarDecisao({ modulo: 'design', item_id: '../x y', decisao: 'aprovar' }), /item/);
  assert.throws(() => L.validarDecisao({ modulo: 'Design!', item_id: 'P-1', decisao: 'aprovar' }), /módulo/);
  assert.throws(() => L.validarDecisao(null), /vazia/);
  assert.equal(L.validarDecisao({ modulo: 'design', item_id: 'post:P-1', decisao: 'refazer', comentario: 'trocar foto' }).comentario, 'trocar foto');
});
