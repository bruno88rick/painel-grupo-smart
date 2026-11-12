// Mede as chamadas ao Drive e ao cache de script no caminho do Início (fixtures do ambiente de teste).
// Uso: node dev/medir-chamadas.js            (src/ deste checkout)
//      PAINEL_SRC=/caminho/src node dev/medir-chamadas.js   (outra versão, por exemplo a main)
const { ambiente, arquivosBase } = require('./ambiente-gas');
const DRIVE = ['getFileById', 'getFolderById', 'getFilesByName', 'pasta.getFilesByName', 'pasta.getFiles', 'pasta.getFolders', 'pasta.getFoldersByName', 'next', 'getName', 'getLastUpdated', 'isTrashed', 'getBlob'];
const soma = (c, ks) => ks.reduce((s, k) => s + (c[k] || 0), 0);
function medir(rot, e, fn) {
  e.zerar(); fn();
  const c = Object.assign({}, e.chamadas);
  const linha = { caso: rot, drive: soma(c, DRIVE), leituras: c.getBlob || 0, getFileById: c.getFileById || 0, pastas: soma(c, ['getFolderById']), listagens: soma(c, ['pasta.getFiles', 'pasta.getFilesByName', 'pasta.getFolders', 'pasta.getFoldersByName']),
    metadados: soma(c, ['getName', 'getLastUpdated', 'isTrashed']), cache: soma(c, ['cache.get', 'cache.getAll']) };
  console.log(JSON.stringify(linha));
  return linha;
}
const e = ambiente(arquivosBase());
const caminho = e.obterInicio ? () => e.obterInicio(true) : () => e.obterDados(true);
medir('Início, cache frio', e, caminho);
medir('Início, cache de arquivos quente', e, caminho);
if (e.obterModulo) {
  const f = ambiente(arquivosBase());
  ['suporte', 'emails', 'financas', 'investimentos', 'estudos'].forEach((id) => medir('módulo ' + id, f, () => f.obterModulo(id, true)));
}
