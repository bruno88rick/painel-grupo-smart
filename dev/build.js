// Monta dev/out/index.html: Index + Styles + App, com google.script.run simulado
// e as fontes reais (fixtures). Uso: node dev/build.js [--erro]
const fs = require('fs'), path = require('path');
const raiz = path.join(__dirname, '..');
const ler = (n) => fs.readFileSync(path.join(raiz, 'src', n + '.html'), 'utf8');
const { modelo } = require('./modelo')();
const comErro = process.argv.includes('--erro');
modelo.fontes = [
  { rotulo: 'Pedidos de arte', ok: true, atualizado: new Date(Date.now() - 22 * 60000).toISOString() },
  { rotulo: 'Artes (ledger do Design)', ok: true, atualizado: new Date(Date.now() - 3 * 3600000).toISOString() },
  { rotulo: 'Posts (ledger do Design)', ok: true, atualizado: new Date(Date.now() - 2 * 86400000).toISOString() },
  { rotulo: 'Mídia (ledger do Design)', ok: true, atualizado: new Date(Date.now() - 50 * 60000).toISOString() },
  { rotulo: 'Catálogo de produtos', ok: true, atualizado: new Date(Date.now() - 5 * 3600000).toISOString() },
  comErro ? { rotulo: 'Checkpoints (ledger do Design)', ok: false, erro: 'aspas sem fechar no fim do arquivo' } : { rotulo: 'Checkpoints (ledger do Design)', ok: true, atualizado: new Date(Date.now() - 4 * 3600000).toISOString() },
  { rotulo: 'Rascunhos de post', ok: true, atualizado: new Date(Date.now() - 6 * 3600000).toISOString() },
  { rotulo: 'Decisões do painel', ok: true, atualizado: new Date(Date.now() - 86400000).toISOString() }
];
modelo.modulos = [['design', 'Designs e posts', true, 'Agente de Design'], ['anuncios', 'Posts e anúncios', false, 'Gestor de Tráfego'], ['financas', 'Finanças', false, 'Assistente Financeiro'], ['investimentos', 'Investimentos', false, 'Analista de Investimentos'], ['suporte', 'Suporte RN Sports', false, 'Agente de Suporte RN Sports'], ['estudos', 'Estudos', false, 'Assistente de Estudos'], ['emails', 'E-mails (só resumo)', false, 'Gestor de E-mails']].map(([id, rotulo, ativo, agente]) => ({ id, rotulo, ativo, agente }));
modelo.gerado_em = new Date().toISOString();
const mock = `<script>
window.PAINEL_THUMB = function (id) { return 'img/' + id + '.jpg'; };
window.__MODELO = ${JSON.stringify(modelo)};
window.__DECISOES = [];
window.google = { script: { get run() {
  var ok = function () {}, fal = function () {};
  var api = {
    withSuccessHandler: function (f) { ok = f; return api; },
    withFailureHandler: function (f) { fal = f; return api; },
    obterDados: function () { setTimeout(function () { ok(JSON.parse(JSON.stringify(window.__MODELO))); }, 250); },
    obterMiniatura: function () { setTimeout(function () { ok(''); }, 50); },
    salvarDecisao: function (d) { setTimeout(function () {
      if (d.decisao === 'refazer' && !String(d.comentario || '').trim()) return fal(new Error('o pedido de ajuste precisa de um comentário'));
      var r = { ok: true, id: 'D-teste-' + (window.__DECISOES.length + 1), quando: new Date().toISOString() };
      window.__DECISOES.push(Object.assign({}, d, r)); ok(r); }, 200); }
  };
  return api;
} } };
</script>`;
let html = ler('Index')
  .replace("<?!= include('Styles'); ?>", ler('Styles'))
  .replace("<?!= include('App'); ?>", mock + ler('App'));
if (/<\?/.test(html)) throw new Error('sobrou scriptlet');
const out = path.join(__dirname, 'out');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'index.html'), html);
fs.cpSync(path.join(__dirname, 'img'), path.join(out, 'img'), { recursive: true });
console.log('ok', path.join(out, 'index.html'), html.length, 'bytes');
