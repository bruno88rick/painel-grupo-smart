// v3.0.1: Início primeiro, cada módulo v3 numa chamada própria (obterModulo), cada um com o seu cache.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { ambiente, arquivosBase } = require('../dev/ambiente-gas');

const V3 = ['suporte', 'emails', 'financas', 'investimentos', 'estudos'];
const DO_V3 = /^(S|E|F|I|T)\d$/; // arquivos dos ledgers v3 no ambiente de teste
const semData = (o) => JSON.parse(JSON.stringify(o, (k, v) => (k === 'gerado_em' || k === 'do_cache' || k === 'desatualizado' ? undefined : v)));

test('v3.0.1 obterInicio: não lê nenhum arquivo dos módulos v3 e diz quais módulos pedir', () => {
  const e = ambiente(arquivosBase());
  const d = e.obterInicio(true);
  assert.deepEqual(d.v3, {});
  assert.deepEqual(d.v3_ids, V3);
  assert.deepEqual(Object.keys(e.leituras).filter((id) => DO_V3.test(id)), []);
  assert.ok(!d.fontes.some((f) => /Suporte|E-mails|Finanças|Investimentos|Estudos|Chamados|Contas|Posições|Cursos/.test(f.rotulo)), JSON.stringify(d.fontes.map((f) => f.rotulo)));
  // Design e anúncios iguais aos da v3.0.0 (obterDados continua montando tudo)
  const t = e.obterDados(true);
  assert.deepEqual(semData(d.designs), semData(t.designs));
  assert.deepEqual(semData(d.inicio), semData(t.inicio));
  assert.deepEqual(semData(d.anuncios), semData(t.anuncios));
  assert.equal(d.decisoes_ok, true);
});

test('v3.0.1 obterModulo: cada módulo sozinho é igual ao da carga completa e traz só as próprias fontes', () => {
  const e = ambiente(arquivosBase());
  const t = e.obterDados(true);
  V3.forEach((id) => {
    const r = ambiente(arquivosBase()).obterModulo(id, true);
    assert.equal(r.id, id);
    assert.deepEqual(semData(r.modulo), semData(t.v3[id]), id);
    const def = e.PainelLib.MODULOS_V3[id];
    assert.deepEqual(r.fontes.map((f) => f.rotulo), Object.values(def.fontes).map((f) => f.rotulo), id);
    assert.ok(r.fontes.every((f) => f.ok), id + ' ' + JSON.stringify(r.fontes));
  });
  assert.throws(() => e.obterModulo('nada', true), /módulo desconhecido/);
});

test('v3.0.1 obterModulo: lê só os arquivos do próprio módulo; decisões e recibos só quando o módulo tem linha no decisoes.csv', () => {
  const e = ambiente(arquivosBase());
  e.obterModulo('financas', true);
  assert.deepEqual(Object.keys(e.leituras).filter((id) => DO_V3.test(id)).sort(), ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8']);
  // decisoes.csv sem linha de Finanças: não lista a pasta de recibos
  assert.equal(e.chamadas['pasta.getFiles'] || 0, 0);
  // Estudos não tem decisões: nem abre o decisoes.csv
  const e2 = ambiente(arquivosBase());
  e2.obterModulo('estudos', true);
  assert.equal(e2.leituras.DEC || 0, 0);
});

test('v3.0.1 cache por módulo: 5 min, depois a cópia "_ult" na hora com desatualizado=true; Atualizar agora relê', () => {
  const e = ambiente(arquivosBase());
  const r1 = e.obterModulo('suporte', false);
  assert.equal(r1.do_cache, false);
  assert.ok(e.cache.painel_v2_mod_suporte_n && e.cache.painel_v2_mod_suporte_ult_n);
  e.zerar();
  const r2 = e.obterModulo('suporte', false);
  assert.equal(r2.do_cache, true); assert.equal(r2.desatualizado, false);
  assert.equal(e.chamadas.getFileById || 0, 0); // nem o painel-fontes.json
  // passou o tempo do cache curto: devolve a última na hora, marcada como desatualizada
  delete e.cache.painel_v2_mod_suporte_n;
  const r3 = e.obterModulo('suporte', false);
  assert.equal(r3.desatualizado, true);
  assert.deepEqual(semData(r3.modulo), semData(r1.modulo));
  // cada módulo tem o seu: o cache do Suporte não serve para E-mails nem para o Início
  assert.equal(e.obterModulo('emails', false).do_cache, false);
  assert.equal(e.obterInicio(false).do_cache, false);
  assert.equal(e.obterInicio(false).do_cache, true);
  // forcar ignora o cache
  assert.equal(e.obterModulo('suporte', true).do_cache, false);
});

test('v3.0.1 arquivo do agente mudou: a leitura forçada do módulo traz o novo (cache de texto por versão do arquivo)', () => {
  const e = ambiente(arquivosBase());
  const antes = e.obterModulo('estudos', true).modulo;
  e.arquivos.T5.texto += '2026-11-12,Simulado da Fase 4,simulado,em andamento,\r\n';
  assert.equal(e.obterModulo('estudos', false).modulo.pedidos_andamento.length, antes.pedidos_andamento.length); // cache de 5 min
  assert.equal(e.obterModulo('estudos', true).modulo.pedidos_andamento.length, antes.pedidos_andamento.length + 1);
});

test('v3.0.1 decisão gravada limpa o cache do Início e do módulo; o módulo mostra a decisão pendente', () => {
  const e = ambiente(arquivosBase());
  e.PainelLib.CHAVES.EMAILS_INTEGRADO = true;
  try {
    e.obterInicio(false);
    const m = e.obterModulo('emails', false).modulo;
    e.obterModulo('suporte', false);
    const g = m.itens.find((i) => i.item_id === 'grupo:Exchange|Lembretes e Aniversários');
    assert.equal(e.salvarDecisao({ modulo: 'emails', item_id: g.item_id, decisao: 'recusar', comentario: 'texto=deixe na entrada', snapshot_hash: g.snapshot_hash }).ok, true);
    ['inicio', 'inicio_ult', 'mod_emails', 'mod_emails_ult'].forEach((k) => assert.equal(e.cache['painel_v2_' + k + '_n'], undefined, k));
    assert.ok(e.cache.painel_v2_mod_suporte_n); // os outros módulos ficam
    e.zerar();
    const r = e.obterModulo('emails', false);
    assert.equal(r.do_cache, false);
    assert.equal(r.modulo.itens.find((i) => i.item_id === g.item_id).decisao_pendente.decisao, 'recusar');
    assert.ok(e.chamadas['pasta.getFiles'] >= 1); // agora há linha de E-mails: os recibos são lidos
  } finally { e.PainelLib.CHAVES.EMAILS_INTEGRADO = true; }
});

test('v3.0.1 Início mais leve: pasta de criativos listada uma vez, menos chamadas ao Drive que a carga completa', () => {
  const e = ambiente(arquivosBase());
  e.obterDados(true); // aquece o cache de textos
  e.zerar(); e.obterDados(true);
  const tudo = Object.assign({}, e.chamadas);
  e.zerar(); e.obterInicio(true);
  const ini = Object.assign({}, e.chamadas);
  assert.equal(ini['pasta.getFiles'], 2); // criativos (posts e planos juntos) e recibos
  assert.equal(ini.getBlob, 1); // só o decisoes.csv, sempre direto do Drive
  const drive = (c) => ['getFileById', 'getFolderById', 'getFilesByName', 'pasta.getFilesByName', 'pasta.getFiles', 'next', 'getName', 'getLastUpdated', 'isTrashed', 'getBlob'].reduce((s, k) => s + (c[k] || 0), 0);
  assert.ok(drive(ini) * 2 < drive(tudo), drive(ini) + ' x ' + drive(tudo));
});

test('v3.0.1 erro num módulo não derruba o Início nem os outros módulos', () => {
  const arq = arquivosBase();
  const cfg = JSON.parse(arq.CFG.texto);
  cfg.modulos.find((m) => m.id === 'financas').fontes.ledger.folderId = 'NAO-EXISTE';
  arq.CFG.texto = JSON.stringify(cfg);
  const e = ambiente(arq);
  const fin = e.obterModulo('financas', true);
  assert.ok(fin.fontes.some((f) => !f.ok)); // o erro vem nas fontes do próprio módulo
  assert.equal(e.obterInicio(true).fontes.every((f) => f.ok || f.ausente), true);
  assert.equal(e.obterModulo('suporte', true).fontes.every((f) => f.ok || f.ausente), true);
  // módulo inativo: erro só na chamada dele
  cfg.modulos.find((m) => m.id === 'investimentos').ativo = false;
  arq.CFG.texto = JSON.stringify(cfg);
  const e2 = ambiente(arq);
  assert.throws(() => e2.obterModulo('investimentos', true), /não está ativo/);
  assert.deepEqual(e2.obterInicio(true).v3_ids, ['suporte', 'emails', 'financas', 'estudos']);
});

/* ---------- tela: PainelV3.carregarModulos com um DOM mínimo ---------- */
function telaV3() {
  const el = () => ({ innerHTML: '', hidden: true, textContent: '', classList: { toggle() {}, add() {}, remove() {} } });
  const nos = {};
  const chamadas = [];
  const dados = { modulos: V3.map((id) => ({ id, rotulo: 'Rótulo ' + id, ativo: true })), v3_ids: V3.slice(), v3: {}, fontes: [] };
  let redesenhos = 0;
  const window = { Painel: { dados: () => dados, redesenharInicio: () => { redesenhos++; },
    util: { esc: (s) => String(s), chamar: (fn, id, forcar) => new Promise((ok, falha) => chamadas.push({ fn, id, forcar, ok, falha })), fecharFolhas() {}, toast() {} },
    trocarAba() {} } };
  const document = { querySelector: (s) => (nos[s] = nos[s] || el()), addEventListener() {}, getElementById: () => null, body: { style: {} } };
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'AppV3.html'), 'utf8');
  const js = html.replace(/^[\s\S]*?<script>/, '').replace(/<\/script>[\s\S]*$/, '');
  new Function('window', 'document', 'setTimeout', js)(window, document, setTimeout);
  return { V: window.PainelV3, chamadas, dados, nos, redesenhos: () => redesenhos };
}
const modOk = (id, n) => ({ id, modulo: { id, rotulo: 'Rótulo ' + id, precisa: { total: n, partes: [{ n, rotulo: 'coisas' }] } }, fontes: [{ rotulo: 'Fonte ' + id, ok: true }] });
const espera = () => new Promise((r) => setImmediate(r));

test('v3.0.1 tela: uma chamada obterModulo por módulo; "carregando" até chegar; erro só no cartão dele', async () => {
  const t = telaV3();
  t.V.carregarModulos(V3, false);
  assert.deepEqual(t.chamadas.map((c) => [c.fn, c.id, c.forcar]), V3.map((id) => ['obterModulo', id, false]));
  let h = t.V.cartoesInicio();
  assert.equal((h.match(/carregando-mod/g) || []).length, 5);
  assert.equal(t.V.total(), 0);
  t.chamadas[0].ok(modOk('suporte', 3));
  t.chamadas[2].falha(new Error('Tempo esgotado ao ler o Drive'));
  await espera();
  h = t.V.cartoesInicio();
  assert.equal((h.match(/carregando-mod/g) || []).length, 3);
  assert.equal((h.match(/erro-mod/g) || []).length, 1);
  assert.ok(/data-mod="financas">[\s\S]*?Não carregou: Tempo esgotado ao ler o Drive/.test(h));
  assert.ok(/data-mod="suporte"[^>]*>[\s\S]*?<span class="num">3<\/span>/.test(h));
  assert.equal(t.V.total(), 3);
  assert.deepEqual(t.V.fontes().map((f) => f.rotulo), ['Fonte suporte']);
  assert.ok(t.redesenhos() >= 3);
});

test('v3.0.1 tela: cópia desatualizada aparece e pede a nova forçada sem voltar a "carregando"; carga velha é ignorada', async () => {
  const t = telaV3();
  t.V.carregarModulos(V3, false);
  t.chamadas[1].ok(Object.assign(modOk('emails', 2), { desatualizado: true }));
  await espera();
  const nova = t.chamadas[5];
  assert.deepEqual([nova.fn, nova.id, nova.forcar], ['obterModulo', 'emails', true]);
  assert.ok(!/data-mod="emails"[^>]*aria-busy/.test(t.V.cartoesInicio()));
  nova.ok(modOk('emails', 4));
  await espera();
  assert.equal(t.dados.v3.emails.precisa.total, 4);
  // Atualizar agora: nova geração; a resposta atrasada da anterior não sobrescreve
  t.V.carregarModulos(V3, true);
  assert.deepEqual(t.chamadas.slice(6).map((c) => [c.id, c.forcar]), V3.map((id) => [id, true]));
  assert.ok(/data-mod="emails"[^>]*atualizando-mod|atualizando-mod[^>]*data-mod="emails"/.test(t.V.cartoesInicio())); // mantém o número antigo com "Atualizando…"
  t.chamadas[3].ok(modOk('investimentos', 9)); // da carga anterior
  await espera();
  assert.equal(t.dados.v3.investimentos, undefined);
  t.chamadas[9].ok(modOk('investimentos', 1));
  await espera();
  assert.equal(t.dados.v3.investimentos.precisa.total, 1);
  // módulo que saiu do painel-fontes.json some da tela
  t.V.carregarModulos(['suporte'], false);
  assert.equal(t.dados.v3.emails, undefined);
});
