// Monta dev/out/index.html: Index + Styles + App, com google.script.run simulado
// e as fontes reais (fixtures). Uso: node dev/build.js [--erro]
const fs = require('fs'), path = require('path');
const raiz = path.join(__dirname, '..');
const ler = (n) => fs.readFileSync(path.join(raiz, 'src', n + '.html'), 'utf8');
const comErro = process.argv.includes('--erro');
const cenario = process.argv.includes('--cenario-decisoes');
let modelo;
if (cenario) {
  // 11/11 20:00: reels das 18:30 sem link; uma decisão para versão antiga; uma recusada pelo agente
  const dec = [
    { id: 'D-20261111-171000-1a2b3c4d', quando: '2026-11-11T17:10:00-03:00', modulo: 'design', item_id: 'P-20261111-03', tipo_item: 'design', versao: '1', arte_fileId: 'x', snapshot_hash: 'a'.repeat(64), decisao: 'aprovar', comentario: '', origem: 'painel' },
    { id: 'D-20261111-120000-5e6f7a8b', quando: '2026-11-11T12:00:00-03:00', modulo: 'design', item_id: 'P-20261111-01', tipo_item: 'design', versao: '1', arte_fileId: 'x', snapshot_hash: 'b'.repeat(64), decisao: 'refazer', comentario: 'trocar foto', origem: 'painel' }
  ];
  const rec = { 'D-20261111-120000-5e6f7a8b': { decision_id: 'D-20261111-120000-5e6f7a8b', resultado: 'rejeitado', motivo: 'A arte já tinha sido aprovada no chat antes desta decisão.', processado_em: '2026-11-11T14:00:00-03:00', agente: 'Agente de Design' } };
  modelo = require('./modelo')(new Date(2026, 10, 11, 20), dec, rec).modelo;
} else if (process.argv.includes('--v1')) modelo = require('./modelo')().modelo;
else {
  // v2: 12/11 19:00 com o módulo Posts e anúncios
  const mod = require('./modelo');
  const r = mod(new Date(2026, 10, 12, 19), [], {}, { anuncios: true, semPropostas: process.argv.includes('--sem-propostas') });
  if (process.argv.includes('--integrado')) { r.L.CHAVES.ANUNCIOS_INTEGRADOS = true; modelo = mod(new Date(2026, 10, 12, 19), [], {}, { anuncios: true }).modelo; }
  else modelo = r.modelo;
}
modelo.fontes = [
  { rotulo: 'Pedidos de arte', ok: true, atualizado: new Date(Date.now() - 22 * 60000).toISOString() },
  { rotulo: 'Artes (ledger do Design)', ok: true, atualizado: new Date(Date.now() - 3 * 3600000).toISOString() },
  { rotulo: 'Posts (ledger do Design)', ok: true, atualizado: new Date(Date.now() - 2 * 86400000).toISOString() },
  { rotulo: 'Mídia (ledger do Design)', ok: true, atualizado: new Date(Date.now() - 50 * 60000).toISOString() },
  { rotulo: 'Catálogo de produtos', ok: true, atualizado: new Date(Date.now() - 5 * 3600000).toISOString() },
  comErro ? { rotulo: 'Checkpoints (ledger do Design)', ok: false, erro: 'aspas sem fechar no fim do arquivo' } : { rotulo: 'Checkpoints (ledger do Design)', ok: true, atualizado: new Date(Date.now() - 4 * 3600000).toISOString() },
  { rotulo: 'Rascunhos de post', ok: true, atualizado: new Date(Date.now() - 6 * 3600000).toISOString() },
  { rotulo: 'Decisões do painel', ok: true, atualizado: new Date(Date.now() - 86400000).toISOString() },
  { rotulo: 'Recibos dos agentes', ok: true, atualizado: new Date(Date.now() - 3600000).toISOString() }
];
if (modelo.anuncios) modelo.fontes.push(
  { rotulo: 'Anúncios (ledger do Tráfego)', ok: true, atualizado: new Date(Date.now() - 40 * 60000).toISOString() },
  { rotulo: 'Campanhas (ledger do Tráfego)', ok: true, atualizado: new Date(Date.now() - 12 * 3600000).toISOString() },
  { rotulo: 'Resultados (ledger do Tráfego)', ok: true, atualizado: new Date(Date.now() - 12 * 3600000).toISOString() },
  { rotulo: 'Propostas (Tráfego)', ok: true, ausente: !modelo.anuncios.propostas_ativas, atualizado: modelo.anuncios.propostas_ativas ? new Date(Date.now() - 2 * 3600000).toISOString() : '' },
  { rotulo: 'Planos de campanha', ok: true, atualizado: new Date(Date.now() - 20 * 3600000).toISOString() });
modelo.modulos = [['design', 'Designs e posts', true, 'Agente de Design'], ['anuncios', 'Posts e anúncios', !!modelo.anuncios, 'Gestor de Tráfego'], ['financas', 'Finanças', false, 'Assistente Financeiro'], ['investimentos', 'Investimentos', false, 'Analista de Investimentos'], ['suporte', 'Suporte RN Sports', false, 'Agente de Suporte RN Sports'], ['estudos', 'Estudos', false, 'Assistente de Estudos'], ['emails', 'E-mails (só resumo)', false, 'Gestor de E-mails']].map(([id, rotulo, ativo, agente]) => ({ id, rotulo, ativo, agente }));
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
      if (d.modulo === 'anuncios') {
        var a = window.__MODELO.anuncios, ia = a.posts.concat(a.campanhas).filter(function (x) { return x.item_id === d.item_id; })[0];
        if (!a.integrados) return fal(new Error('o Gestor de Tráfego ainda não lê estas decisões; nada foi gravado'));
        if (!ia || ia.snapshot_hash !== d.snapshot_hash) return fal(new Error('o item mudou; atualize o painel'));
        var ra = { ok: true, id: 'D-teste-' + (window.__DECISOES.length + 1), quando: new Date().toISOString(), versao: ia.versao, snapshot_hash: ia.snapshot_hash };
        window.__DECISOES.push(Object.assign({}, d, ra)); return ok(ra);
      }
      var it = window.__MODELO.designs.filter(function (x) { return x.id === d.item_id; })[0];
      if (!it || it.snapshot_hash !== d.snapshot_hash || window.__FORCAR_OBSOLETO) return fal(new Error('o item ' + d.item_id + ' mudou desde que a tela foi carregada; atualize o painel e confira de novo'));
      var r = { ok: true, id: 'D-teste-' + (window.__DECISOES.length + 1), quando: new Date().toISOString(), versao: it.versao, snapshot_hash: it.snapshot_hash };
      window.__DECISOES.push(Object.assign({}, d, r)); ok(r); }, 200); }
  };
  return api;
} } };
</script>`;
let html = ler('Index')
  .replace("<?!= include('Styles'); ?>", ler('Styles'))
  .replace("<?!= include('App'); ?>", mock + ler('App'))
  .replace('<?= versao ?>', (fs.readFileSync(path.join(raiz, 'src', 'Lib.gs'), 'utf8').match(/VERSAO_PAINEL = '([^']+)'/) || [, '?'])[1]);
if (/<\?/.test(html)) throw new Error('sobrou scriptlet');
const out = path.join(__dirname, 'out');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'index.html'), html);
fs.cpSync(path.join(__dirname, 'img'), path.join(out, 'img'), { recursive: true });
console.log('ok', path.join(out, 'index.html'), html.length, 'bytes');
