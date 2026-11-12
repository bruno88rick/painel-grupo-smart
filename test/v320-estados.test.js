// v3.2.0: os leitores (consumidor/) gravam só o estado estrito do ledger; data e motivo vão no recibo
// (ou em coluna própria: pago_em, fechado_em, obs). O painel lê os dois formatos: o antigo, com data e texto
// ("confirmado 2026-11-14 (...)", "não fiz (...)", "movido 2026-11-12", "pago 2026-11-12 (...)"), e o estrito.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { ambiente, arquivosBase } = require('../dev/ambiente-gas');

const m = { exports: {} };
new Function('module', fs.readFileSync(path.join(__dirname, '..', 'src', 'Lib.gs'), 'utf8'))(m);
const L = m.exports;
const c = (t, E, p) => L.classificarComeco(t, E, p);

test('v3.2.0: estado do aporte, antigo e estrito', () => {
  const E = L.ESTADOS_APORTE;
  assert.equal(c('confirmado 2026-11-14 (Tesouro Selic 2029)', E, 'pendente'), 'confirmado');
  assert.equal(c('confirmado', E, 'pendente'), 'confirmado');
  assert.equal(c('não fiz (sem saldo este mês)', E, 'pendente'), 'nao_feito');
  assert.equal(c('nao_feito', E, 'pendente'), 'nao_feito'); // antes da v3.2.0 virava pendente
  assert.equal(c('planejado', E, 'pendente'), 'pendente');
});

test('v3.2.0: estados de E-mails e Finanças, antigos e estritos', () => {
  const M = L.ESTADOS_MOVIMENTO, P = L.ESTADOS_PENDENCIA, C = L.ESTADOS_CONTA;
  [['movido 2026-11-12', 'movido'], ['movido', 'movido'], ['recusado 2026-11-12 (deixar)', 'recusado'], ['recusado', 'recusado'],
    ['substituído 2026-11-12 (lote mais novo decidido em D-1)', 'substituido'], ['substituído', 'substituido'], ['proposto', 'proposto']]
    .forEach(([t, e]) => assert.equal(c(t, M), e, t));
  assert.equal(c('fechada (já respondi)', P), 'fechada');
  assert.equal(c('fechada', P), 'fechada');
  assert.equal(c('pago 2026-11-12 (valor pago R$ 10,00; ok)', C), 'pago');
  assert.equal(c('pago', C), 'pago');
});

test('v3.2.0: no servidor, linhas antigas e estritas saem da lista de decisão e contam igual', () => {
  const a = arquivosBase();
  const aporte = (dia, est) => '2026-11-' + dia + ',Teste,Caixa,CDB,10.00,pessoal,' + est + '\r\n';
  a.I5.texto += aporte('20', '"confirmado 2026-11-14 (CDB)"') + aporte('21', 'confirmado') + aporte('22', 'não fiz (sem saldo)') + aporte('23', 'nao_feito') + aporte('24', 'planejado');
  const mov = (id, pasta, est) => id + ',Google,' + pasta + ',teste,2026-11-12T08:00-03:00,' + est + '\r\n';
  a.E1.texto += mov('t:1', 'Teste A', 'movido 2026-11-12') + mov('t:2', 'Teste B', 'movido') + mov('t:3', 'Teste C', '"recusado 2026-11-12 (deixar)"') + mov('t:4', 'Teste D', 'recusado') + mov('t:5', 'Teste E', 'substituído');
  const pend = (id, est) => id + ',Google,Fulano Teste,oi,2026-11-12T08:00-03:00,teste,sim,,' + est + ',\r\n';
  a.E2.texto += pend('t:p1', '"fechada (já respondi)"') + pend('t:p2', 'fechada');
  const conta = (em, est, pago) => em + ',2026-11,"10,00",2026-11-20,boleto,' + est + ',,' + pago + ',\r\n';
  a.F1.texto += conta('Teste A', '"pago 2026-11-12 (valor pago R$ 10,00; ok)"', '2026-11-12') + conta('Teste B', 'pago', '2026-11-12');

  const v3 = ambiente(a).obterDados(true).v3, base = ambiente(arquivosBase()).obterDados(true).v3;
  const ids = (s) => s.itens.map((i) => i.item_id);
  // aportes: só o planejado pede decisão; confirmados (antigo e estrito) entram na soma do mês
  assert.deepEqual(ids(v3.investimentos).filter((x) => x.indexOf('|Teste|') >= 0), ['aporte:2026-11-24|Teste|pessoal']);
  const doMes = v3.investimentos.aportes.do_mes.filter((x) => x.destino === 'Teste');
  assert.deepEqual(doMes.map((x) => x.estado).sort(), ['confirmado', 'confirmado', 'nao_feito', 'nao_feito', 'pendente']);
  assert.equal(Math.round((v3.investimentos.aportes.soma_mes - base.investimentos.aportes.soma_mes) * 100), 2000);
  // e-mails e contas: nenhuma das linhas novas pede decisão; os itens de antes continuam os mesmos
  assert.deepEqual(ids(v3.emails), ids(base.emails));
  assert.deepEqual(ids(v3.financas), ids(base.financas));
});
