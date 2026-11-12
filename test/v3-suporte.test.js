// v3: base comum dos módulos novos + módulo Suporte RN Sports (fixtures anonimizadas em test/fixtures/suporte/).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { ambiente, arquivosBase } = require('../dev/ambiente-gas');

const m = { exports: {} };
new Function('module', fs.readFileSync(path.join(__dirname, '..', 'src', 'Lib.gs'), 'utf8'))(m);
const L = m.exports;
const txt = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', 'suporte', n), 'utf8');
const fontes = (sem) => {
  const f = { chamados: L.csvParaObjetos(txt('Chamados.csv')), respostas: L.csvParaObjetos(txt('Respostas.csv')), alertas: L.csvParaObjetos(txt('Alerts.csv')), rascunhos: L.csvParaObjetos(txt('Rascunhos-painel.csv')) };
  (sem || []).forEach((k) => { f[k] = null; });
  return f;
};
const AGORA = new Date(2026, 10, 12, 19);
const montar = (f, dec) => L.montarModulosV3({ suporte: f || fontes() }, dec || [], AGORA).suporte;

test('suporte: parser aguenta CRLF, aspas dobradas e quebra de linha dentro do campo', () => {
  const ch = L.csvParaObjetos(txt('Chamados.csv'));
  assert.ok(txt('Chamados.csv').includes('\r\n'));
  assert.equal(ch.linhas.length, 38);
  const c634 = ch.linhas.find((c) => c.id === '634');
  assert.match(c634.ultima_acao, /conferir "quarteto"\)\ncliente mandou 2 e-mails/);
  assert.equal(c634.proxima_acao, 'Bruno confere no sistema');
  const r = L.csvParaObjetos(txt('Rascunhos-painel.csv'), L.CABECALHO_RASCUNHOS_SUPORTE);
  assert.equal(r.linhas.length, 7);
  const r663 = r.linhas.find((x) => x.id_chamado === '663');
  assert.match(r663.rascunho_texto, /política "Cancelamento e reembolso"/);
  assert.equal(r663.rascunho_texto.split('\n').length, 10);
});

test('suporte: estado livre classificado pelo começo do texto, texto inteiro preservado', () => {
  const R = [[/^aguardando/, 'aguardando_aprovo'], [/^enviad/, 'enviado']];
  assert.equal(L.classificarComeco('Aguardando aprovo do Bruno desde 12/11', R), 'aguardando_aprovo');
  assert.equal(L.classificarComeco('  ENVIADO em 12/11 14:20', R), 'enviado');
  assert.equal(L.classificarComeco('pausado pelo agente', R), 'outro');
  assert.equal(L.classificarComeco('', R, ''), '');
  const f = fontes();
  f.rascunhos.linhas.find((x) => x.id_chamado === '645').estado = 'Aguardando aprovo (lembrete enviado ao Bruno)';
  const s = montar(f);
  const x = s.itens.find((i) => i.item_id === 'resposta:645');
  assert.equal(x.estado, 'aguardando_aprovo');
  assert.equal(x.estado_texto, 'Aguardando aprovo (lembrete enviado ao Bruno)');
  assert.deepEqual(x.decisoes_possiveis, ['aprovar', 'refazer', 'recusar']);
});

test('suporte: fila, prazos, abertos, parados, alertas e contagem do Início', () => {
  const s = montar();
  assert.equal(s.integrado, false);
  assert.match(s.aviso_chave, /o agente ainda não lê estas decisões/);
  // só a última versão de cada chamado; 666 já foi enviado e fica fora da fila
  assert.deepEqual(s.fila, ['resposta:643', 'resposta:645', 'resposta:626', 'resposta:638', 'resposta:663']);
  const x643 = s.itens.find((i) => i.item_id === 'resposta:643');
  assert.equal(x643.versao, '2');
  assert.deepEqual(x643.prazo, { data: '2026-12-13', dias: 31, origem: 'prazo_evento' });
  assert.deepEqual(s.itens.find((i) => i.item_id === 'resposta:666').decisoes_possiveis, []);
  // prazo lido do nome do evento quando prazo_evento está vazio
  assert.deepEqual(L.prazoDoEvento('', 'Corrida Vale Verde (14/11)', AGORA), { data: '2026-11-14', dias: 2, origem: 'evento' });
  assert.equal(s.sem_texto.length, 8);
  assert.ok(s.sem_texto.every((c) => !s.fila.includes('resposta:' + c.id)));
  assert.equal(s.abertos.total, 13);
  assert.deepEqual(s.abertos.por_evento[0], { nome: '2ª Trilha Runners (13/12)', n: 3 });
  assert.deepEqual(s.abertos.por_tipo[0], { nome: 'cancelamento_reembolso', n: 5 });
  assert.equal(s.parados.length, 9);
  assert.ok(s.parados.every((p) => p.horas > 24));
  assert.deepEqual(s.alertas.map((a) => a.tier), ['Now', 'Now', 'Today']);
  assert.equal(s.alertas[2].substituido, true);
  assert.equal(s.primeira_resposta.criados, 6);
  assert.equal(s.primeira_resposta.mediana_horas, null); // Chamados.csv não tem hora da primeira resposta
  assert.equal(s.primeira_resposta.so_data, 2);
  assert.deepEqual(s.precisa, { total: 13, partes: [{ rotulo: 'respostas para aprovar', n: 5 }, { rotulo: 'rascunhos só no Zendesk', n: 8 }] });
  // nenhum dado identificável no resumo: corta em 280
  assert.ok(s.itens.every((i) => i.pedido_resumo.length <= 280));
});

test('suporte: Rascunhos-painel.csv ainda não criado = fila vazia, tudo vai para "só no Zendesk"', () => {
  const s = montar(fontes(['rascunhos']));
  assert.equal(s.rascunhos_ativo, false);
  assert.deepEqual(s.fila, []);
  assert.equal(s.sem_texto.length, 13);
  assert.equal(s.precisa.total, 13);
});

test('suporte: hash canônico com separador U+001F (␟), vetor do contrato', () => {
  const r = { id_chamado: '645', versao: '1', evento: '2ª Trilha Runners (13/12)', tipo: 'correcao_dados', cliente_primeiro_nome: 'Carlos', pedido_resumo: 'Pede para corrigir a data.', rascunho_texto: 'Olá, Carlos!\n\nSó falta o ano.', estado: 'aguardando_aprovo', zendesk_link: 'https://exemplo.zendesk.com/agent/tickets/645', prazo_evento: '2026-12-13', atualizado_em: '2026-11-08T16:34-03:00' };
  const esperado = ['resposta', '645', '1', '2ª Trilha Runners (13/12)', 'correcao_dados', 'Carlos', 'Pede para corrigir a data.', 'Olá, Carlos!\n\nSó falta o ano.', 'aguardando_aprovo', 'https://exemplo.zendesk.com/agent/tickets/645', '2026-12-13'].join('\u001F');
  assert.equal(L.canonicoResposta(r), esperado);
  assert.equal(L.sha256(esperado), crypto.createHash('sha256').update(esperado, 'utf8').digest('hex'));
  // atualizado_em não entra no hash; texto do rascunho entra
  assert.equal(L.canonicoResposta(Object.assign({}, r, { atualizado_em: 'x' })), esperado);
  assert.notEqual(L.canonicoResposta(Object.assign({}, r, { rascunho_texto: 'outro' })), esperado);
  assert.equal(L.sha256(esperado), 'dd235ce26ee191ea3e4bfe51281998d4857e85c240793b97f0f9144e2c2c5a94');
});

test('suporte: comentário estruturado v3 (texto por último, sem quebra de linha)', () => {
  const campos = [{ k: 'texto', obrigatorio: true }];
  assert.deepEqual(L.parseComentarioV3('texto=trocar o prazo; manter=o resto', campos), { texto: 'trocar o prazo; manter=o resto' });
  assert.throws(() => L.parseComentarioV3('', campos), /obrigatório/);
  assert.throws(() => L.parseComentarioV3('valor=10', campos), /não vale/);
  assert.equal(L.montarComentarioV3({ texto: 'linha 1\nlinha 2' }, campos), 'texto=linha 1 linha 2');
  const pg = [{ k: 'data' }, { k: 'valor' }, { k: 'texto' }];
  assert.deepEqual(L.parseComentarioV3('data=2026-11-12;valor=1191.92', pg), { data: '2026-11-12', valor: '1191.92' });
  assert.throws(() => L.parseComentarioV3('data=12/11/2026', pg), /aaaa-mm-dd/);
  assert.throws(() => L.parseComentarioV3('valor=1.191,92', pg), /número/);
  assert.throws(() => L.parseComentarioV3('valor=10;data=2026-11-12', pg), /fora de ordem/);
});

test('suporte no servidor: chave false recusa gravar e não toca no decisoes.csv', () => {
  const e = ambiente(arquivosBase());
  const d = e.obterDados(true);
  assert.ok(d.fontes.filter((f) => /Suporte/.test(f.rotulo)).every((f) => f.ok), JSON.stringify(d.fontes));
  const s = d.v3.suporte;
  assert.equal(s.integrado, false);
  assert.equal(s.precisa.partes[0].n, 5);
  const x = s.itens.find((i) => i.item_id === 'resposta:643');
  const antes = e.arquivos.DEC.texto;
  assert.throws(() => e.salvarDecisao({ modulo: 'suporte', item_id: x.item_id, decisao: 'aprovar', comentario: '', snapshot_hash: x.snapshot_hash }), /o agente ainda não lê estas decisões \(Agente de Suporte RN Sports\); nada foi gravado/);
  assert.equal(e.arquivos.DEC.texto, antes);
});

test('suporte no servidor: chave true grava no mesmo decisoes.csv; recusa repetida, obsoleta, sem texto e estado errado', () => {
  const e = ambiente(arquivosBase());
  e.PainelLib.CHAVES.SUPORTE_INTEGRADO = true;
  try {
    const d = e.obterDados(true);
    assert.equal(d.v3.suporte.integrado, true);
    const x = d.v3.suporte.itens.find((i) => i.item_id === 'resposta:643');
    // ajuste sem texto
    assert.throws(() => e.salvarDecisao({ modulo: 'suporte', item_id: x.item_id, decisao: 'refazer', comentario: '', snapshot_hash: x.snapshot_hash }), /comentário|obrigatório/);
    const r = e.salvarDecisao({ modulo: 'suporte', item_id: x.item_id, decisao: 'refazer', comentario: 'texto=prazo de 10 dias úteis;\nmanter o resto', snapshot_hash: x.snapshot_hash });
    assert.equal(r.ok, true);
    assert.equal(r.versao, '2');
    const linhas = e.PainelLib.csvParaObjetos(e.arquivos.DEC.texto).linhas;
    assert.equal(linhas.length, 1);
    assert.equal(linhas[0].modulo, 'suporte');
    assert.equal(linhas[0].tipo_item, 'resposta');
    assert.equal(linhas[0].versao, '2');
    assert.equal(linhas[0].arte_fileId, '');
    assert.equal(linhas[0].snapshot_hash, x.snapshot_hash);
    assert.equal(linhas[0].comentario, 'texto=prazo de 10 dias úteis; manter o resto');
    // repetida para a mesma versão
    assert.throws(() => e.salvarDecisao({ modulo: 'suporte', item_id: x.item_id, decisao: 'aprovar', comentario: '', snapshot_hash: x.snapshot_hash }), /já existe/);
    // o agente reescreve o 645 depois que a tela carregou: hash velho recusado
    const x645 = d.v3.suporte.itens.find((i) => i.item_id === 'resposta:645');
    e.arquivos.S4.texto = e.arquivos.S4.texto.replace('Conseguimos corrigir, sim.', 'Conseguimos corrigir.');
    assert.throws(() => e.salvarDecisao({ modulo: 'suporte', item_id: x645.item_id, decisao: 'aprovar', comentario: '', snapshot_hash: x645.snapshot_hash }), /mudou/);
    // já enviado: não aceita decisão
    const x666 = d.v3.suporte.itens.find((i) => i.item_id === 'resposta:666');
    assert.throws(() => e.salvarDecisao({ modulo: 'suporte', item_id: x666.item_id, decisao: 'aprovar', comentario: '', snapshot_hash: x666.snapshot_hash }), /não aceita/);
    // decisão de outro módulo não vale aqui
    assert.throws(() => e.salvarDecisao({ modulo: 'suporte', item_id: x645.item_id, decisao: 'pausar', comentario: '', snapshot_hash: x645.snapshot_hash }), /não vale/);
    assert.equal(e.PainelLib.csvParaObjetos(e.arquivos.DEC.texto).linhas.length, 1);
    // a pendência aparece no item e sai da contagem do Início
    const d2 = e.obterDados(true);
    const y = d2.v3.suporte.itens.find((i) => i.item_id === 'resposta:643');
    assert.equal(y.decisao_pendente.decisao, 'refazer');
    assert.equal(y.decisao_pendente.obsoleta, false);
  } finally { e.PainelLib.CHAVES.SUPORTE_INTEGRADO = false; }
});

test('suporte: recibo do agente vira último recibo do item', () => {
  const dec = [{ id: 'D-1', quando: '2026-11-12T10:00:00-03:00', modulo: 'suporte', item_id: 'resposta:645', tipo_item: 'resposta', versao: '1', snapshot_hash: 'x', decisao: 'aprovar', comentario: '', origem: 'painel' }];
  const s = L.montarModulosV3({ suporte: fontes() }, L.decisoesComRecibos(dec, { 'D-1': { decision_id: 'D-1', resultado: 'rejeitado', motivo: 'rascunho já tinha mudado', processado_em: '2026-11-12T11:00:00-03:00', agente: 'Agente de Suporte RN Sports' } }), AGORA).suporte;
  const x = s.itens.find((i) => i.item_id === 'resposta:645');
  assert.equal(x.decisao_pendente, null);
  assert.equal(x.ultimo_recibo.resultado, 'rejeitado');
  const s2 = L.montarModulosV3({ suporte: fontes() }, L.decisoesComRecibos(dec, {}), AGORA).suporte;
  assert.equal(s2.itens.find((i) => i.item_id === 'resposta:645').decisao_pendente.obsoleta, true);
});
