// v3: módulo Finanças (fixtures anonimizadas em test/fixtures/financas/, mesmo formato e sujeira dos originais).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { ambiente, arquivosBase } = require('../dev/ambiente-gas');

const m = { exports: {} };
new Function('module', fs.readFileSync(path.join(__dirname, '..', 'src', 'Lib.gs'), 'utf8'))(m);
const L = m.exports;
const txt = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', 'financas', n), 'utf8');
const ARQ = { contas: 'Contas.csv', recebidas: 'contas-recebidas.csv', lancamentos: 'Lancamentos.csv', recorrentes: 'Recorrentes.csv', rateios: 'Rateios.csv', fechamentos: 'Fechamentos.csv', orcamento: 'Orcamento.csv', alertas: 'Alerts.csv' };
const fontes = () => { const f = {}; Object.keys(ARQ).forEach((k) => { f[k] = L.csvParaObjetos(txt(ARQ[k])); }); return f; };
const AGORA = new Date(2026, 10, 12, 19);
const montar = (f, dec) => L.montarModulosV3({ financas: f || fontes() }, dec || [], AGORA).financas;
const arred = (n) => Math.round(n * 100) / 100;
const item = (s, id) => s.itens.find((i) => i.item_id === id);

test('financas: parser aguenta CRLF misturado, coluna sem nome, valor sem aspas e textos livres', () => {
  const bruto = txt('Contas.csv');
  assert.ok(bruto.includes('\r\n') && /[^\r]\n/.test(bruto)); // LF e CRLF no mesmo arquivo
  const c = L.csvParaObjetos(bruto);
  assert.equal(c.cabecalho[c.cabecalho.length - 1], ''); // última coluna sem nome
  assert.equal(c.linhas.length, 25);
  // "total R$ 861,53" sem aspas: a vírgula partiu o estado e empurrou link e pago_em
  assert.equal(c.linhas[0].estado, 'sem confirmação de pagamento; total R$ 861');
  assert.equal(c.linhas[0].link, '53');
  const r = L.consertarLinha(c.linhas[0], c.cabecalho);
  assert.equal(r.estado, 'sem confirmação de pagamento; total R$ 861,53');
  assert.equal(r.link, 'Fatura-tv-10-2026.pdf enviada no chat 09/11');
  assert.equal(r.pago_em, "['']");
  assert.equal(L.consertarLinha(c.linhas[1], c.cabecalho), c.linhas[1]); // linha boa fica igual
  // valores: com e sem milhar, negativo, texto
  assert.equal(L.numBr('2.468,10'), 2468.1);
  assert.equal(L.numBr('1469,05'), 1469.05);
  assert.equal(L.numBr('-48,32'), -48.32);
  assert.equal(L.numBr('R$ 10'), 10);
  assert.equal(L.numBr('a informar'), null);
  assert.equal(L.numBr('3.210,40 (nov)'), null);
  // códigos
  assert.equal(L.tipoCodigo('00020126580014br.gov.bcb.pix0136x'), 'pix');
  assert.equal(L.tipoCodigo('92249277311-4 85573719897-6 38511621538-7 63500093351-4'), 'barras');
  assert.equal(L.tipoCodigo('86454.82980 58121.463591 60563.410005 6 03831894892670'), 'barras');
  assert.equal(L.tipoCodigo('débito automático ativado'), 'texto');
  // outros arquivos
  assert.equal(L.csvParaObjetos(txt('Lancamentos.csv')).linhas.length, 86);
  assert.equal(L.csvParaObjetos(txt('contas-recebidas.csv')).linhas.length, 16);
  assert.equal(L.csvParaObjetos(txt('Fechamentos.csv')).linhas.length, 0);
  assert.equal(L.csvParaObjetos(txt('Orcamento.csv')).linhas.length, 0);
});

test('financas: estado livre classificado pelo começo do texto; vencida "a pagar" vira atraso na tela', () => {
  const E = L.ESTADOS_CONTA;
  assert.equal(L.classificarComeco('a pagar', E), 'a_pagar');
  assert.equal(L.classificarComeco('a pagar (última)', E), 'a_pagar');
  assert.equal(L.classificarComeco('a pagar; fechou 11/11 em R$ 3.015,73; débito automático 18/11', E), 'a_pagar');
  assert.equal(L.classificarComeco('pago', E), 'pago');
  assert.equal(L.classificarComeco('pago com atraso (153,22 + 1,25)', E), 'pago');
  assert.equal(L.classificarComeco('Pago (atrasado)', E), 'pago');
  assert.equal(L.classificarComeco('em atraso; usuário avisa quando pagar', E), 'atraso');
  assert.equal(L.classificarComeco('sem confirmação de pagamento; mínimo R$ 124,47 + 8x', E), 'sem_confirmacao');
  assert.equal(L.classificarComeco('qualquer outra coisa', E), 'outro');
  const s = montar();
  const agua = item(s, 'conta:Águas do Vale água casa|2026-11');
  assert.equal(agua.estado, 'a_pagar');
  assert.equal(agua.situacao, 'atraso');
  assert.equal(agua.dias, -1);
  assert.equal(agua.estado_texto, 'a pagar; gmail:f480ac4dae299313');
  const tv = item(s, 'conta:TV Estrela (minha parte 1/4)|2026-11');
  assert.equal(tv.consertada, true);
  assert.equal(tv.estado, 'sem_confirmacao');
  assert.equal(tv.estado_texto, 'sem confirmação de pagamento; total R$ 861,53');
  assert.equal(tv.pago_em, ''); // "['']" não é data
  assert.equal(s.contas.consertadas, 1);
});

test('financas: contas, códigos, PDFs, mês por categoria, rateio e contagem do Início', () => {
  const s = montar();
  assert.equal(s.integrado, false);
  assert.equal(s.contas.total, 25);
  assert.equal(s.contas.abertas, 20);
  assert.equal(s.contas.pagas_total, 5);
  assert.equal(s.contas.urgentes.length, 8);
  assert.equal(s.contas.urgentes[0], 'conta:Financiamento casa Banco Habitação 138/420|2026-10'); // a mais atrasada primeiro
  assert.equal(s.contas.proximas.length, 8);
  assert.deepEqual(s.contas.depois.length, 4);
  assert.equal(s.contas.valor_urgente, 2703.48);
  assert.equal(s.contas.sem_valor, 1);
  const mat = item(s, 'conta:Escola Horizonte matrícula 2027 (Filho)|2027-01');
  assert.equal(mat.valor, null);
  assert.equal(mat.valor_texto, 'a informar');
  // código e PDF vêm de contas-recebidas.csv pelo message_id citado no texto da conta
  const agua = item(s, 'conta:Águas do Vale água casa|2026-11');
  assert.equal(agua.tipo_codigo, 'barras');
  assert.equal(agua.codigo, '92249277311-4 85573719897-6 38511621538-7 63500093351-4');
  assert.equal(agua.pdf_fileId, '1U6UFLTW3PAY0iI6gduX5isr9hqa3j3Nm');
  const pf = item(s, 'conta:Banco Roxo PF cartão (pessoal)|2026-11');
  assert.equal(pf.pdf_fileId, '1pPtid0cruj0m7Ocs4dL6RT5UAMTI5vev'); // "pdf <id>" no link
  assert.equal(pf.codigo, '');
  assert.equal(pf.codigo_obs, 'débito automático');
  assert.deepEqual(pf.decisoes_possiveis, ['paguei']);
  // recebida com Pix e sem conta na lista
  assert.equal(s.recebidas_soltas.length, 1);
  assert.equal(s.recebidas_soltas[0].tipo_codigo, 'pix');
  // lançamentos
  assert.deepEqual(s.meses.map((x) => x.mes), ['2026-11', '2026-12']);
  assert.equal(s.mes_atual, '2026-11');
  const nov = s.meses[0];
  assert.equal(nov.lancamentos, 83);
  assert.equal(nov.entradas, 0);
  assert.equal(nov.saidas, 14297.12);
  assert.equal(nov.saldo, -14297.12);
  assert.equal(arred(nov.essenciais + nov.nao_essenciais), nov.saidas);
  assert.equal(arred(nov.pessoal + nov.empresa + nov.sem_dono), nov.saidas);
  assert.equal(nov.sem_dono, 496.32);
  assert.equal(nov.a_pagar, 6);
  assert.equal(nov.categorias[0].nome, 'Dívidas e parcelamentos');
  assert.equal(nov.categorias.length, 18);
  // rateio
  const r = item(s, s.rateio);
  assert.equal(r.item_id, 'rateio:2026-10');
  assert.equal(r.recebidos, 0);
  assert.equal(r.de, 3);
  assert.equal(r.estado, 'aberto');
  assert.deepEqual(r.decisoes_possiveis, ['recebi_mais_um']);
  // fechamentos e orçamento vazios
  assert.equal(s.fechamentos.linhas.length, 0);
  assert.equal(s.orcamento.linhas.length, 0);
  assert.equal(s.alertas.length, 10);
  assert.equal(s.alertas[0].id, 'A010');
  assert.equal(s.recorrentes.length, 39);
  assert.deepEqual(s.precisa, { total: 16, partes: [{ rotulo: 'contas atrasadas ou sem confirmação', n: 8 }, { rotulo: 'contas vencem em 7 dias', n: 7 }, { rotulo: 'rateio SKY esperando', n: 1 }] });
  // pagas não aceitam decisão
  assert.ok(!s.itens.some((i) => i.tipo_item === 'conta' && i.situacao === 'pago'));
});

test('financas: hash canônico de conta e de rateio (vetores do contrato)', () => {
  const c = { emissor: 'Energia Exemplo', mes_ref: '2026-11', valor_texto: '1.234,56', vencimento: '2026-11-18', forma: 'boleto', estado_texto: 'a pagar; débito em 18/11', link: 'chat 10/11', pago_em: '', codigo: '00020126580014br.gov.bcb.pix0136exemplo', pdf_fileId: '1ExemploExemploExemploExemplo12345' };
  const esperado = ['conta', 'Energia Exemplo', '2026-11', '1.234,56', '2026-11-18', 'boleto', 'a pagar; débito em 18/11', 'chat 10/11', '', '00020126580014br.gov.bcb.pix0136exemplo', '1ExemploExemploExemploExemplo12345'].join('\u001F');
  assert.equal(L.canonicoConta(c), esperado);
  assert.equal(L.sha256(esperado), crypto.createHash('sha256').update(esperado, 'utf8').digest('hex'));
  assert.equal(L.sha256(esperado), '5993849ab14caa61253ffabd1fd0c1e78e6f339f43df240790acadb35fd48a7f');
  assert.equal(L.sha256(L.canonicoRateio({ mes_ref: '2026-10', total: '600,00', por_pessoa: '150,00', enviado: 's (09/11 WhatsApp)', recebidos: '1/3' })), 'c982befc6ef4cfcfda0f839df7beda3bf14247c3e82ab201c0f7b64f57976f65');
  // o código de pagamento entra no hash: se o boleto mudar, a decisão velha é recusada
  const s = montar(), f = fontes();
  f.recebidas.linhas[0].codigo_ou_pix = '00000000000-0 00000000000-0 00000000000-0 00000000000-0';
  const id = 'conta:Águas do Vale água casa|2026-11';
  assert.notEqual(item(s, id).snapshot_hash, item(montar(f), id).snapshot_hash);
  assert.equal(item(s, 'conta:Faculdade Pós Dados|2026-11').snapshot_hash, item(montar(f), 'conta:Faculdade Pós Dados|2026-11').snapshot_hash);
});

test('financas no servidor: chave false recusa gravar e não toca no decisoes.csv', () => {
  const e = ambiente(arquivosBase());
  const d = e.obterDados(true);
  const fs8 = d.fontes.filter((f) => /Finanças/.test(f.rotulo));
  assert.ok(fs8.length === 8 && fs8.every((f) => f.ok), JSON.stringify(fs8));
  const s = d.v3.financas;
  assert.equal(s.integrado, false);
  assert.equal(s.precisa.total, 16);
  assert.equal(s.recebidas_soltas.length, 1); // contas-recebidas.csv lido da subpasta
  const x = s.itens.find((i) => i.item_id === 'conta:Faculdade Pós Dados|2026-11');
  const antes = e.arquivos.DEC.texto;
  assert.throws(() => e.salvarDecisao({ modulo: 'financas', item_id: x.item_id, decisao: 'paguei', comentario: '', snapshot_hash: x.snapshot_hash }), /o agente ainda não lê estas decisões \(Assistente Financeiro\); nada foi gravado/);
  assert.equal(e.arquivos.DEC.texto, antes);
});

test('financas no servidor: chave true grava "paguei" (data e valor opcionais) e "recebi de mais um"; recusa formato, obsoleta e repetida', () => {
  const e = ambiente(arquivosBase());
  e.PainelLib.CHAVES.FINANCAS_INTEGRADO = true;
  try {
    const d = e.obterDados(true);
    const c = d.v3.financas.itens.find((i) => i.item_id === 'conta:Seguradora Alfa seguro Hatch (renovação 2 anos, 1ª)|2026-11');
    assert.throws(() => e.salvarDecisao({ modulo: 'financas', item_id: c.item_id, decisao: 'paguei', comentario: 'data=12/11/2026', snapshot_hash: c.snapshot_hash }), /aaaa-mm-dd/);
    assert.throws(() => e.salvarDecisao({ modulo: 'financas', item_id: c.item_id, decisao: 'paguei', comentario: 'valor=171,27', snapshot_hash: c.snapshot_hash }), /valor/);
    assert.equal(e.salvarDecisao({ modulo: 'financas', item_id: c.item_id, decisao: 'paguei', comentario: 'data=2026-11-12;valor=171.27;texto=pago no cartão; ok', snapshot_hash: c.snapshot_hash }).ok, true);
    const c2 = d.v3.financas.itens.find((i) => i.item_id === 'conta:Energia Minas|2026-11');
    assert.equal(e.salvarDecisao({ modulo: 'financas', item_id: c2.item_id, decisao: 'paguei', comentario: '', snapshot_hash: c2.snapshot_hash }).ok, true);
    const r = d.v3.financas.itens.find((i) => i.item_id === 'rateio:2026-10');
    assert.throws(() => e.salvarDecisao({ modulo: 'financas', item_id: r.item_id, decisao: 'paguei', comentario: '', snapshot_hash: r.snapshot_hash }), /não vale/);
    assert.equal(e.salvarDecisao({ modulo: 'financas', item_id: r.item_id, decisao: 'recebi_mais_um', comentario: 'texto=Cunhado', snapshot_hash: r.snapshot_hash }).ok, true);
    const linhas = e.PainelLib.csvParaObjetos(e.arquivos.DEC.texto).linhas;
    assert.equal(linhas.length, 3);
    assert.deepEqual([linhas[0].modulo, linhas[0].item_id, linhas[0].tipo_item, linhas[0].decisao, linhas[0].comentario, linhas[0].snapshot_hash],
      ['financas', 'conta:Seguradora Alfa seguro Hatch (renovação 2 anos, 1ª)|2026-11', 'conta', 'paguei', 'data=2026-11-12;valor=171.27;texto=pago no cartão; ok', c.snapshot_hash]);
    assert.equal(linhas[2].tipo_item, 'rateio');
    // repetida
    assert.throws(() => e.salvarDecisao({ modulo: 'financas', item_id: r.item_id, decisao: 'recebi_mais_um', comentario: '', snapshot_hash: r.snapshot_hash }), /já existe/);
    // o agente anota 1/3 depois que a tela carregou: hash velho recusado
    e.arquivos.F5.texto = e.arquivos.F5.texto.replace(',0/3', ',1/3');
    assert.throws(() => e.salvarDecisao({ modulo: 'financas', item_id: r.item_id, decisao: 'recebi_mais_um', comentario: '', snapshot_hash: r.snapshot_hash }), /mudou|já existe/);
    // o agente marca a conta como paga: sai da lista e não aceita mais decisão
    const c3 = d.v3.financas.itens.find((i) => i.item_id === 'conta:Faculdade Pós Dados|2026-11');
    e.arquivos.F1.texto = e.arquivos.F1.texto.replace('Faculdade Pós Dados,2026-11,"571,30",2026-11-15,boleto,a pagar,chat 10/11,,', 'Faculdade Pós Dados,2026-11,"571,30",2026-11-15,boleto,pago,chat 10/11,2026-11-12,');
    assert.throws(() => e.salvarDecisao({ modulo: 'financas', item_id: c3.item_id, decisao: 'paguei', comentario: '', snapshot_hash: c3.snapshot_hash }), /não existe mais/);
    assert.equal(e.PainelLib.csvParaObjetos(e.arquivos.DEC.texto).linhas.length, 3);
    const d2 = e.obterDados(true);
    assert.equal(d2.v3.financas.itens.find((i) => i.item_id === c.item_id).decisao_pendente.decisao, 'paguei');
  } finally { e.PainelLib.CHAVES.FINANCAS_INTEGRADO = false; }
});

test('telas v3: os scripts dos módulos compilam (pega aspas quebradas antes da captura)', () => {
  const dir = path.join(__dirname, '..', 'src');
  fs.readdirSync(dir).filter((n) => /^(Mod\w+|AppV3)\.html$/.test(n)).forEach((n) => {
    const h = fs.readFileSync(path.join(dir, n), 'utf8');
    const blocos = h.match(/<script[^>]*>[\s\S]*?<\/script>/g) || [];
    blocos.forEach((b) => {
      const js = b.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
      assert.doesNotThrow(() => new Function(js), n);
    });
  });
});

test('financas: estado e origem mostrados sem os tokens que o painel já extraiu (hash usa o texto cru)', () => {
  assert.equal(L.limparTokens('a pagar; gmail:f480ac4dae299313'), 'a pagar');
  assert.equal(L.limparTokens('Extrato_2026-11-18-1.ofx (chat 10/11); outlook:AbCdEfGh123==; pdf 1ExemploExemploExemploExemplo12345'), 'Extrato_2026-11-18-1.ofx (chat 10/11)');
  assert.equal(L.limparTokens('fatura no chat 10/11; icloud:XyZ123@mta-exemplo-62'), 'fatura no chat 10/11');
  assert.equal(L.limparTokens('sem confirmação de pagamento; total R$ 861,53'), 'sem confirmação de pagamento; total R$ 861,53');
  const s = L.montarModulosV3({ financas: fontes() }, [], AGORA).financas;
  s.itens.filter((i) => i.tipo_item === 'conta').forEach((c) => {
    assert.ok(!/\b(gmail|outlook|icloud):|\bpdf\s+\w{25,}/.test(c.estado_mostrado + ' ' + c.link_mostrado), c.item_id);
  });
});

// Formato novo que o Assistente Financeiro vai gravar (test/fixtures/financas-novo/): CSV com aspas, última coluna
// nomeada, message_id/codigo/pdf_fileId em Contas, pago_em limpo, "em atraso", entradas e dono em Lancamentos,
// emissor e pagantes em Rateios. O painel aceita os dois formatos.
const txtN = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', 'financas-novo', n), 'utf8');
const fontesNovo = () => {
  const f = {};
  ['contas:Contas.csv', 'recebidas:contas-recebidas.csv', 'lancamentos:Lancamentos.csv', 'rateios:Rateios.csv'].forEach((p) => { const [k, n] = p.split(':'); f[k] = L.csvParaObjetos(txtN(n)); });
  return f;
};

test('financas formato novo: contas com message_id, codigo e pdf_fileId em colunas, sem conserto de linha', () => {
  const f = fontesNovo();
  assert.equal(f.contas.cabecalho[f.contas.cabecalho.length - 1], 'obs');
  // "total R$ 861" seguido de link "10/11 chat": no formato atual isso seria juntado; no novo não mexe
  const tv = f.contas.linhas[2];
  assert.equal(L.consertarLinha(tv, f.contas.cabecalho), tv);
  const s = montar(f);
  assert.equal(s.contas.consertadas, 0);
  const tvi = item(s, 'conta:TV Estrela (minha parte 1/4)|2026-11');
  assert.equal(tvi.estado_texto, 'sem confirmação de pagamento; total R$ 861');
  assert.equal(tvi.link, '10/11 chat');
  // message_id na coluna liga a recebida (Pix e PDF dela)
  const en = item(s, 'conta:Energia Minas|2026-11');
  assert.equal(en.tipo_codigo, 'pix');
  assert.equal(en.pdf_fileId, '1ExemploPdfEnergiaMinas12345678');
  assert.equal(en.message_id, 'gmail:0a1b2c3d4e5f6071');
  assert.equal(s.recebidas_soltas.length, 0);
  // codigo e pdf_fileId da própria conta
  const fac = item(s, 'conta:Faculdade Pós Dados|2026-11');
  assert.equal(fac.tipo_codigo, 'barras');
  assert.equal(fac.codigo, '23793.38128 60000.000003 12000.000400 1 98760000057130');
  assert.equal(item(s, 'conta:Banco Roxo PF cartão (pessoal)|2026-11').pdf_fileId, '1ExemploPdfFaturaBancoRoxo12345');
  // "em atraso" pelo começo do texto; pago com pago_em limpo
  const ag = item(s, 'conta:Águas do Vale água casa|2026-10');
  assert.equal(ag.estado, 'atraso');
  assert.equal(ag.situacao, 'atraso');
  assert.deepEqual(s.contas.pagas.map((p) => [p.emissor, p.pago_em]), [['Internet Fibra Net', '2026-11-10']]);
  assert.equal(s.contas.urgentes.length, 2);
  // hash da conta continua com os mesmos campos (codigo e pdf_fileId vindos da coluna)
  assert.equal(fac.snapshot_hash, L.sha256(L.canonicoConta(fac)));
});

test('financas formato novo: entradas e dono em Lancamentos, emissor e pagantes em Rateios', () => {
  const s = montar(fontesNovo());
  const nov = s.meses.find((x) => x.mes === '2026-11');
  assert.equal(nov.entradas, 5840.5);
  assert.equal(nov.saidas, 1561.6);
  assert.equal(nov.saldo, 4278.9);
  assert.equal(nov.sem_dono, 0);
  assert.equal(nov.empresa, 96.4);
  assert.equal(nov.a_pagar, 1);
  const r = item(s, s.rateio);
  assert.equal(r.item_id, 'rateio:2026-10');
  assert.equal(r.emissor, 'TV Estrela');
  assert.deepEqual(r.pagantes, ['Ana', 'Rita']);
  assert.equal(r.recebidos, 2);
  assert.equal(r.de, 3);
  assert.equal(r.estado, 'aberto');
  assert.deepEqual(r.decisoes_possiveis, ['recebi_mais_um']);
  assert.deepEqual(s.precisa.partes[2], { rotulo: 'rateio TV Estrela esperando', n: 1 });
  // canônico novo: emissor e pagantes no fim (vetor do contrato)
  const can = L.canonicoRateio({ mes_ref: '2026-10', total: '861,53', por_pessoa: '136,34', enviado: 's (09/11 09:17 WhatsApp Grupo TV)', recebidos: '2/3', emissor: 'TV Estrela', pagantes: 'Ana; Rita' }, true);
  assert.equal(can, ['rateio', '2026-10', '861,53', '136,34', 's (09/11 09:17 WhatsApp Grupo TV)', '2/3', 'TV Estrela', 'Ana; Rita'].join('\u001F'));
  assert.equal(r.snapshot_hash, L.sha256(can));
  assert.equal(L.sha256(can), '6ff1894773e2ff47970e3fa90cc8dea57b65809d44d12dca10f2b91143c7673f');
});
