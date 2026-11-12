// v3.2.0: o servidor (Code.gs, lerCsv_) passa o cabeçalho do CSV para a Lib.
// Antes, a Lib recebia só as linhas: consertarLinha não rodava e o rateio no formato novo
// usava o hash de 5 campos, diferente de docs/contrato-financas.md.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { ambiente, arquivosBase, fx } = require('../dev/ambiente-gas');

const m = { exports: {} };
new Function('module', fs.readFileSync(path.join(__dirname, '..', 'src', 'Lib.gs'), 'utf8'))(m);
const L = m.exports;

const PASTAS = { suporte: ['SUP'], emails: ['EML'], financas: ['FIN', 'FINREC'], investimentos: ['INV'] };
const NOVO = { F1: 'financas-novo/Contas.csv', F2: 'financas-novo/contas-recebidas.csv', F3: 'financas-novo/Lancamentos.csv', F5: 'financas-novo/Rateios.csv' };

function base(novo) {
  const a = arquivosBase();
  if (novo) Object.entries(NOVO).forEach(([k, f]) => { a[k].texto = fx(f); });
  return a;
}
// Lib direto: as mesmas fontes, cada uma com csvParaObjetos inteiro (cabeçalho e linhas).
function pelaLib(a, id) {
  const fontes = {};
  Object.entries(L.MODULOS_V3[id].fontes).forEach(([k, fd]) => {
    const arq = Object.values(a).find((x) => x.nome === fd.arquivo && PASTAS[id].indexOf(x.pasta) >= 0);
    fontes[k] = arq ? L.csvParaObjetos(arq.texto, fd.obrigatorias || []) : null;
  });
  const p = {}; p[id] = fontes;
  return L.montarModulosV3(p, [], new Date())[id];
}
const hashes = (s) => Object.fromEntries(s.itens.map((i) => [i.item_id, i.snapshot_hash]));

for (const novo of [false, true]) {
  const nome = novo ? 'formato novo' : 'formato atual';
  test('v3.2.0: servidor e Lib direto dão o mesmo hash em todos os itens (' + nome + ')', () => {
    const a = base(novo);
    const d = ambiente(a).obterDados(true);
    for (const id of Object.keys(PASTAS)) {
      const srv = hashes(d.v3[id]), lib = hashes(pelaLib(a, id));
      assert.ok(Object.keys(srv).length > 0, id);
      assert.deepEqual(srv, lib, id);
    }
  });
}

test('v3.2.0: Finanças no servidor conserta a linha do formato atual e usa o hash do contrato no rateio novo', () => {
  const d = ambiente(base(false)).obterDados(true).v3.financas;
  const tv = d.itens.find((i) => i.item_id === 'conta:TV Estrela (minha parte 1/4)|2026-11');
  assert.equal(tv.consertada, true);
  assert.equal(tv.estado_texto, 'sem confirmação de pagamento; total R$ 861,53');
  assert.equal(tv.pago_em, '');
  assert.equal(tv.snapshot_hash, '1aa5159402ba86af1232549d8ff518b209dc880f3767e73b2e617c3b1280d773'); // antes: 94a9d78b…
  assert.equal(d.contas.consertadas, 1);

  const n = ambiente(base(true)).obterDados(true).v3.financas;
  const r = n.itens.find((i) => i.item_id === 'rateio:2026-10');
  assert.equal(r.formato_novo, true);
  const linha = L.csvParaObjetos(fx('financas-novo/Rateios.csv')).linhas.filter((x) => x.mes_ref === '2026-10')[0];
  assert.equal(r.snapshot_hash, L.sha256(L.canonicoRateio(linha, true)));
  assert.equal(r.snapshot_hash, '6ff1894773e2ff47970e3fa90cc8dea57b65809d44d12dca10f2b91143c7673f'); // antes: 02eb4e4f…
});
