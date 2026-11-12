// Teste do servidor (Code.gs) com DriveApp, CacheService etc. simulados.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const src = (n) => fs.readFileSync(path.join(__dirname, '..', 'src', n), 'utf8');
const fx = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8');

const { ambiente, arquivosBase } = require('../dev/ambiente-gas');

test('obterDados lê todas as fontes e usa o cache na segunda chamada', () => {
  const e = ambiente(arquivosBase());
  const d1 = e.obterDados(false);
  assert.equal(d1.do_cache, false);
  assert.ok(d1.fontes.every((f) => f.ok), JSON.stringify(d1.fontes));
  assert.equal(d1.designs.length, 11);
  assert.equal(d1.modulos.filter((m) => !m.ativo).length, 3);
  // agora = 11/11 15:00 em São Paulo: reels das 18:30 ainda programado
  assert.equal(d1.posts.find((p) => p.id === 'P-20261109-01').estado, 'programado');
  assert.deepEqual(d1.inicio.artes_entregues.sort(), ['P-20261111-02', 'P-20261111-03']);
  const d2 = e.obterDados(false);
  assert.equal(d2.do_cache, true);
  assert.equal(e.obterDados(true).do_cache, false);
});

test('CSV quebrado ou ausente vira aviso e o resto funciona', () => {
  const a = arquivosBase();
  a.C.texto = 'source,cursor\n"x,sem fechar\n';
  delete a.M;
  const d = ambiente(a).obterDados(true);
  const porRot = Object.fromEntries(d.fontes.map((f) => [f.rotulo, f]));
  assert.equal(porRot['Checkpoints (ledger do Design)'].ok, false);
  assert.match(porRot['Checkpoints (ledger do Design)'].erro, /aspas/);
  assert.equal(porRot['Mídia (ledger do Design)'].ok, false);
  assert.match(porRot['Mídia (ledger do Design)'].erro, /não está na pasta/);
  assert.equal(d.designs.length, 11);
  assert.deepEqual(d.midia, []);
});

test('salvarDecisao grava a versão exibida, só acrescenta e rejeita snapshot obsoleto', () => {
  const e = ambiente(arquivosBase());
  const d = e.obterDados(false);
  const item = d.designs.find((x) => x.id === 'P-20261111-03');
  const r = e.salvarDecisao({ modulo: 'design', item_id: 'P-20261111-03', decisao: 'refazer', comentario: 'Trocar a foto, "maior"', snapshot_hash: item.snapshot_hash });
  assert.equal(r.ok, true);
  assert.match(r.id, /^D-20261111-150000-abcdef12$/);
  const linhas = e.PainelLib.csvParaObjetos(e.arquivos.DEC.texto).linhas;
  assert.equal(linhas.length, 1);
  assert.equal(linhas[0].comentario, 'Trocar a foto, "maior"');
  assert.equal(linhas[0].origem, 'painel');
  assert.equal(linhas[0].tipo_item, 'design');
  assert.equal(linhas[0].versao, item.versao);
  assert.equal(linhas[0].arte_fileId, item.arte_fileId);
  assert.equal(linhas[0].snapshot_hash, item.snapshot_hash);
  // repetida para a mesma versão
  assert.throws(() => e.salvarDecisao({ modulo: 'design', item_id: 'P-20261111-03', decisao: 'aprovar', snapshot_hash: item.snapshot_hash }), /já existe/);
  // o agente troca a arte do 02 depois que a tela carregou: snapshot antigo é recusado
  const item02 = d.designs.find((x) => x.id === 'P-20261111-02');
  e.arquivos.A.texto = e.arquivos.A.texto.replace(item02.arte_fileId, 'NOVA_ARTE_v2_0000000');
  assert.throws(() => e.salvarDecisao({ modulo: 'design', item_id: 'P-20261111-02', decisao: 'aprovar', snapshot_hash: item02.snapshot_hash }), /mudou/);
  // item que não aceita decisão
  const ap = d.designs.find((x) => x.id === 'P-20261111-01');
  assert.throws(() => e.salvarDecisao({ modulo: 'design', item_id: 'P-20261111-01', decisao: 'aprovar', snapshot_hash: ap.snapshot_hash }), /não aceita/);
  assert.equal(e.PainelLib.csvParaObjetos(e.arquivos.DEC.texto).linhas.length, 1);
  const depois = e.obterDados(false);
  assert.equal(depois.do_cache, false);
  assert.equal(depois.designs.find((x) => x.id === 'P-20261111-03').decisao_pendente.versao, item.versao);
});

test('recibo imutável do agente encerra a pendência; recibo inválido vira aviso', () => {
  const a = arquivosBase();
  const e = ambiente(a);
  const d = e.obterDados(true);
  const item = d.designs.find((x) => x.id === 'P-20261111-02');
  const r = e.salvarDecisao({ modulo: 'design', item_id: 'P-20261111-02', decisao: 'aprovar', snapshot_hash: item.snapshot_hash });
  assert.equal(e.obterDados(true).inicio.decisoes_pendentes.length, 1);
  a.REC1 = { nome: r.id + '.json', pasta: 'RECIBOS', texto: JSON.stringify({ decision_id: r.id, resultado: 'aplicado', processado_em: '2026-11-11T16:00:00-03:00', agente: 'Agente de Design', snapshot_hash: item.snapshot_hash }) };
  a.REC2 = { nome: 'D-lixo.json', pasta: 'RECIBOS', texto: '{quebrado' };
  const d2 = e.obterDados(true);
  assert.equal(d2.inicio.decisoes_pendentes.length, 0);
  const fr = d2.fontes.find((f) => f.rotulo === 'Recibos dos agentes');
  assert.equal(fr.ok, true);
  assert.match(fr.avisos[0], /D-lixo\.json/);
  // o CSV de entrada não foi tocado pelo recibo
  assert.equal(e.PainelLib.csvParaObjetos(a.DEC.texto).linhas.length, 1);
});

test('cabeçalho antigo de decisoes.csv: nada é gravado', () => {
  const a = arquivosBase();
  a.DEC.texto = 'id,quando,modulo,item_id,decisao,comentario,origem,processado_em\n';
  const e = ambiente(a);
  const d = e.obterDados(true);
  const item = d.designs.find((x) => x.id === 'P-20261111-02');
  assert.throws(() => e.salvarDecisao({ modulo: 'design', item_id: 'P-20261111-02', decisao: 'aprovar', snapshot_hash: item.snapshot_hash }), /decisoes\.csv|recibos/);
  assert.equal(a.DEC.texto, 'id,quando,modulo,item_id,decisao,comentario,origem,processado_em\n');
});

// ---------- Módulo Posts e anúncios ----------

test('anuncios: sem Propostas.csv nada quebra e aparece como aviso informativo', () => {
  const d = ambiente(arquivosBase()).obterDados(true);
  assert.ok(d.anuncios, 'módulo anuncios montado');
  assert.equal(d.anuncios.propostas_ativas, false);
  const fp = d.fontes.find((f) => f.rotulo === 'Propostas (Tráfego)');
  assert.equal(fp.ok, true); assert.equal(fp.ausente, true);
  assert.ok(d.fontes.filter((f) => !f.ausente).every((f) => f.ok), JSON.stringify(d.fontes.filter((f) => !f.ok)));
  assert.equal(d.anuncios.posts.filter((p) => /^ORG-/.test(p.id)).length, 7);
  assert.deepEqual(d.anuncios.inicio.planos_aguardando, ['C01', 'C02', 'C03', 'C04', 'C05']);
  assert.ok(d.anuncios.posts.every((p) => !p.decisoes_possiveis.length));
  assert.equal(d.anuncios.campanhas.find((c) => c.id === 'C02').plano.nome, 'plano-teste-2026-11.md');
});

function comPropostas() {
  const a = arquivosBase();
  a.TP = { nome: 'Propostas.csv', pasta: 'TRAF', texto: fx('anuncios/Propostas.csv') };
  return a;
}

test('anuncios: com a chave desligada o servidor não grava nada', () => {
  const a = comPropostas();
  const e = ambiente(a);
  const d = e.obterDados(true);
  assert.equal(d.anuncios.integrados, false);
  const p = d.anuncios.posts.find((x) => x.id === 'P-20261111-01');
  assert.throws(() => e.salvarDecisao({ modulo: 'anuncios', item_id: 'post:P-20261111-01', decisao: 'aprovar', comentario: 'legenda=1', snapshot_hash: p.snapshot_hash }), /ainda não lê estas decisões/);
  assert.equal(e.PainelLib.csvParaObjetos(a.DEC.texto).linhas.length, 0);
});

test('anuncios: com a chave ligada grava post e campanha com tipo_item certo; hash velho não grava', () => {
  const a = comPropostas();
  const e = ambiente(a);
  e.PainelLib.CHAVES.ANUNCIOS_INTEGRADOS = true;
  const d = e.obterDados(true);
  const car = d.anuncios.posts.find((x) => x.id === 'P-20261112-CAT');
  const r1 = e.salvarDecisao({ modulo: 'anuncios', item_id: 'post:P-20261112-CAT', decisao: 'aprovar', comentario: 'legenda=2;horario=2026-11-16 19:00;texto=ok, pode; usar = isso', snapshot_hash: car.snapshot_hash });
  assert.equal(r1.ok, true);
  const c02 = d.anuncios.campanhas.find((x) => x.id === 'C02');
  e.salvarDecisao({ modulo: 'anuncios', item_id: 'campanha:C02', decisao: 'aprovar', comentario: 'verba=8', snapshot_hash: c02.snapshot_hash });
  let linhas = e.PainelLib.csvParaObjetos(a.DEC.texto).linhas;
  assert.equal(linhas.length, 2);
  assert.equal(linhas[0].modulo, 'anuncios'); assert.equal(linhas[0].tipo_item, 'post'); assert.equal(linhas[0].versao, '1');
  assert.equal(linhas[0].arte_fileId.split(';').length, 10);
  assert.equal(linhas[0].snapshot_hash, car.snapshot_hash);
  assert.equal(linhas[0].comentario, 'legenda=2;horario=2026-11-16 19:00;texto=ok, pode; usar = isso');
  assert.equal(linhas[1].tipo_item, 'campanha'); assert.equal(linhas[1].arte_fileId, '');
  // verba acima da proposta
  const m = d.anuncios.campanhas.find((x) => x.id === 'M-52562345108818');
  assert.throws(() => e.salvarDecisao({ modulo: 'anuncios', item_id: 'campanha:M-52562345108818', decisao: 'aprovar', comentario: '', snapshot_hash: m.snapshot_hash }), /não aceita aprovar/);
  e.salvarDecisao({ modulo: 'anuncios', item_id: 'campanha:M-52562345108818', decisao: 'pausar', comentario: '', snapshot_hash: m.snapshot_hash });
  // o Tráfego muda a legenda do P-20261111-01 depois que a tela carregou
  const p1 = d.anuncios.posts.find((x) => x.id === 'P-20261111-01');
  a.TP.texto = a.TP.texto.replace('Um detalhe que muda a mesa de Natal.', 'Um detalhe que transforma a mesa de Natal.');
  assert.throws(() => e.salvarDecisao({ modulo: 'anuncios', item_id: 'post:P-20261111-01', decisao: 'aprovar', comentario: 'legenda=1', snapshot_hash: p1.snapshot_hash }), /mudou/);
  linhas = e.PainelLib.csvParaObjetos(a.DEC.texto).linhas;
  assert.equal(linhas.length, 3);
  assert.equal(linhas[2].decisao, 'pausar');
  // pendência aparece no item
  const d2 = e.obterDados(true);
  assert.equal(d2.anuncios.posts.find((x) => x.id === 'P-20261112-CAT').decisao_pendente.decisao, 'aprovar');
  assert.equal(d2.inicio.decisoes_pendentes.length, 3);
  e.PainelLib.CHAVES.ANUNCIOS_INTEGRADOS = false;
});

test('anuncios: verba maior que a proposta e comentário fora do formato são recusados', () => {
  const a = comPropostas();
  const e = ambiente(a);
  e.PainelLib.CHAVES.ANUNCIOS_INTEGRADOS = true;
  const d = e.obterDados(true);
  const c02 = d.anuncios.campanhas.find((x) => x.id === 'C02');
  assert.throws(() => e.salvarDecisao({ modulo: 'anuncios', item_id: 'campanha:C02', decisao: 'aprovar', comentario: 'verba=12', snapshot_hash: c02.snapshot_hash }), /maior que a proposta/);
  const p1 = d.anuncios.posts.find((x) => x.id === 'P-20261111-01');
  assert.throws(() => e.salvarDecisao({ modulo: 'anuncios', item_id: 'post:P-20261111-01', decisao: 'aprovar', comentario: 'texto=sem legenda', snapshot_hash: p1.snapshot_hash }), /legenda 1 ou 2/);
  assert.throws(() => e.salvarDecisao({ modulo: 'anuncios', item_id: 'post:P-20261111-01', decisao: 'refazer', comentario: 'trocar a foto', snapshot_hash: p1.snapshot_hash }), /chave=valor/);
  // publicação do ledger (sem Propostas) não aceita decisão
  const org = d.anuncios.posts.find((x) => x.id === 'ORG-20261111-03');
  assert.ok(org);
  assert.throws(() => e.salvarDecisao({ modulo: 'anuncios', item_id: 'post:ORG-20261111-03', decisao: 'aprovar', comentario: 'legenda=1', snapshot_hash: 'a'.repeat(64) }), /não está em Propostas/);
  // programação juntada a uma proposta não existe como item próprio
  assert.throws(() => e.salvarDecisao({ modulo: 'anuncios', item_id: 'post:ORG-20261112-01', decisao: 'aprovar', comentario: 'legenda=1', snapshot_hash: 'a'.repeat(64) }), /não existe mais/);
  assert.equal(e.PainelLib.csvParaObjetos(a.DEC.texto).linhas.length, 0);
  e.PainelLib.CHAVES.ANUNCIOS_INTEGRADOS = false;
});

test('v2.0.1 cache: tela anterior sai na hora marcada como desatualizada; leitura forçada traz a nova', () => {
  const e = ambiente(arquivosBase());
  const d1 = e.obterDados(false);
  assert.equal(d1.desatualizado, false);
  // expira o cache de 5 min (fica só a cópia de 6 h)
  delete e.cache['painel_v2_dados_n'];
  const d2 = e.obterDados(false);
  assert.equal(d2.do_cache, true);
  assert.equal(d2.desatualizado, true);
  const d3 = e.obterDados(true);
  assert.equal(d3.do_cache, false);
  assert.equal(d3.desatualizado, false);
  assert.equal(e.obterDados(false).desatualizado, false);
});

test('v2.0.1 cache: texto do arquivo vem do cache até o arquivo mudar no Drive', () => {
  const e = ambiente(arquivosBase());
  e.obterDados(true);
  const antes = e.leituras.TC;
  assert.ok(antes >= 1);
  e.obterDados(true);
  assert.equal(e.leituras.TC, antes, 'Campanhas.csv relido sem ter mudado');
  // o Tráfego altera Campanhas.csv: data nova, texto novo
  e.arquivos.TC.texto = e.arquivos.TC.texto.replace('C02,BD 3D', 'C02,BD 3D NOVO');
  e.arquivos.TC.atualizado = '2026-11-12T18:00:00Z';
  const d = e.obterDados(true);
  assert.equal(e.leituras.TC, antes + 1);
  assert.equal(d.anuncios.campanhas.find((x) => x.id === 'C02').empresa !== undefined, true);
  assert.ok(JSON.stringify(d.anuncios.campanhas).includes('BD 3D NOVO'));
});

test('v2.0.1 cache: decisão gravada limpa a tela anterior também', () => {
  const e = ambiente(arquivosBase());
  const d = e.obterDados(false);
  const item = d.designs.find((x) => x.estado === 'entregue');
  e.salvarDecisao({ modulo: 'design', item_id: item.id, decisao: 'aprovar', snapshot_hash: item.snapshot_hash });
  const depois = e.obterDados(false);
  assert.equal(depois.do_cache, false);
  assert.ok(depois.designs.find((x) => x.id === item.id).decisao_pendente);
});
