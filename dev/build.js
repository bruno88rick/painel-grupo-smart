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
  const v201 = process.argv.includes('--v201');
  const V3 = ['suporte', 'emails', 'financas', 'investimentos'];
  if (process.argv.includes('--integrado-v3')) V3.forEach((id) => { const def = require('./modelo')().L.MODULOS_V3[id]; if (def.chave) require('./modelo')().L.CHAVES[def.chave] = true; });
  const r = mod(v201 ? new Date(2026, 10, 12, 15, 30) : new Date(2026, 10, 12, 19), [], {}, { anuncios: true, semPropostas: process.argv.includes('--sem-propostas'), v201, v3: process.argv.includes('--sem-v3') ? [] : V3 });
  if (process.argv.includes('--integrado')) { r.L.CHAVES.ANUNCIOS_INTEGRADOS = true; modelo = mod(new Date(2026, 10, 12, 19), [], {}, { anuncios: true, v3: V3 }).modelo; }
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
const v3 = modelo.v3 || {};
const defsV3 = require('./modelo')().L.MODULOS_V3;
Object.keys(v3).forEach((id) => Object.values(defsV3[id].fontes).forEach((f) => modelo.fontes.push({ rotulo: f.rotulo, ok: true, atualizado: new Date(Date.now() - 2 * 3600000).toISOString() })));
modelo.modulos = [['design', 'Designs e posts', true, 'Agente de Design'], ['anuncios', 'Posts e anúncios', !!modelo.anuncios, 'Gestor de Tráfego'], ['suporte', 'Suporte RN Sports', !!v3.suporte, 'Agente de Suporte RN Sports'], ['emails', 'E-mails', !!v3.emails, 'Gestor de E-mails'], ['financas', 'Finanças', !!v3.financas, 'Assistente Financeiro'], ['investimentos', 'Investimentos', !!v3.investimentos, 'Analista de Investimentos'], ['estudos', 'Estudos', !!v3.estudos, 'Assistente de Estudos']].map(([id, rotulo, ativo, agente]) => ({ id, rotulo, ativo, agente }));
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
      var m3 = (window.__MODELO.v3 || {})[d.modulo];
      if (m3) {
        var i3 = (m3.itens || []).filter(function (x) { return x.item_id === d.item_id; })[0];
        if (!m3.integrado) return fal(new Error('o agente ainda não lê estas decisões (' + m3.agente + '); nada foi gravado'));
        if (!i3 || i3.snapshot_hash !== d.snapshot_hash) return fal(new Error('o item mudou; atualize o painel'));
        var r3 = { ok: true, id: 'D-teste-' + (window.__DECISOES.length + 1), quando: new Date().toISOString(), versao: i3.versao, snapshot_hash: i3.snapshot_hash };
        window.__DECISOES.push(Object.assign({}, d, r3)); return ok(r3);
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
  .replace(/<\?!= include\('(\w+)'\); \?>/g, (_, n) => ler(n))
  .replace('<?= versao ?>', (fs.readFileSync(path.join(raiz, 'src', 'Lib.gs'), 'utf8').match(/VERSAO_PAINEL = '([^']+)'/) || [, '?'])[1]);
if (/<\?/.test(html)) throw new Error('sobrou scriptlet');
const out = path.join(__dirname, 'out');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'index.html'), html);
fs.cpSync(path.join(__dirname, 'img'), path.join(out, 'img'), { recursive: true });
console.log('ok', path.join(out, 'index.html'), html.length, 'bytes');
