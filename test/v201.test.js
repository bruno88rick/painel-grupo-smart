// v2.0.1: correções vistas na produção de 12/11 (arquivos reais do Tráfego das 15:05).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const m = { exports: {} };
new Function('module', fs.readFileSync(path.join(__dirname, '..', 'src', 'Lib.gs'), 'utf8'))(m);
const L = m.exports;
const fx = (d, n) => fs.readFileSync(path.join(__dirname, 'fixtures', d, n), 'utf8');

function fontes(trocar) {
  const f = {};
  for (const k of ['Resultados', 'Empresas', 'Checkpoints', 'Rules']) f[k.toLowerCase()] = L.csvParaObjetos(fx('anuncios', k + '.csv'));
  f.anuncios = L.csvParaObjetos(fx('v201', 'Anuncios.csv'));
  f.campanhas = L.csvParaObjetos(fx('v201', 'Campanhas.csv'));
  let prop = fx('v201', 'Propostas.csv');
  if (trocar) prop = trocar(prop);
  f.propostas = L.csvParaObjetos(prop, L.CABECALHO_PROPOSTAS);
  f.rascunhos = [];
  f.planos = [];
  return f;
}
const TARDE_12 = new Date(2026, 10, 12, 15, 30);

test('período: campo vazio na proposta usa o ledger; proposta preenchida manda', () => {
  const a = L.montarAnuncios(fontes(), [], TARDE_12);
  const c = Object.fromEntries(a.campanhas.map((x) => [x.id, x]));
  assert.equal(c.C01.inicio, 'após aprovação');
  assert.equal(c.C01.fim, '2026-12-18');
  assert.equal(c.C03.inicio, 'após aprovação');
  assert.equal(c.C03.fim, '30 dias');
  assert.equal(c.C01.verba_diaria, '15');
  // ativa: proposta traz as datas
  assert.equal(c['M-52562345108818'].inicio, '2026-11-04');
  assert.equal(c['M-52562345108818'].fim, '2026-11-14');
  // verba vazia na proposta, vazia no ledger: continua vazia
  assert.equal(c['M-52562345108818'].verba_diaria, '');
  for (const x of a.campanhas) { assert.ok(x.inicio, x.id + ' sem início'); assert.ok(x.fim, x.id + ' sem fim'); }
});

test('campanha: campanha_id com ou sem M- cai na mesma campanha do ledger, sem duplicar', () => {
  for (const [nome, trocar] of [
    ['com M-', null],
    ['sem M-', (t) => t.replace(/,M-52562345108818,,2026-11-04/, ',52562345108818,,2026-11-04')],
    ['id da proposta sem M- e campanha_id vazio', (t) => t.replace(/^M-52562345108818,campanha(.*?),M-52562345108818,/m, '52562345108818,campanha$1,,')]
  ]) {
    const a = L.montarAnuncios(fontes(trocar), [], TARDE_12);
    const ativas = a.campanhas.filter((x) => x.estado === 'ativo');
    assert.equal(ativas.length, 1, nome + ': ' + ativas.map((x) => x.id).join(' '));
    const c = ativas[0];
    assert.equal(c.id, 'M-52562345108818', nome);
    assert.equal(c.origem, 'propostas', nome);
    assert.match(c.objetivo, /Araxá vai entrar no ritmo/, nome);
    assert.equal(c.plataforma_id, '52562345108818', nome);
    assert.equal(a.campanhas.length, 8, nome);
  }
});

test('post: proposta é um cartão só, com as programações de feed e story dentro', () => {
  const a = L.montarAnuncios(fontes(), [], TARDE_12);
  const ids = a.posts.map((x) => x.id).sort();
  assert.deepEqual(ids, ['ORG-20261111-01', 'ORG-20261111-02', 'P-20261109-02', 'P-20261109-03', 'P-20261111-01']);
  const p = a.posts.find((x) => x.id === 'P-20261109-03');
  assert.equal(p.origem, 'propostas');
  assert.deepEqual(p.programacoes.map((x) => [x.id, x.formato, x.horario]), [['ORG-20261111-04', 'feed', '2026-11-14 19:00'], ['ORG-20261111-06', 'story', '2026-11-14 19:05']]);
  assert.equal(p.programacoes[0].onde, 'Planner smart_araxa');
  assert.deepEqual(a.posts.find((x) => x.id === 'P-20261109-02').programacoes.map((x) => x.id), ['ORG-20261111-03', 'ORG-20261111-05']);
  assert.deepEqual(a.posts.find((x) => x.id === 'P-20261111-01').programacoes.map((x) => x.id), ['ORG-20261112-01']);
  // reels e story do vídeo (sem proposta, horários diferentes) seguem separados
  assert.equal(a.posts.find((x) => x.id === 'ORG-20261111-02').programacoes.length, 1);
});

test('post: sem pedido no texto, junta pela mídia + horário', () => {
  const a = L.montarAnuncios(fontes(), [], TARDE_12);
  const f = fontes();
  f.anuncios.linhas = f.anuncios.linhas.map((r) => r.id === 'ORG-20261111-04' ? Object.assign({}, r, { texto_resumo: 'Post Presépio iluminado, feed' }) : r);
  const b = L.montarAnuncios(f, [], TARDE_12);
  assert.equal(b.posts.length, a.posts.length);
  assert.ok(b.posts.find((x) => x.id === 'P-20261109-03').programacoes.some((x) => x.id === 'ORG-20261111-04'));
  // duas linhas do ledger, sem proposta, mesma mídia e mesmo horário: um cartão
  const g = fontes();
  g.propostas = null;
  g.anuncios.linhas.push(Object.assign({}, g.anuncios.linhas.find((r) => r.id === 'ORG-20261111-04'), { id: 'ORG-20261199-01', texto_resumo: 'repetido' }));
  const c = L.montarAnuncios(g, [], TARDE_12);
  const card = c.posts.find((x) => x.id === 'ORG-20261111-04');
  assert.deepEqual(card.programacoes.map((x) => x.id), ['ORG-20261111-04', 'ORG-20261199-01']);
  assert.ok(!c.posts.find((x) => x.id === 'ORG-20261199-01'));
});

test('hash da proposta não muda com a junção (consumidor segue igual)', () => {
  const a = L.montarAnuncios(fontes(), [], TARDE_12);
  const r = L.csvParaObjetos(fx('v201', 'Propostas.csv'), L.CABECALHO_PROPOSTAS).linhas.find((x) => x.id === 'P-20261109-03');
  assert.equal(a.posts.find((x) => x.id === 'P-20261109-03').snapshot_hash, L.sha256(L.canonicoPostV2(r)));
});
