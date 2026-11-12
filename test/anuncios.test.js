// Testes do módulo Posts e anúncios (Gestor de Tráfego) com os arquivos reais de 12/11.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const m = { exports: {} };
new Function('module', fs.readFileSync(path.join(__dirname, '..', 'src', 'Lib.gs'), 'utf8'))(m);
const L = m.exports;
const fx = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', 'anuncios', n), 'utf8');

function fontes(comPropostas) {
  const f = {};
  for (const k of ['Anuncios', 'Campanhas', 'Resultados', 'Empresas', 'Checkpoints', 'Rules']) f[k.toLowerCase()] = L.csvParaObjetos(fx(k + '.csv'));
  f.propostas = comPropostas ? L.csvParaObjetos(fx('Propostas.csv'), L.CABECALHO_PROPOSTAS) : null;
  f.rascunhos = [{ nome: 'post-P-20261111-01.md', texto: fx('post-P-20261111-01.md'), fileId: 'md1' }];
  f.planos = [{ nome: 'plano-teste-2026-11.md', texto: fx('plano-teste-2026-11.md'), fileId: 'pl1' }];
  return f;
}
const NOITE_12 = new Date(2026, 10, 12, 19, 0);
const MANHA_12 = new Date(2026, 10, 12, 10, 0);

test('publicações reais de 12/11 aparecem com estado, horário e link', () => {
  const a = L.montarAnuncios(fontes(false), [], MANHA_12);
  const p = Object.fromEntries(a.posts.map((x) => [x.id, x]));
  for (const id of ['ORG-20261111-01', 'ORG-20261111-02', 'ORG-20261111-03', 'ORG-20261111-04', 'ORG-20261111-05', 'ORG-20261111-06', 'ORG-20261112-01']) assert.ok(p[id], id);
  assert.equal(p['ORG-20261111-01'].estado, 'publicado');
  assert.equal(p['ORG-20261111-02'].link, 'https://www.instagram.com/bd3doficial/reel/Dfnc4NFj0Q-/');
  assert.equal(p['ORG-20261111-03'].estado, 'programado');
  assert.equal(p['ORG-20261111-03'].horario, '2026-11-12 18:30');
  assert.equal(p['ORG-20261111-03'].formato, 'feed');
  assert.equal(p['ORG-20261111-05'].formato, 'story');
  assert.deepEqual(p['ORG-20261112-01'].contas, ['ig:@bd3doficial', 'fb:BD 3D']);
  assert.equal(p['ORG-20261112-01'].pedido_id, 'P-20261111-01');
  // legendas do rascunho .md ligadas pela pedido
  assert.match(p['ORG-20261112-01'].legenda_1, /^Mesa posta de Natal/);
  assert.match(p['ORG-20261112-01'].legenda_2, /^Um detalhe que muda/);
  assert.equal(p['ORG-20261112-01'].legenda_escolhida, '1');
});

test('programados das 18:30 de 12/11 viram aguardando confirmação depois do horário sem link', () => {
  const a = L.montarAnuncios(fontes(false), [], NOITE_12);
  const p = Object.fromEntries(a.posts.map((x) => [x.id, x]));
  assert.equal(p['ORG-20261111-03'].estado, 'aguardando_confirmacao');
  assert.equal(p['ORG-20261111-05'].estado, 'aguardando_confirmacao');
  assert.equal(p['ORG-20261112-01'].estado, 'programado');
  assert.equal(p['ORG-20261111-04'].estado, 'programado');
  // publicado sem link nunca é publicado
  assert.equal(L.estadoPublicacao('publicado', 'Planner smart_araxa', '2026-11-11', NOITE_12), 'aguardando_confirmacao');
});

test('planos C01 a C05 aguardando sim; campanha ativa com gasto diário e intervalo de 30 dias separado', () => {
  const a = L.montarAnuncios(fontes(false), [], NOITE_12);
  assert.deepEqual(a.inicio.planos_aguardando, ['C01', 'C02', 'C03', 'C04', 'C05']);
  const c = a.campanhas.find((x) => x.id === 'M-52562345108818');
  assert.equal(c.estado, 'ativo');
  assert.deepEqual(c.diario.map((x) => x.data), ['2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12']);
  assert.equal(c.gasto_total, 47.87);
  assert.equal(c.gasto_7d, 47.87);
  assert.equal(c.periodos.length, 1);
  assert.match(c.periodos[0].data, /\(30d\)/);
  assert.equal(c.periodos[0].gasto, 53.43);
  assert.equal(c.custo_contato, null, 'sem contatos não calcula custo');
  assert.deepEqual(c.alertas, []);
  assert.equal(a.campanhas[0].id, 'M-52562345108818', 'ativa primeiro');
  // plano ligado pela menção "Campanha C02"
  assert.equal(a.campanhas.find((x) => x.id === 'C02').plano.fileId, 'pl1');
  const sem = a.semana.empresas.find((x) => x.empresa === 'RN Sports (a confirmar)');
  assert.equal(sem.gasto, 47.87);
  assert.equal(a.semana.empresas.find((x) => x.empresa === 'BD 3D').posts_publicados, 2);
});

test('alertas de gasto: ativa sem resultado hoje e período vencido ainda ativo', () => {
  const f = fontes(false);
  f.resultados.linhas = f.resultados.linhas.filter((r) => r.data !== '2026-11-12');
  let a = L.montarAnuncios(f, [], NOITE_12);
  assert.match(a.campanhas.find((x) => x.id === 'M-52562345108818').alertas[0], /sem resultado de hoje/);
  a = L.montarAnuncios(fontes(false), [], new Date(2026, 10, 16, 9, 0));
  const al = a.campanhas.find((x) => x.id === 'M-52562345108818').alertas;
  assert.ok(al.some((t) => /período acabou em 14\/11/.test(t)), JSON.stringify(al));
  assert.ok(a.inicio.alertas.length >= 1);
});

test('Propostas.csv: posts e campanhas decidíveis, carrossel de 10 mídias, hash igual ao do consumidor', () => {
  const a = L.montarAnuncios(fontes(true), [], NOITE_12);
  assert.equal(a.propostas_ativas, true);
  const car = a.posts.find((x) => x.id === 'P-20261112-CAT');
  assert.equal(car.midias.length, 10);
  assert.equal(car.formato, 'carrossel');
  assert.deepEqual(car.decisoes_possiveis, ['aprovar', 'refazer', 'recusar']);
  assert.deepEqual(a.inicio.posts_aguardando.sort(), ['P-20261111-01', 'P-20261112-CAT']);
  const c02 = a.campanhas.find((x) => x.id === 'C02');
  assert.equal(c02.origem, 'propostas');
  assert.deepEqual(c02.decisoes_possiveis, ['aprovar', 'refazer', 'recusar']);
  assert.deepEqual(a.campanhas.find((x) => x.id === 'M-52562345108818').decisoes_possiveis, ['pausar']);
  assert.ok(a.campanhas.find((x) => x.id === 'C01').decisoes_possiveis.length === 0, 'C01 sem proposta estruturada');
  const esperado = {
    'P-20261111-01': '607f35ce898e949de9408f739e5b049b9ef984b67a6c0bc46dc7927ee17a6502',
    'P-20261112-CAT': '86cada420b41ff4707640d9a70763d5c8f35667919d43201060594c2b1da6b00',
    C02: '8ed605d1139b49e8e40f52a1489e2e05bc852ed588cbd375a9511bc9e6c30ac3',
    'M-52562345108818': 'fd52e27553dbcc2bdf543f01b409a4cadcb03a57fb155ac30c90413edb1f5ab4'
  };
  const vet = path.join(__dirname, '..', 'consumidor', 'vetores_hash.json');
  if (fs.existsSync(vet)) Object.assign(esperado, JSON.parse(fs.readFileSync(vet, 'utf8')));
  const todos = a.posts.concat(a.campanhas).filter((x) => x.snapshot_hash);
  for (const [id, h] of Object.entries(esperado)) assert.equal(todos.find((x) => x.id === id).snapshot_hash, h, id);
});

test('hash v2 normaliza CRLF dentro do campo e corta as pontas', () => {
  const base = { id: 'X', versao: '1', midia_fileIds: 'a;b', legenda_1: 'linha 1\nlinha 2', legenda_2: '', hashtags: '', contas: 'ig:@x', horario: '2026-11-13 18:30', estado: 'aguardando_aprovo' };
  const h1 = L.sha256(L.canonicoPostV2(base));
  const h2 = L.sha256(L.canonicoPostV2(Object.assign({}, base, { legenda_1: '  linha 1\r\nlinha 2 ' })));
  assert.equal(h1, h2);
  assert.equal(L.canonicoCampanha({ id: 'C9', versao: '2', verba_diaria: '8', estado: 'plano' }).split('\u001f').length, 9);
});

test('comentário em formato fixo: monta, lê e valida', () => {
  const c = L.montarComentarioAnuncio({ legenda: '1', horario: '2026-11-13 18:30', texto: 'usar a foto 2;\ncom = calma' });
  assert.equal(c, 'legenda=1;horario=2026-11-13 18:30;texto=usar a foto 2; com = calma');
  assert.deepEqual(L.parseComentarioAnuncio(c), { legenda: '1', horario: '2026-11-13 18:30', texto: 'usar a foto 2; com = calma' });
  assert.deepEqual(L.parseComentarioAnuncio(''), {});
  assert.throws(() => L.parseComentarioAnuncio('horario=2026-11-13 18:30;legenda=1'), /fora de ordem/);
  assert.throws(() => L.parseComentarioAnuncio('legenda=3'), /1 ou 2/);
  assert.throws(() => L.parseComentarioAnuncio('horario=13/11 18:30'), /aaaa-mm-dd/);
  assert.throws(() => L.parseComentarioAnuncio('verba=abc'), /número/);
  assert.throws(() => L.parseComentarioAnuncio('cor=azul'), /desconhecida/);
  assert.throws(() => L.validarComentarioAnuncio('campanha', 'aprovar', 'verba=10.5', { verba_diaria: '10' }), /maior que a proposta/);
  assert.deepEqual(L.validarComentarioAnuncio('campanha', 'aprovar', 'verba=8', { verba_diaria: '10' }), { verba: '8' });
  assert.throws(() => L.validarComentarioAnuncio('campanha', 'refazer', '', {}), /comentário/);
  assert.throws(() => L.validarComentarioAnuncio('post', 'refazer', 'legenda=1;texto=x', {}), /não vale/);
  assert.throws(() => L.validarComentarioAnuncio('campanha', 'pausar', 'verba=5', { verba_diaria: '10' }), /não vale/);
});

test('decisão pendente e recibo com link no item do módulo', () => {
  const a0 = L.montarAnuncios(fontes(true), [], NOITE_12);
  const p = a0.posts.find((x) => x.id === 'P-20261111-01');
  const dec = [
    { id: 'D-1', modulo: 'anuncios', item_id: 'post:P-20261111-01', snapshot_hash: p.snapshot_hash, decisao: 'aprovar', recibo: null },
    { id: 'D-2', modulo: 'anuncios', item_id: 'campanha:C02', snapshot_hash: 'b'.repeat(64), decisao: 'aprovar', recibo: { resultado: 'aplicado', motivo: 'ok', link: 'https://business.facebook.com/x', processado_em: '2026-11-12T20:00:00-03:00' } },
    { id: 'D-3', modulo: 'design', item_id: 'post:P-20261111-01', snapshot_hash: 'c'.repeat(64), decisao: 'aprovar', recibo: null }
  ];
  const a = L.montarAnuncios(fontes(true), dec, NOITE_12);
  const pp = a.posts.find((x) => x.id === 'P-20261111-01');
  assert.equal(pp.decisao_pendente.id, 'D-1');
  assert.equal(pp.decisao_pendente.obsoleta, false);
  assert.equal(a.campanhas.find((x) => x.id === 'C02').ultimo_recibo.link, 'https://business.facebook.com/x');
  const r = L.parseRecibo(JSON.stringify({ decision_id: 'D-2', resultado: 'aplicado', processado_em: 'x', link: 'https://a.b/c' }), 'D-2.json');
  assert.equal(r.link, 'https://a.b/c');
  assert.equal(L.parseRecibo(JSON.stringify({ decision_id: 'D-2', resultado: 'aplicado', processado_em: 'x', link: 'javascript:alert(1)' }), 'D-2.json').link, '');
});

test('contas a partir do texto livre', () => {
  assert.deepEqual(L.contasDoTexto('IG @bd3doficial + Página BD 3D'), ['ig:@bd3doficial', 'fb:BD 3D']);
  assert.deepEqual(L.contasDoTexto('Instagram @bd3doficial + Página do Facebook BD 3D (1506484655871632). Publicar só nessas.'), ['ig:@bd3doficial', 'fb:BD 3D']);
  assert.deepEqual(L.contasDoTexto('sem contas'), []);
});
