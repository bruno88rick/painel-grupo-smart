// v3: módulo E-mails (fixtures anonimizadas em test/fixtures/emails/, mesmo formato e sujeira dos originais).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { ambiente, arquivosBase } = require('../dev/ambiente-gas');

const m = { exports: {} };
new Function('module', fs.readFileSync(path.join(__dirname, '..', 'src', 'Lib.gs'), 'utf8'))(m);
const L = m.exports;
const txt = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', 'emails', n), 'utf8');
const fontes = () => ({ movimentos: L.csvParaObjetos(txt('Movimentos.csv')), pendencias: L.csvParaObjetos(txt('Pendencias.csv')), alertas: L.csvParaObjetos(txt('Alerts.csv')), rascunhos: L.csvParaObjetos(txt('Rascunhos.csv')) });
const AGORA = new Date(2026, 10, 12, 19);
const montar = (f, dec) => L.montarModulosV3({ emails: f || fontes() }, dec || [], AGORA).emails;

test('emails: parser aguenta 280 linhas com CRLF, aspas, vírgulas, "|" e "=" no message_id', () => {
  assert.ok(txt('Movimentos.csv').includes('\r\n'));
  const mv = L.csvParaObjetos(txt('Movimentos.csv'));
  assert.equal(mv.linhas.length, 280);
  assert.ok(mv.linhas.every((x) => x.message_id && x.conta && x.estado));
  const lote = mv.linhas.find((x) => x.message_id === 'icloud:lote-2026-11-12t|RN Sports');
  assert.equal(lote.motivo, '13 e-mails por regras no Mac');
  assert.ok(mv.linhas.some((x) => /==$/.test(x.message_id)));
  assert.ok(mv.linhas.some((x) => x.estado === 'movido 2026-11-06 | duplicado: id de conector, ver linha do Mac'));
  const pd = L.csvParaObjetos(txt('Pendencias.csv'));
  assert.equal(pd.linhas.length, 27);
  assert.ok(pd.linhas.some((x) => x.assunto === 'Ação obrigatória: atualização cadastral, prazo 11/11'));
  // Rascunhos.csv: só o cabeçalho, com LF
  assert.equal(L.csvParaObjetos(txt('Rascunhos.csv')).linhas.length, 0);
  // Alerts.csv: última coluna vazia em todas as linhas e alert_id repetido
  const al = L.csvParaObjetos(txt('Alerts.csv'));
  assert.equal(al.linhas.length, 14);
  assert.equal(al.linhas.filter((a) => a.alert_id === 'A004').length, 2);
});

test('emails: estado livre classificado pelo começo do texto', () => {
  const M = L.ESTADOS_MOVIMENTO, P = L.ESTADOS_PENDENCIA;
  assert.equal(L.classificarComeco('proposto', M), 'proposto');
  assert.equal(L.classificarComeco('aguardando novo sim (entrada mudou)', M), 'proposto');
  assert.equal(L.classificarComeco('movido 2026-11-12 (Hotmail)', M), 'movido');
  assert.equal(L.classificarComeco('Recusado 2026-11-12 (usuário pediu deixar na entrada)', M), 'recusado');
  assert.equal(L.classificarComeco('já fora da entrada 2026-11-10', M), 'fora');
  assert.equal(L.classificarComeco('fora da entrada: já em Promoções | duplicado', M), 'fora');
  assert.equal(L.classificarComeco('substituído pela contagem de 2026-11-11', M), 'substituido');
  assert.equal(L.classificarComeco('aberta (fora da entrada no Mac; id de conector)', P), 'aberta');
  assert.equal(L.classificarComeco('Fechada', P), 'fechada');
  assert.equal(L.classificarComeco('saiu da entrada (pelo usuário) 2026-11-09', P), 'saiu');
  assert.equal(L.classificarComeco('duplicado: ver linhas do Mac', P), 'duplicado');
  const s = montar();
  const x = s.itens.find((i) => i.tipo_item === 'pendencia' && /^aberta \(/.test(i.estado_texto));
  assert.equal(x.estado, 'aberta');
  assert.equal(x.estado_texto, 'aberta (fora da entrada no Mac; id de conector)');
});

test('emails: grupos por conta e pasta, lotes, pendências, alertas e contagem do Início', () => {
  const s = montar();
  assert.equal(s.integrado, false);
  assert.equal(s.grupos, 12);
  assert.equal(s.emails_propostos, 53);
  const g = s.itens.filter((i) => i.tipo_item === 'grupo');
  assert.equal(g[0].item_id, 'grupo:iCloud|Promoções');
  assert.equal(g[0].emails, 16); // vale só o lote mais recente
  assert.equal(g[0].lotes_antigos.length, 1);
  assert.equal(g[0].lotes_antigos[0].estado_texto, 'aguardando novo sim (entrada mudou)');
  assert.equal(g[0].versao, '');
  assert.deepEqual(g[0].decisoes_possiveis, ['aprovar', 'recusar']);
  const lemb = g.find((i) => i.item_id === 'grupo:Exchange|Lembretes e Aniversários');
  assert.equal(lemb.emails, 3);
  assert.equal(lemb.linhas.length, 3);
  // linhas repetidas do mesmo message_id: vale a última
  assert.equal(s.movimentos.linhas, 280);
  assert.equal(s.movimentos.unicos, 275);
  assert.deepEqual(s.movimentos.por_estado[0], { nome: 'movido', n: 224 });
  // pendências: 24 message_ids, 17 abertas; a que precisa de resposta vem primeiro
  assert.equal(s.pendencias.total, 24);
  assert.equal(s.pendencias.abertas, 17);
  assert.equal(s.pendencias.precisam_resposta, 1);
  const p0 = s.itens.find((i) => i.item_id === s.abertas[0]);
  assert.equal(p0.precisa_resposta, true);
  assert.deepEqual(p0.decisoes_possiveis, ['resolvida', 'pedir_rascunho']);
  const dup = s.itens.find((i) => i.item_id === 'pendencia:iKoEFrYC772UqPE3JiCyzH@mta87e.exemplo.net');
  assert.equal(dup.assunto, 'Fatura do cartão paga parcialmente (2 avisos)');
  assert.equal(dup.dias, 6);
  // alertas: os mais novos primeiro, todos os tiers
  assert.equal(s.alertas.length, 10);
  assert.equal(s.alertas[0].id, 'A013');
  assert.equal(s.alertas[1].tier, 'Now');
  assert.equal(s.alertas_semana.total, 14);
  assert.deepEqual(s.rascunhos, []);
  assert.deepEqual(s.precisa, { total: 29, partes: [{ rotulo: 'grupos de movimentação para aprovar', n: 12 }, { rotulo: 'pendências abertas', n: 17 }] });
  // nunca corpo nem anexos: só os campos do Drive
  const campos = new Set(); s.itens.filter((i) => i.tipo_item === 'pendencia').forEach((i) => Object.keys(i).forEach((k) => campos.add(k)));
  assert.ok(!campos.has('corpo') && !campos.has('anexos'));
});

test('emails: rascunho aparece com remetente e assunto da pendência do mesmo message_id', () => {
  const f = fontes();
  const r = L.csvParaObjetos('draft_id,message_id,conta,criado_em,chegou_em,estado,resultado\r\nR1,outlook:QBSwj0pmBrb3oqSWLgsL9F==,Exchange,2026-11-12T10:00-03:00,2026-11-10T07:53-03:00,"pronto no Mac, aguardando",\r\n');
  f.rascunhos = r;
  const s = montar(f);
  assert.equal(s.rascunhos.length, 1);
  assert.equal(s.rascunhos[0].remetente, 'Esportes Exemplo (formulário)');
  assert.equal(s.rascunhos[0].estado, 'pronto no Mac, aguardando');
});

test('emails: hash canônico de grupo e de pendência (vetores do contrato)', () => {
  const linhas = [
    { message_id: 'outlook:BBB==', motivo: 'Loja Exemplo: oferta · propaganda', proposto_em: '2026-11-12T14:05-03:00', estado: 'proposto' },
    { message_id: 'outlook:AAA==', motivo: 'Farmácia Um: oferta do dia · propaganda', proposto_em: '2026-11-12T14:05-03:00', estado: 'proposto' }
  ];
  const esperado = ['grupo', 'Exchange', 'Promoções', 'outlook:AAA==', 'Farmácia Um: oferta do dia · propaganda', '2026-11-12T14:05-03:00', 'proposto', 'outlook:BBB==', 'Loja Exemplo: oferta · propaganda', '2026-11-12T14:05-03:00', 'proposto'].join('\u001F');
  assert.equal(L.canonicoGrupoEmails('Exchange', 'Promoções', linhas), esperado);
  assert.equal(L.sha256(esperado), crypto.createHash('sha256').update(esperado, 'utf8').digest('hex'));
  assert.equal(L.sha256(esperado), '9cc59d468cdcef97f4881b196623e989e1581b45ba1ce6081183a28dee67b91f');
  const p = { message_id: 'outlook:CCC==', conta: 'Exchange', remetente: 'Banco Exemplo', assunto: 'Fatura fechou, débito em 18/11', chegou_em: '2026-11-11T00:21-03:00', motivo: 'deixar saldo até 17/11', precisa_resposta: 'não', rascunho: '', estado: 'aberta', fechado_em: '' };
  assert.equal(L.sha256(L.canonicoPendencia(p)), 'bdf8107628140b1d049193d35a8f187d86a4d471be497409ae3b340e7fb23b44');
  // um e-mail a mais no grupo muda o hash; lote antigo não entra
  const s = montar(), f = fontes();
  f.movimentos.linhas.push({ message_id: 'gmail:ffff000011112222', conta: 'Google', pasta: 'Promoções', motivo: 'Loja nova · propaganda', proposto_em: '2026-11-12T18:00-03:00', estado: 'proposto' });
  const s2 = montar(f);
  const h = (x, id) => x.itens.find((i) => i.item_id === id).snapshot_hash;
  assert.notEqual(h(s, 'grupo:Google|Promoções'), h(s2, 'grupo:Google|Promoções'));
  assert.equal(h(s, 'grupo:iCloud|Promoções'), h(s2, 'grupo:iCloud|Promoções'));
  const f3 = fontes();
  f3.movimentos.linhas.find((x) => x.message_id === 'icloud:lote-2026-11-10|Promoções').motivo = '99 e-mails por regras no Mac';
  assert.equal(h(s, 'grupo:iCloud|Promoções'), h(montar(f3), 'grupo:iCloud|Promoções'));
});

test('emails no servidor: chave false recusa gravar e não toca no decisoes.csv', () => {
  const e = ambiente(arquivosBase());
  const d = e.obterDados(true);
  assert.ok(d.fontes.filter((f) => /E-mails/.test(f.rotulo)).length === 4 && d.fontes.filter((f) => /E-mails/.test(f.rotulo)).every((f) => f.ok), JSON.stringify(d.fontes));
  const s = d.v3.emails;
  assert.equal(s.integrado, false);
  assert.equal(s.precisa.total, 29);
  const x = s.itens.find((i) => i.item_id === 'grupo:iCloud|Promoções');
  const antes = e.arquivos.DEC.texto;
  assert.throws(() => e.salvarDecisao({ modulo: 'emails', item_id: x.item_id, decisao: 'aprovar', comentario: '', snapshot_hash: x.snapshot_hash }), /o agente ainda não lê estas decisões \(Gestor de E-mails\); nada foi gravado/);
  assert.equal(e.arquivos.DEC.texto, antes);
});

test('emails no servidor: chave true grava grupo e pendência; recusa obsoleta, repetida, fechada e decisão de outro tipo', () => {
  const e = ambiente(arquivosBase());
  e.PainelLib.CHAVES.EMAILS_INTEGRADO = true;
  try {
    const d = e.obterDados(true);
    const g = d.v3.emails.itens.find((i) => i.item_id === 'grupo:Exchange|Lembretes e Aniversários');
    const r = e.salvarDecisao({ modulo: 'emails', item_id: g.item_id, decisao: 'recusar', comentario: 'texto=deixe os lembretes na entrada', snapshot_hash: g.snapshot_hash });
    assert.equal(r.ok, true);
    const p = d.v3.emails.itens.find((i) => i.item_id === d.v3.emails.abertas[0]);
    assert.equal(e.salvarDecisao({ modulo: 'emails', item_id: p.item_id, decisao: 'pedir_rascunho', comentario: '', snapshot_hash: p.snapshot_hash }).ok, true);
    const linhas = e.PainelLib.csvParaObjetos(e.arquivos.DEC.texto).linhas;
    assert.equal(linhas.length, 2);
    assert.deepEqual([linhas[0].modulo, linhas[0].item_id, linhas[0].tipo_item, linhas[0].decisao, linhas[0].comentario, linhas[0].snapshot_hash], ['emails', 'grupo:Exchange|Lembretes e Aniversários', 'grupo', 'recusar', 'texto=deixe os lembretes na entrada', g.snapshot_hash]);
    assert.equal(linhas[1].tipo_item, 'pendencia');
    // repetida
    assert.throws(() => e.salvarDecisao({ modulo: 'emails', item_id: g.item_id, decisao: 'aprovar', comentario: '', snapshot_hash: g.snapshot_hash }), /já existe/);
    // decisão de pendência não vale para grupo
    const g2 = d.v3.emails.itens.find((i) => i.item_id === 'grupo:Google|Promoções');
    assert.throws(() => e.salvarDecisao({ modulo: 'emails', item_id: g2.item_id, decisao: 'resolvida', comentario: '', snapshot_hash: g2.snapshot_hash }), /não vale/);
    // o agente propõe mais um e-mail no grupo depois que a tela carregou: hash velho recusado
    e.arquivos.E1.texto += 'gmail:ffff000011112222,Google,Promoções,Loja nova · propaganda,2026-11-12T18:00-03:00,proposto\r\n';
    assert.throws(() => e.salvarDecisao({ modulo: 'emails', item_id: g2.item_id, decisao: 'aprovar', comentario: '', snapshot_hash: g2.snapshot_hash }), /mudou/);
    // pendência fechada não existe como item; o agente fecha uma aberta: não aceita mais
    const p2 = d.v3.emails.itens.find((i) => i.item_id === d.v3.emails.abertas[1]);
    const id2 = p2.message_id;
    e.arquivos.E2.texto = e.arquivos.E2.texto.split('\r\n').map((l) => (l.startsWith(id2 + ',') ? l.replace(/,aberta,$/, ',fechada,2026-11-12T18:30') : l)).join('\r\n');
    assert.throws(() => e.salvarDecisao({ modulo: 'emails', item_id: p2.item_id, decisao: 'resolvida', comentario: '', snapshot_hash: p2.snapshot_hash }), /não existe mais|não aceita|mudou/);
    assert.equal(e.PainelLib.csvParaObjetos(e.arquivos.DEC.texto).linhas.length, 2);
    // as pendências aparecem nos itens
    const d2 = e.obterDados(true);
    assert.equal(d2.v3.emails.itens.find((i) => i.item_id === g.item_id).decisao_pendente.decisao, 'recusar');
  } finally { e.PainelLib.CHAVES.EMAILS_INTEGRADO = false; }
});
