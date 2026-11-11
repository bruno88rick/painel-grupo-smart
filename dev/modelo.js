// Gera o modelo a partir das fixtures (mesmo código do servidor)
const fs = require('fs'), path = require('path');
const m = { exports: {} };
new Function('module', fs.readFileSync(path.join(__dirname, '..', 'src', 'Lib.gs'), 'utf8'))(m);
const L = m.exports;
const fx = (n) => fs.readFileSync(path.join(__dirname, '..', 'test', 'fixtures', n), 'utf8');
module.exports = function (agora, decisoes, recibos) {
  const f = {
    pedidos: L.csvParaObjetos(fx('pedidos-de-arte.csv')), artes: L.csvParaObjetos(fx('Artes.csv')),
    posts: L.csvParaObjetos(fx('Posts.csv')), midia: L.csvParaObjetos(fx('Midia.csv')), produtos: L.csvParaObjetos(fx('produtos.csv')),
    rascunhos: [['01', '1hIkYMvmnss7Ibq70zEFn4S_RYxAczast'], ['02', '1PWxmiLhIOicmd5AUClSY41CXrESeg4KI'], ['03', '1LhM7-rjrSUKYWL5K4HT-WAHlQZ4ekyrH']].map(([n, id]) => ({ nome: 'post-P-20261109-' + n + '.md', texto: fx('post-P-20261109-' + n + '.md'), fileId: id, atualizado: '2026-11-11T14:00:00Z' }))
  };
  return { L, modelo: L.montarModelo(f, decisoes || [], agora || new Date(2026, 10, 11, 15), { dias_refazer_parado: 2, recibos: recibos || {} }) };
};
if (require.main === module) {
  const { modelo } = module.exports();
  const ids = new Set();
  modelo.designs.forEach((d) => { if (d.arte_fileId) ids.add(d.arte_fileId); d.versoes.forEach((v) => v.arte_fileId && ids.add(v.arte_fileId)); });
  modelo.midia.forEach((x) => ids.add(x.fileId));
  console.log([...ids].join('\n'));
}
