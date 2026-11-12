// v3: módulo Investimentos (fixtures anonimizadas em test/fixtures/investimentos/, mesmo formato e sujeira dos originais).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { ambiente, arquivosBase, APORTE_PLANEJADO } = require('../dev/ambiente-gas');

const m = { exports: {} };
new Function('module', fs.readFileSync(path.join(__dirname, '..', 'src', 'Lib.gs'), 'utf8'))(m);
const L = m.exports;
const txt = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', 'investimentos', n), 'utf8');
const ARQ = { posicoes: 'Posicoes.csv', precos: 'Precos.csv', metas: 'Metas_ARCA.csv', recomendacoes: 'Recomendacoes.csv', aportes: 'Aportes.csv', previdencia: 'Previdencia.csv', reserva: 'Reserva.csv', alertas: 'Alerts.csv' };
const fontes = (extraAportes) => { const f = {}; Object.keys(ARQ).forEach((k) => { f[k] = L.csvParaObjetos(txt(ARQ[k]) + (k === 'aportes' && extraAportes ? extraAportes : '')); }); return f; };
const AGORA = new Date(2026, 10, 12, 19);
const montar = (f, dec) => L.montarModulosV3({ investimentos: f || fontes() }, dec || [], AGORA).investimentos;
const ID_PLAN = 'aporte:2026-11-15|Reserva de emergência|pessoal';

test('investimentos: parser aguenta CRLF misturado, datas em três formatos, decimais com ponto e intradiário', () => {
  const bruto = txt('Precos.csv');
  assert.ok(bruto.includes('\r\n') && /[^\r]\n/.test(bruto)); // LF e CRLF no mesmo arquivo
  assert.equal(L.csvParaObjetos(bruto).linhas.length, 31);
  // decimais com ponto, de qualquer tamanho; vírgula brasileira ainda vale
  assert.equal(L.numDec('5.5077'), 5.5077);
  assert.equal(L.numDec('0.00002867'), 0.00002867);
  assert.equal(L.numDec('344.30'), 344.3);
  assert.equal(L.numDec('2.468,10'), 2468.1);
  assert.equal(L.numDec('a informar'), null);
  // "BRT" fica na hora; "NY" soma 2 h; só a data: ação em USD = fechamento 18:00, resto = 00:00
  assert.equal(L.quandoPreco('2026-11-06 16:17 BRT', 'USD').toISOString(), '2026-11-06T16:17:00.000Z');
  assert.equal(L.quandoPreco('2026-11-06 16:00 NY', 'BRL').toISOString(), '2026-11-06T18:00:00.000Z');
  assert.equal(L.quandoPreco('2026-11-06', 'USD').toISOString(), '2026-11-06T18:00:00.000Z');
  assert.equal(L.quandoPreco('2026-11-06', 'BRL').toISOString(), '2026-11-06T00:00:00.000Z');
  // a série do AAPL deixa o intradiário de fora
  const s = montar();
  assert.equal(s.precos.aapl.intradiarios_fora, 1);
  assert.ok(s.precos.aapl.pontos.every((p) => p.quando !== '2026-11-06 16:17'));
  // Metas_ARCA tem meta em número para a ARCA e texto livre para o que fica fora
  assert.deepEqual(s.carteira.fora.map((x) => x.categoria), ['Previdência (fora)', 'Reserva (fora)']);
  assert.match(s.carteira.fora[0].meta_texto, /provisório/);
});

test('investimentos: estado do aporte classificado pelo começo do texto', () => {
  const E = L.ESTADOS_APORTE;
  assert.equal(L.classificarComeco('confirmado', E, 'pendente'), 'confirmado');
  assert.equal(L.classificarComeco('Confirmado pelo usuário 10/11', E, 'pendente'), 'confirmado');
  assert.equal(L.classificarComeco('planejado (primeiro aporte)', E, 'pendente'), 'pendente');
  assert.equal(L.classificarComeco('não fiz; sem saldo', E, 'pendente'), 'nao_feito');
  assert.equal(L.classificarComeco('cancelado', E, 'pendente'), 'nao_feito');
  assert.equal(L.classificarComeco('', E, 'pendente'), 'pendente');
});

test('investimentos: preços, posições, carteira ARCA, recomendações, previdência, reserva e contagem do Início', () => {
  const s = montar();
  // o arquivo real não tem aporte pendente: nada para decidir, contagem zero
  assert.equal(s.itens.length, 0);
  assert.equal(s.precisa.total, 0);
  const p = s.precos;
  assert.deepEqual([p.btc.ultimo, p.btc.quando, p.btc.var_pct, p.btc.pontos.length], [409278.88, '2026-11-12 08:00', -0.78, 7]);
  assert.deepEqual([p.aapl.ultimo, p.aapl.var_pct, p.aapl.pontos.length], [355.63, 2, 5]);
  assert.equal(p.usdbrl, 5.58);
  assert.equal(p.aapl_brl, 1984.42);
  assert.deepEqual(s.posicoes.filter((x) => x.quantidade !== null).map((x) => [x.ativo, x.plataforma, x.valor_brl, x.ganho_pct]),
    [['AAPL', 'não informada', 126.21, 14.9], ['BTC', 'Corretora Alfa', 935.33, 22.32], ['BTC', 'App Cripto Beta', 11.73, 2.93]]);
  const c = s.carteira;
  assert.equal(c.data, '2026-11-09');
  const alt = c.arca.find((x) => x.categoria === 'Alternativos');
  assert.deepEqual([alt.valor, alt.peso_pct, alt.meta_pct], [1075.67, 100, 25]);
  assert.equal(c.soma_meta, 100);
  assert.equal(c.hoje_por_categoria.Alternativos, 1073.27);
  assert.equal(s.recomendacoes_total, 7);
  const aapl = s.ultima_por_ativo.find((r) => r.ativo === 'AAPL');
  assert.deepEqual([aapl.data, aapl.sinal, aapl.vence_30d], ['2026-11-11', 'COMPRAR', '2026-12-11']);
  assert.equal(s.previdencia.saldo, 85759.88);
  assert.equal(s.previdencia.anterior.saldo, 85554.92);
  assert.match(s.previdencia.obs, /provisório/);
  assert.deepEqual([s.reserva.saldo, s.reserva.produto], [0, 'Tesouro Selic (sem aporte ainda; confirmado pelo usuário)']);
  assert.deepEqual([s.aportes.mes, s.aportes.do_mes.length, s.aportes.soma_mes], ['2026-11', 3, 204.96]);
  assert.equal(s.alertas.length, 0);
  // com um aporte planejado (linha fictícia) a tela pede decisão e o Início conta 1
  const s2 = montar(fontes(APORTE_PLANEJADO));
  assert.deepEqual(s2.itens.map((x) => x.item_id), [ID_PLAN]);
  assert.deepEqual(s2.itens[0].decisoes_possiveis, ['fiz_aporte', 'nao_fiz']);
  assert.equal(s2.precisa.total, 1);
});

test('investimentos: hash canônico do aporte (vetor do contrato)', () => {
  const a = { data: '2026-11-15', destino: 'Reserva de emergência', categoria_arca: 'Fora da ARCA', ativo: 'Tesouro Selic', valor_brl: '250.00', origem: 'pessoal', estado_texto: 'planejado' };
  const esperado = ['aporte', '2026-11-15', 'Reserva de emergência', 'Fora da ARCA', 'Tesouro Selic', '250.00', 'pessoal', 'planejado'].join('\u001F');
  assert.equal(L.canonicoAporte(a), esperado);
  assert.equal(L.sha256(esperado), crypto.createHash('sha256').update(esperado, 'utf8').digest('hex'));
  assert.equal(L.sha256(esperado), 'dc6bd7b8d5bca74ff2bb9c7f1da68b5e659c3499587375112b0fa3160784f7cb');
});

test('investimentos no servidor: chave false recusa gravar e não toca no decisoes.csv', () => {
  const e = ambiente(arquivosBase());
  const d = e.obterDados(true);
  const f8 = d.fontes.filter((f) => /Investimentos/.test(f.rotulo));
  assert.ok(f8.length === 8 && f8.every((f) => f.ok), JSON.stringify(f8));
  const s = d.v3.investimentos;
  assert.equal(s.integrado, false);
  assert.equal(s.precisa.total, 1); // a linha fictícia do ambiente de teste
  const x = s.itens[0];
  const antes = e.arquivos.DEC.texto;
  assert.throws(() => e.salvarDecisao({ modulo: 'investimentos', item_id: x.item_id, decisao: 'fiz_aporte', comentario: '', snapshot_hash: x.snapshot_hash }), /o agente ainda não lê estas decisões \(Analista de Investimentos\); nada foi gravado/);
  assert.equal(e.arquivos.DEC.texto, antes);
});

test('investimentos no servidor: chave true grava "fiz o aporte" (data, valor e texto opcionais) e "não fiz"; recusa formato, obsoleta e repetida', () => {
  const e = ambiente(arquivosBase());
  e.PainelLib.CHAVES.INVESTIMENTOS_INTEGRADO = true;
  try {
    const d = e.obterDados(true);
    const x = d.v3.investimentos.itens.find((i) => i.item_id === ID_PLAN);
    assert.throws(() => e.salvarDecisao({ modulo: 'investimentos', item_id: x.item_id, decisao: 'fiz_aporte', comentario: 'data=12/11/2026', snapshot_hash: x.snapshot_hash }), /aaaa-mm-dd/);
    assert.throws(() => e.salvarDecisao({ modulo: 'investimentos', item_id: x.item_id, decisao: 'fiz_aporte', comentario: 'valor=250,00', snapshot_hash: x.snapshot_hash }), /valor/);
    assert.throws(() => e.salvarDecisao({ modulo: 'investimentos', item_id: x.item_id, decisao: 'paguei', comentario: '', snapshot_hash: x.snapshot_hash }), /não vale/);
    assert.throws(() => e.salvarDecisao({ modulo: 'investimentos', item_id: x.item_id, decisao: 'fiz_aporte', comentario: '', snapshot_hash: '0'.repeat(64) }), /mudou/);
    assert.equal(e.salvarDecisao({ modulo: 'investimentos', item_id: x.item_id, decisao: 'fiz_aporte', comentario: 'data=2026-11-12;valor=250.00;texto=Aporte feito no app', snapshot_hash: x.snapshot_hash }).ok, true);
    const linhas = e.PainelLib.csvParaObjetos(e.arquivos.DEC.texto).linhas;
    assert.equal(linhas.length, 1);
    assert.deepEqual([linhas[0].modulo, linhas[0].item_id, linhas[0].tipo_item, linhas[0].decisao, linhas[0].comentario, linhas[0].snapshot_hash],
      ['investimentos', ID_PLAN, 'aporte', 'fiz_aporte', 'data=2026-11-12;valor=250.00;texto=Aporte feito no app', x.snapshot_hash]);
    assert.throws(() => e.salvarDecisao({ modulo: 'investimentos', item_id: x.item_id, decisao: 'nao_fiz', comentario: '', snapshot_hash: x.snapshot_hash }), /já existe/);
    const d2 = e.obterDados(true);
    assert.equal(d2.v3.investimentos.itens[0].decisao_pendente.decisao, 'fiz_aporte');
    // o agente confirma: o aporte sai da lista e não aceita mais decisão
    e.arquivos.I5.texto = e.arquivos.I5.texto.replace(',pessoal,planejado (primeiro aporte da reserva; aguardando o usuário)', ',pessoal,confirmado 12/11');
    assert.throws(() => e.salvarDecisao({ modulo: 'investimentos', item_id: x.item_id, decisao: 'nao_fiz', comentario: '', snapshot_hash: x.snapshot_hash }), /não existe mais/);
    assert.equal(e.obterDados(true).v3.investimentos.precisa.total, 0);
  } finally { e.PainelLib.CHAVES.INVESTIMENTOS_INTEGRADO = false; }
});

test('investimentos: "não fiz" com motivo opcional é aceito com a chave ligada', () => {
  const e = ambiente(arquivosBase());
  e.PainelLib.CHAVES.INVESTIMENTOS_INTEGRADO = true;
  try {
    const x = e.obterDados(true).v3.investimentos.itens[0];
    assert.equal(e.salvarDecisao({ modulo: 'investimentos', item_id: x.item_id, decisao: 'nao_fiz', comentario: 'texto=sem saldo este mês', snapshot_hash: x.snapshot_hash }).ok, true);
    assert.equal(e.PainelLib.csvParaObjetos(e.arquivos.DEC.texto).linhas[0].decisao, 'nao_fiz');
  } finally { e.PainelLib.CHAVES.INVESTIMENTOS_INTEGRADO = false; }
});
