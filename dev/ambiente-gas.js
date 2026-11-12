// Ambiente simulado do Apps Script (DriveApp, CacheService etc.) para os testes do servidor.
const fs = require('fs'), path = require('path');
const src = (n) => fs.readFileSync(path.join(__dirname, '..', 'src', n), 'utf8');
const APORTE_PLANEJADO = '2026-11-15,Reserva de emergência,Fora da ARCA,Tesouro Selic,250.00,pessoal,planejado (primeiro aporte da reserva; aguardando o usuário)\r\n';
const fx = (n) => fs.readFileSync(path.join(__dirname, '..', 'test', 'fixtures', n), 'utf8');

// Como no Drive: conteúdo mudou, data de alteração muda.
function versaoDoTexto(t) { let h = 0; for (const ch of String(t)) h = (h * 31 + ch.codePointAt(0)) % 1000003; return h; }

function ambiente(arquivos) {
  const props = {}, cache = {}, scache = {}, leituras = {}; let uuid = 0;
  const arquivo = (id) => {
    const a = arquivos[id]; if (!a) throw new Error('Arquivo não encontrado: ' + id);
    return { getId: () => id, getName: () => a.nome, isTrashed: () => false, getLastUpdated: () => new Date(a.atualizado || (Date.parse('2026-11-11T12:00:00Z') + versaoDoTexto(a.texto) * 1000)),
      getBlob: () => ({ getDataAsString: () => { leituras[id] = (leituras[id] || 0) + 1; return a.texto; } }), setContent: (t) => { a.texto = t; } };
  };
  const iter = (lista) => { let i = 0; return { hasNext: () => i < lista.length, next: () => lista[i++] }; };
  const g = {
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) },
    DriveApp: {
      getFileById: arquivo,
      getFilesByName: (n) => iter(Object.keys(arquivos).filter((id) => arquivos[id].nome === n && !arquivos[id].pasta).map(arquivo)),
      getFolderById: (fid) => ({
        getFilesByName: (n) => iter(Object.keys(arquivos).filter((id) => arquivos[id].pasta === fid && arquivos[id].nome === n).map(arquivo)),
        getFiles: () => iter(Object.keys(arquivos).filter((id) => arquivos[id].pasta === fid).map(arquivo))
      })
    },
    CacheService: { getUserCache: () => ({ get: (k) => cache[k] || null, getAll: (ks) => { const o = {}; ks.forEach((k) => { if (k in cache) o[k] = cache[k]; }); return o; }, putAll: (o) => Object.assign(cache, o), put: (k, v) => { cache[k] = v; }, remove: (k) => { delete cache[k]; } }),
      getScriptCache: () => ({ get: (k) => (k in scache ? scache[k] : null), put: (k, v) => { scache[k] = v; }, remove: (k) => { delete scache[k]; } }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    Utilities: { formatDate: (d, tz, f) => f === 'yyyy-MM-dd HH:mm:ss' ? '2026-11-11 15:00:00' : f.indexOf('yyyy-MM-dd') === 0 ? '2026-11-11T15:00:00-03:00' : '20261111-150000', getUuid: () => 'abcdef12-0000-4000-8000-' + String(++uuid).padStart(12, '0') }
  };
  const m = { exports: {} };
  const nomes = Object.keys(g);
  const corpo = src('Lib.gs') + '\n' + src('Code.gs') + '\nreturn { obterDados, salvarDecisao, PainelLib };';
  return Object.assign(new Function('module', ...nomes, corpo)(m, ...nomes.map((k) => g[k])), { arquivos, cache, scache, leituras });
}

function arquivosBase(cfgExtra) {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'painel-fontes.example.json'), 'utf8'));
  cfg.decisoes.fileId = 'DEC'; cfg.decisoes.recibos_folderId = 'RECIBOS';
  const d = cfg.modulos[0].fontes;
  d.pedidos.fileId = 'PED'; d.produtos.fileId = 'PROD'; d.ledger.folderId = 'LEDGER'; d.criativos.folderId = 'CRIAT';
  const an = cfg.modulos.find((m) => m.id === 'anuncios').fontes;
  an.ledger.folderId = 'TRAF'; an.criativos.folderId = 'CRIAT';
  const sup = cfg.modulos.find((m) => m.id === 'suporte').fontes;
  sup.ledger.folderId = 'SUP';
  cfg.modulos.find((m) => m.id === 'emails').fontes.ledger.folderId = 'EML';
  const fin = cfg.modulos.find((m) => m.id === 'financas').fontes;
  fin.ledger.folderId = 'FIN'; fin.arquivos.recebidas.folderId = 'FINREC';
  cfg.modulos.find((m) => m.id === 'investimentos').fontes.ledger.folderId = 'INV';
  Object.assign(cfg, cfgExtra || {});
  return {
    CFG: { nome: 'painel-fontes.json', texto: JSON.stringify(cfg) },
    DEC: { nome: 'decisoes.csv', texto: 'id,quando,modulo,item_id,tipo_item,versao,arte_fileId,snapshot_hash,decisao,comentario,origem\n' },
    PED: { nome: 'pedidos-de-arte.csv', texto: fx('pedidos-de-arte.csv') },
    PROD: { nome: 'produtos.csv', texto: fx('produtos.csv') },
    A: { nome: 'Artes.csv', pasta: 'LEDGER', texto: fx('Artes.csv') },
    P: { nome: 'Posts.csv', pasta: 'LEDGER', texto: fx('Posts.csv') },
    M: { nome: 'Midia.csv', pasta: 'LEDGER', texto: fx('Midia.csv') },
    C: { nome: 'Checkpoints.csv', pasta: 'LEDGER', texto: fx('Checkpoints.csv') },
    R3: { nome: 'post-P-20261109-03.md', pasta: 'CRIAT', texto: fx('post-P-20261109-03.md') },
    PL: { nome: 'plano-semana.md', pasta: 'CRIAT', texto: '# plano' },
    PL2: { nome: 'plano-teste-2026-11.md', pasta: 'CRIAT', texto: fx('anuncios/plano-teste-2026-11.md') },
    TA: { nome: 'Anuncios.csv', pasta: 'TRAF', texto: fx('anuncios/Anuncios.csv') },
    TC: { nome: 'Campanhas.csv', pasta: 'TRAF', texto: fx('anuncios/Campanhas.csv') },
    TR: { nome: 'Resultados.csv', pasta: 'TRAF', texto: fx('anuncios/Resultados.csv') },
    TE: { nome: 'Empresas.csv', pasta: 'TRAF', texto: fx('anuncios/Empresas.csv') },
    TK: { nome: 'Checkpoints.csv', pasta: 'TRAF', texto: fx('anuncios/Checkpoints.csv') },
    TU: { nome: 'Rules.csv', pasta: 'TRAF', texto: fx('anuncios/Rules.csv') },
    S1: { nome: 'Chamados.csv', pasta: 'SUP', texto: fx('suporte/Chamados.csv') },
    S2: { nome: 'Respostas.csv', pasta: 'SUP', texto: fx('suporte/Respostas.csv') },
    S3: { nome: 'Alerts.csv', pasta: 'SUP', texto: fx('suporte/Alerts.csv') },
    S4: { nome: 'Rascunhos-painel.csv', pasta: 'SUP', texto: fx('suporte/Rascunhos-painel.csv') },
    E1: { nome: 'Movimentos.csv', pasta: 'EML', texto: fx('emails/Movimentos.csv') },
    E2: { nome: 'Pendencias.csv', pasta: 'EML', texto: fx('emails/Pendencias.csv') },
    E3: { nome: 'Alerts.csv', pasta: 'EML', texto: fx('emails/Alerts.csv') },
    E4: { nome: 'Rascunhos.csv', pasta: 'EML', texto: fx('emails/Rascunhos.csv') },
    F1: { nome: 'Contas.csv', pasta: 'FIN', texto: fx('financas/Contas.csv') },
    F2: { nome: 'contas-recebidas.csv', pasta: 'FINREC', texto: fx('financas/contas-recebidas.csv') },
    F3: { nome: 'Lancamentos.csv', pasta: 'FIN', texto: fx('financas/Lancamentos.csv') },
    F4: { nome: 'Recorrentes.csv', pasta: 'FIN', texto: fx('financas/Recorrentes.csv') },
    F5: { nome: 'Rateios.csv', pasta: 'FIN', texto: fx('financas/Rateios.csv') },
    F6: { nome: 'Fechamentos.csv', pasta: 'FIN', texto: fx('financas/Fechamentos.csv') },
    F7: { nome: 'Orcamento.csv', pasta: 'FIN', texto: fx('financas/Orcamento.csv') },
    F8: { nome: 'Alerts.csv', pasta: 'FIN', texto: fx('financas/Alerts.csv') },
    I1: { nome: 'Posicoes.csv', pasta: 'INV', texto: fx('investimentos/Posicoes.csv') },
    I2: { nome: 'Precos.csv', pasta: 'INV', texto: fx('investimentos/Precos.csv') },
    I3: { nome: 'Metas_ARCA.csv', pasta: 'INV', texto: fx('investimentos/Metas_ARCA.csv') },
    I4: { nome: 'Recomendacoes.csv', pasta: 'INV', texto: fx('investimentos/Recomendacoes.csv') },
    // Linha fictícia só no ambiente de teste: o Aportes.csv real não tem aporte pendente hoje, e a tela precisa mostrar a decisão.
    I5: { nome: 'Aportes.csv', pasta: 'INV', texto: fx('investimentos/Aportes.csv') + APORTE_PLANEJADO },
    I6: { nome: 'Previdencia.csv', pasta: 'INV', texto: fx('investimentos/Previdencia.csv') },
    I7: { nome: 'Reserva.csv', pasta: 'INV', texto: fx('investimentos/Reserva.csv') },
    I8: { nome: 'Alerts.csv', pasta: 'INV', texto: fx('investimentos/Alerts.csv') }
  };
}

module.exports = { ambiente, arquivosBase, fx, APORTE_PLANEJADO };
