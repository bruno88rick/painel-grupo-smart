// Gera o modelo a partir das fixtures (mesmo código do servidor)
const fs = require('fs'), path = require('path');
const m = { exports: {} };
new Function('module', fs.readFileSync(path.join(__dirname, '..', 'src', 'Lib.gs'), 'utf8'))(m);
const L = m.exports;
const fx = (n) => fs.readFileSync(path.join(__dirname, '..', 'test', 'fixtures', n), 'utf8');
const fa = (n) => fx('anuncios/' + n);
function fontesAnuncios(semPropostas, v201) {
  const f = {};
  const de = (k) => v201 && ['Anuncios', 'Campanhas', 'Propostas'].includes(k) ? fx('v201/' + k + '.csv') : fa(k + '.csv');
  for (const k of ['Anuncios', 'Campanhas', 'Resultados', 'Empresas', 'Checkpoints', 'Rules']) f[k.toLowerCase()] = L.csvParaObjetos(de(k));
  f.propostas = semPropostas ? null : L.csvParaObjetos(de('Propostas'), L.CABECALHO_PROPOSTAS);
  f.rascunhos = [{ nome: 'post-P-20261111-01.md', texto: fa('post-P-20261111-01.md'), fileId: '1uPNBBhnkSNH-F1LeJZAZNADkvs_ybfmj' }];
  f.planos = [{ nome: 'plano-teste-2026-11.md', texto: fa('plano-teste-2026-11.md'), fileId: '1fSzU-k4WdftEEuALxddiFfc4IjhvUVCQ' }];
  return f;
}
/** Fontes dos módulos v3 a partir de test/fixtures/<modulo>/ (mesmos nomes de arquivo do agente). */
function fontesV3(mods) {
  const r = {};
  (mods || []).forEach((id) => {
    const def = L.MODULOS_V3[id]; if (!def) return;
    const f = {};
    Object.keys(def.fontes).forEach((k) => {
      const p = path.join(__dirname, '..', 'test', 'fixtures', id, def.fontes[k].arquivo);
      let t = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
      // Aportes.csv real não tem aporte pendente hoje: a mesma linha fictícia do ambiente de teste mostra a decisão.
      if (t !== null && id === 'investimentos' && k === 'aportes') t += require('./ambiente-gas').APORTE_PLANEJADO;
      f[k] = t === null ? null : L.csvParaObjetos(t);
    });
    r[id] = f;
  });
  return r;
}
module.exports = function (agora, decisoes, recibos, opc) {
  opc = opc || {};
  const f = {
    pedidos: L.csvParaObjetos(fx('pedidos-de-arte.csv')), artes: L.csvParaObjetos(fx('Artes.csv')),
    posts: L.csvParaObjetos(fx('Posts.csv')), midia: L.csvParaObjetos(fx('Midia.csv')), produtos: L.csvParaObjetos(fx('produtos.csv')),
    rascunhos: [['01', '1hIkYMvmnss7Ibq70zEFn4S_RYxAczast'], ['02', '1PWxmiLhIOicmd5AUClSY41CXrESeg4KI'], ['03', '1LhM7-rjrSUKYWL5K4HT-WAHlQZ4ekyrH']].map(([n, id]) => ({ nome: 'post-P-20261109-' + n + '.md', texto: fx('post-P-20261109-' + n + '.md'), fileId: id, atualizado: '2026-11-11T14:00:00Z' }))
  };
  const ag = agora || new Date(2026, 10, 11, 15);
  const modelo = L.montarModelo(f, decisoes || [], ag, { dias_refazer_parado: 2, recibos: recibos || {}, anuncios: opc.anuncios ? fontesAnuncios(opc.semPropostas, opc.v201) : null });
  modelo.v3 = L.montarModulosV3(fontesV3(opc.v3), L.decisoesComRecibos(decisoes || [], recibos || {}), ag);
  if (modelo.v3.estudos) {
    // Como o servidor: pastas do config e fileId dos resumos achados na pasta de materiais (a mesma do ambiente de teste).
    const arq = require('./ambiente-gas').arquivosBase();
    const est = modelo.v3.estudos;
    est.pastas = { ledger: 'EST', materiais: 'MAT' };
    est.links = {};
    est.caminhos.forEach((c) => {
      const p = c.split('/'), nome = p.pop();
      const id = Object.keys(arq).find((k) => arq[k].nome === nome && !arq[k].ehPasta && (p.length === 0 ? ['MAT', 'MATSUB'].includes(arq[k].pasta) : p.join('/') === 'espec_omega' && arq[k].pasta === 'MATSUB'));
      if (id) est.links[c] = id;
    });
  }
  return { L, modelo, fontesV3 };
};
if (require.main === module) {
  const { modelo } = module.exports();
  const ids = new Set();
  modelo.designs.forEach((d) => { if (d.arte_fileId) ids.add(d.arte_fileId); d.versoes.forEach((v) => v.arte_fileId && ids.add(v.arte_fileId)); });
  modelo.midia.forEach((x) => ids.add(x.fileId));
  console.log([...ids].join('\n'));
}
