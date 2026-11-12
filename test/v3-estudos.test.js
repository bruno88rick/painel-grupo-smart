// v3: módulo Estudos, só leitura (fixtures anonimizadas em test/fixtures/estudos/, mesmo formato e sujeira dos originais).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { ambiente, arquivosBase } = require('../dev/ambiente-gas');

const m = { exports: {} };
new Function('module', fs.readFileSync(path.join(__dirname, '..', 'src', 'Lib.gs'), 'utf8'))(m);
const L = m.exports;
const txt = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', 'estudos', n), 'utf8');
const ARQ = { cursos: 'Cursos.csv', entregas: 'Entregas.csv', modulos: 'Modulos.csv', provas: 'Provas.csv', pedidos: 'Pedidos.csv' };
const fontes = (extra) => { const f = {}; Object.keys(ARQ).forEach((k) => { f[k] = L.csvParaObjetos(txt(ARQ[k]) + ((extra || {})[k] || '')); }); return f; };
const AGORA = new Date(2026, 10, 12, 19);
const montar = (f, agora) => L.montarModulosV3({ estudos: f || fontes() }, [], agora || AGORA).estudos;
const mod = (s, nome) => s.cursos[0].modulos.find((x) => x.modulo === nome);

test('estudos: parser aguenta CRLF, acentos decompostos do Mac, vírgula entre aspas e arquivo só com cabeçalho', () => {
  const bruto = txt('Modulos.csv');
  assert.ok(bruto.includes('\r\n'));
  assert.ok(/\u0301/.test(bruto)); // "Análise" gravado como "Ana" + acento combinado
  const c = L.csvParaObjetos(bruto);
  assert.equal(c.linhas.length, 28);
  assert.equal(c.linhas.find((x) => /Energias/.test(x.modulo)).modulo.normalize('NFC'), 'MÓDULO 3 - Energias Renováveis, Eficiência Energética, Créditos de Carbono e Mercaddo Voluntário');
  assert.equal(L.nfc('Ana\u0301lise'), 'Análise');
  assert.equal(L.csvParaObjetos(txt('Provas.csv')).linhas.length, 0);
  // datas
  assert.deepEqual(L.quandoEstudo('2026-11-18 21:00'), new Date(2026, 10, 18, 21, 0));
  assert.deepEqual(L.quandoEstudo('2026-11-20'), new Date(2026, 10, 20, 23, 59)); // só a data: vale até o fim do dia
  assert.equal(L.quandoEstudo('a confirmar'), null);
  // caminho do resumo, relativo à pasta de materiais
  assert.deepEqual(L.caminhoResumo('materiais/espec_omega/resumo_fase3_modulo1_recursos_hidricos.md'), { caminho: 'espec_omega/resumo_fase3_modulo1_recursos_hidricos.md', nota: '' });
  assert.deepEqual(L.caminhoResumo('resumo_mestre_espec_omega_2026_11_05.md seção 8.3'), { caminho: 'resumo_mestre_espec_omega_2026_11_05.md', nota: 'seção 8.3' });
  assert.deepEqual(L.caminhoResumo(''), { caminho: '', nota: '' });
});

test('estudos: situação do resumo pelo começo do texto e contagem regressiva', () => {
  const E = L.ESTADOS_RESUMO;
  assert.equal(L.classificarComeco('2026-06-22', E, 'outro'), 'resumido');
  assert.equal(L.classificarComeco('parcial (conteúdo antecipado no Resumo Mestre 22/06)', E, 'outro'), 'parcial');
  assert.equal(L.classificarComeco('Parcial', E, 'outro'), 'parcial');
  assert.equal(L.classificarComeco('sem resumo ainda', E, 'outro'), 'sem_resumo');
  assert.equal(L.classificarComeco('em revisão', E, 'outro'), 'outro');
  const q = new Date(2026, 10, 18, 21, 0);
  assert.equal(L.prazoEstudo(q, AGORA).texto, 'em 6 dias');
  assert.equal(L.prazoEstudo(q, new Date(2026, 10, 17, 10)).texto, 'amanhã às 21:00');
  assert.equal(L.prazoEstudo(q, new Date(2026, 10, 18, 9)).texto, 'hoje às 21:00');
  assert.equal(L.prazoEstudo(q, new Date(2026, 10, 20, 22)).texto, 'passou há 2 dias');
});

test('estudos: próximas entregas, "a confirmar", módulos por curso com resumo do Drive, pedidos e contagem do Início', () => {
  const s = montar();
  assert.equal(s.integrado, null); // sem chave: só leitura
  assert.deepEqual(s.itens, []);
  assert.deepEqual(s.proximas.map((e) => [e.titulo, e.quando, e.prazo, e.a_confirmar]),
    [['Projeto Integrador Fase 4', '2026-11-18 21:00', 'em 6 dias', false], ['Projeto Integrador Fase 3', '', 'a confirmar', true]]);
  assert.equal(s.a_confirmar, 1);
  assert.equal(s.precisa.total, 1);
  // cursos sem o caminho do Mac
  assert.deepEqual(s.cursos.map((c) => [c.curso, c.pasta_nome, c.modulos.length]),
    [['ESPEC OMEGA - Gestão Ambiental', 'ESPEC OMEGA - GESTAO AMBIENTAL', 21], ['Fotografia Digital - Iluminação (Plataforma Beta)', 'Fotografia Digital - Iluminacao- Plataforma Beta', 0], ['CURSO ARQUIVO', 'CURSO ARQUIVO', 0]]);
  assert.ok(!JSON.stringify(s).includes('/Users/'));
  assert.deepEqual(s.cursos[0].contagem, { resumido: 10, parcial: 3, sem_resumo: 8, outro: 0 });
  // linha da pasta do Mac sem resumo + linha "Google Drive" do mesmo módulo = resumido, com o caminho no Drive
  const rh = mod(s, 'MÓDULO 1 - Recursos Hídricos e Bacias');
  assert.equal(rh.situacao_final, 'resumido');
  assert.deepEqual([rh.resumo.data, rh.resumo.caminho], ['2026-11-05', 'espec_omega/resumo_fase3_modulo1_recursos_hidricos.md']);
  const ml = mod(s, 'MODULO 3 - Mudanças Climáticas');
  assert.deepEqual([ml.situacao_final, ml.resumo.caminho, ml.resumo.nota], ['parcial', 'resumo_mestre_espec_omega_2026_11_05.md', 'seção 8.3']);
  assert.equal(mod(s, 'PROJETO INTEGRADOR - ENTREGA 18-11').situacao_final, 'sem_resumo');
  assert.deepEqual(s.cursos[0].mestres.map((r) => [r.modulo, r.caminho]), [['Resumo Mestre', 'espec_omega/resumo_mestre_espec_omega_2026_11_05.md']]);
  assert.equal(s.caminhos.length, 9);
  // ordem por fase e número do módulo
  assert.deepEqual(s.cursos[0].modulos.slice(0, 4).map((x) => x.modulo.slice(0, 9)), ['Modulo 0 ', 'Modulo 1 ', 'Modulo 2 ', 'Modulo 3 ']);
  // pedidos: todos entregues no arquivo real
  assert.equal(s.pedidos_andamento.length, 0);
  assert.equal(s.pedidos_entregues.length, 2);
});

test('estudos: prova com data só do dia, pedido em andamento e entrega que já passou', () => {
  const s = montar(fontes({
    provas: 'ESPEC OMEGA,Prova Fase 4,2026-11-14,calendário,,Fase 4 módulos 1 a 3,2026-11-12,materiais/espec_omega/simulado_fase4.md\r\n',
    pedidos: '2026-11-12,Simulado da Fase 4,simulado,em andamento,\r\n',
    entregas: 'ESPEC OMEGA,Projeto Integrador Fase 2,2026-11-02 23:59,calendário,,,,\r\n'
  }));
  assert.deepEqual(s.proximas.map((e) => [e.tipo, e.titulo, e.prazo]),
    [['prova', 'Prova Fase 4', 'em 2 dias'], ['entrega', 'Projeto Integrador Fase 4', 'em 6 dias'], ['entrega', 'Projeto Integrador Fase 3', 'a confirmar']]);
  assert.equal(s.precisa.total, 2);
  assert.deepEqual(s.passadas.map((e) => [e.titulo, e.prazo]), [['Projeto Integrador Fase 2', 'passou há 10 dias']]);
  assert.deepEqual(s.pedidos_andamento.map((p) => [p.pedido, p.estado]), [['Simulado da Fase 4', 'andamento']]);
  assert.ok(s.caminhos.includes('espec_omega/simulado_fase4.md'));
});

test('estudos no servidor: lê as 5 fontes, acha os resumos na pasta de materiais e recusa qualquer decisão', () => {
  const e = ambiente(arquivosBase());
  const d = e.obterDados(true);
  const f5 = d.fontes.filter((f) => /Estudos/.test(f.rotulo));
  assert.ok(f5.length === 5 && f5.every((f) => f.ok), JSON.stringify(f5));
  const s = d.v3.estudos;
  assert.deepEqual(s.pastas, { ledger: 'EST', materiais: 'MAT' });
  // caminho com subpasta, arquivo solto (achado na subpasta) e caminho que só existe no Mac
  assert.equal(s.links['espec_omega/resumo_fase3_modulo1_recursos_hidricos.md'], '1ResumoExemplo02xxxxxxxxxxxxxxxxxxxxxx');
  assert.equal(s.links['resumo_mestre_espec_omega_2026_11_05.md'], '1ResumoExemplo01xxxxxxxxxxxxxxxxxxxxxx');
  assert.equal(s.links['RESUMOS MESTRE/resumo_mestre_espec_omega_gestao_ambiental_atualizado_2026_06_22.md'], undefined);
  assert.equal(Object.keys(s.links).length, 8);
  // o "não achou" também fica no cache: a segunda carga não varre a pasta de novo
  assert.ok(Object.keys(e.scache).some((k) => /cam_MAT_RESUMOS MESTRE/.test(k) && e.scache[k] === '-'));
  const antes = e.arquivos.DEC.texto;
  assert.throws(() => e.salvarDecisao({ modulo: 'estudos', item_id: 'modulo:FASE 4|x', decisao: 'aprovar', comentario: '', snapshot_hash: '0'.repeat(64) }), /o módulo Estudos é só leitura/);
  assert.equal(e.arquivos.DEC.texto, antes);
});
