#!/usr/bin/env node
// Gera decisões exatamente como o painel grava (src/Lib.gs + src/Code.gs rodando em dev/ambiente-gas.js).
// Usado pelos testes Python dos consumidores v3 (test_consumidores_v3.py). Só dados fictícios das fixtures.
//
// Entrada (stdin, JSON):
//   { "arquivos": { "F1": "<texto do Contas.csv>", ... },   // opcional: substitui arquivos do ambiente de teste
//     "decisoes": [ { "modulo": "financas", "item_id": "...", "decisao": "paguei", "comentario": "" } ],
//     "decisoes_csv": "<decisoes.csv atual>" }                // opcional
// Saída (stdout, JSON):
//   { "decisoes_csv": "...", "erros": [ { "item_id", "erro" } ],
//     "itens": { "<modulo>": { "<item_id>": { "estado", "snapshot_hash", "decisao_pendente" } } },
//     "arquivos": { "E1": "...", ... } }
// A chave *_INTEGRADO é ligada só em memória, neste processo; src/ não é alterado.
const path = require('path');
const { ambiente, arquivosBase } = require(path.join(__dirname, '..', 'dev', 'ambiente-gas'));

const CHAVE = { emails: 'EMAILS_INTEGRADO', financas: 'FINANCAS_INTEGRADO', investimentos: 'INVESTIMENTOS_INTEGRADO' };

let entrada = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { entrada += c; });
process.stdin.on('end', () => {
  const pedido = JSON.parse(entrada || '{}');
  const base = arquivosBase();
  Object.entries(pedido.arquivos || {}).forEach(([k, t]) => {
    if (!base[k]) throw new Error('arquivo desconhecido no ambiente de teste: ' + k);
    base[k].texto = t;
  });
  if (pedido.decisoes_csv) base.DEC.texto = pedido.decisoes_csv;
  const e = ambiente(base);
  Object.values(CHAVE).forEach((k) => { e.PainelLib.CHAVES[k] = true; });
  const itens = () => {
    const d = e.obterDados(true), out = {};
    Object.keys(CHAVE).forEach((m) => {
      out[m] = {};
      ((d.v3 && d.v3[m] && d.v3[m].itens) || []).forEach((i) => {
        out[m][i.item_id] = { estado: i.estado, snapshot_hash: i.snapshot_hash, decisao_pendente: i.decisao_pendente ? i.decisao_pendente.decisao : null };
      });
    });
    return out;
  };
  const antes = itens(), erros = [];
  let n = 0;
  (pedido.decisoes || []).forEach((p) => {
    const it = (antes[p.modulo] || {})[p.item_id];
    if (!it) { erros.push({ item_id: p.item_id, erro: 'item não está no painel' }); return; }
    try {
      e.salvarDecisao({ modulo: p.modulo, item_id: p.item_id, decisao: p.decisao, comentario: p.comentario || '', snapshot_hash: p.snapshot_hash || it.snapshot_hash });
      // O relógio e o uuid do ambiente simulado são fixos: torna o id único sem mudar o formato D-aaaammdd-hhmmss-xxxxxxxx.
      n += 1;
      const linhas = e.arquivos.DEC.texto.split('\n');
      for (let i = linhas.length - 1; i > 0; i--) {
        if (/^D-\d{8}-\d{6}-abcdef12,/.test(linhas[i])) { linhas[i] = linhas[i].replace(/^(D-\d{8}-\d{6}-)abcdef12/, '$1' + (0xabc00000 + n).toString(16)); break; }
      }
      e.arquivos.DEC.texto = linhas.join('\n');
    } catch (err) { erros.push({ item_id: p.item_id, erro: String(err.message || err) }); }
  });
  const arquivos = {};
  Object.keys(base).forEach((k) => { if (/^(E|F|I)\d$/.test(k)) arquivos[k] = e.arquivos[k].texto; });
  process.stdout.write(JSON.stringify({ decisoes_csv: e.arquivos.DEC.texto, erros, itens: itens(), arquivos }));
});
