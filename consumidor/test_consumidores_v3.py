"""Testes dos consumidores v3 (emails, financas, investimentos). Rodar: python3 -m unittest discover -s consumidor

As decisões são geradas pelo próprio painel (src/Lib.gs + src/Code.gs em dev/ambiente-gas.js, via
gerar_decisoes_painel.js). Sem Node, os testes que dependem dele são pulados. gws simulado por FakeGws.
Só dados fictícios (fixtures de test/fixtures/).
"""

import contextlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime

AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, AQUI)
import consumidor_emails as CE  # noqa: E402
import consumidor_financas as CF  # noqa: E402
import consumidor_investimentos as CI  # noqa: E402
from test_consumidor_suporte import FakeGws, Morte  # noqa: E402

FIX = os.path.join(AQUI, "..", "test", "fixtures")
GERADOR = os.path.join(AQUI, "gerar_decisoes_painel.js")
DEC_ID, REC_ID = "DEC-FILE", "REC-FOLDER"
AGORA = lambda: datetime(2026, 11, 12, 16, 0, tzinfo=CE.TZ_SP)  # noqa: E731
APORTE_PLANEJADO = ("2026-11-15,Reserva de emergência,Fora da ARCA,Tesouro Selic,250.00,pessoal,"
                    "planejado (primeiro aporte da reserva; aguardando o usuário)\r\n")
TEM_NODE = shutil.which("node") is not None


def fx(rel):
    with open(os.path.join(FIX, rel), encoding="utf-8", newline="") as f:
        return f.read()


def painel(arquivos=None, decisoes=(), decisoes_csv=None):
    """Roda o painel de verdade (Node) e devolve decisoes.csv gravado, itens com hash e os arquivos."""
    pedido = {"arquivos": arquivos or {}, "decisoes": list(decisoes)}
    if decisoes_csv:
        pedido["decisoes_csv"] = decisoes_csv
    p = subprocess.run(["node", GERADOR], input=json.dumps(pedido), capture_output=True, text=True,
                       encoding="utf-8", timeout=120)
    if p.returncode != 0:
        raise AssertionError("gerador falhou: " + p.stderr)
    return json.loads(p.stdout)


def base_iguais():
    blocos = []
    for m in ("emails", "financas", "investimentos"):
        with open(os.path.join(AQUI, "consumidor_%s.py" % m), encoding="utf-8") as f:
            t = f.read()
        i, j = t.index("# ==================== BASE V3 (início)"), t.index("# ==================== BASE V3 (fim)")
        blocos.append(t[i:j])
    return blocos


class TestBaseComum(unittest.TestCase):
    def test_bloco_base_identico_nos_tres(self):
        b = base_iguais()
        self.assertEqual(b[0], b[1])
        self.assertEqual(b[0], b[2])

    def test_comentario_igual_ao_parse_do_painel(self):
        campos = [("data", False), ("valor", False), ("texto", False)]
        self.assertEqual(CF.parse_comentario("data=2026-11-12;valor=171.27;texto=pago no cartão; ok", campos),
                         {"data": "2026-11-12", "valor": "171.27", "texto": "pago no cartão; ok"})
        self.assertEqual(CF.parse_comentario("texto=a=b; c", campos), {"texto": "a=b; c"})
        self.assertEqual(CF.parse_comentario("", campos), {})
        self.assertEqual(CF.parse_comentario("texto=x;data=2026-11-12x", campos), {"texto": "x;data=2026-11-12x"})
        for ruim in ("data=12/11/2026", "valor=171,27", "valor=0", "valor=1;data=2026-11-12",
                     "outro=1", "sem formato"):
            with self.assertRaises(ValueError, msg=ruim):
                CF.parse_comentario(ruim, campos)
        with self.assertRaises(ValueError):
            CE.parse_comentario("texto=x", [])

    def test_tabela_round_trip_byte_a_byte(self):
        for rel in ("emails/Movimentos.csv", "emails/Pendencias.csv", "financas/Contas.csv", "financas/Rateios.csv",
                    "financas-novo/Contas.csv", "financas-novo/Rateios.csv", "investimentos/Aportes.csv"):
            t = fx(rel)
            self.assertEqual(CE.Tabela(t, rel).texto(), t, rel)


class Harness(unittest.TestCase):
    """Drive simulado com os arquivos do módulo e a config do consumidor."""
    MOD = None          # módulo python
    NOME = ""
    ARQ = {}            # chave do ambiente de teste do painel -> (config key, file id)
    EXTRA = {}          # textos que substituem os do ambiente de teste do painel

    def setUp(self):
        if not TEM_NODE:
            self.skipTest("node não instalado")
        self.tmp = tempfile.mkdtemp(prefix="consv3-test-")
        self.gws = FakeGws()
        self.base = painel(self.EXTRA)
        cfg = {"decisoes_fileId": DEC_ID, "recibos_folderId": REC_ID, "pasta_trabalho": "trabalho", "ledger_path": "ledger.json"}
        for k, (ck, fid) in self.ARQ.items():
            self.gws.add(fid, k + ".csv", self.base["arquivos"][k])
            cfg[ck] = fid
        self.cfg = os.path.join(self.tmp, "config.%s.json" % self.NOME)
        with open(self.cfg, "w", encoding="utf-8") as f:
            json.dump(cfg, f)
        self.gws.add(DEC_ID, "decisoes.csv", self.base["decisoes_csv"])

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def arquivos_atuais(self):
        a = dict(self.EXTRA)
        for k, (_, fid) in self.ARQ.items():
            a[k] = self.gws.texto(fid)
        return a

    def decidir(self, *decs):
        """Grava decisões como o painel grava, sobre os arquivos atuais do Drive simulado."""
        r = painel(self.arquivos_atuais(), [dict(d, modulo=self.NOME) for d in decs], self.gws.texto(DEC_ID))
        self.assertEqual(r["erros"], [])
        self.gws.add(DEC_ID, "decisoes.csv", r["decisoes_csv"])
        ids = [l.split(",")[0] for l in r["decisoes_csv"].splitlines()[1:]]
        return ids[-len(decs):]

    def itens_painel(self):
        return painel(self.arquivos_atuais())["itens"][self.NOME]

    def rodar(self, *args):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = self.MOD.main(["--config", self.cfg] + list(args), runner=self.gws, agora=AGORA)
        self.err = err.getvalue()
        self.json = json.loads(out.getvalue()) if out.getvalue().strip() else None
        return rc

    def ledger(self):
        with open(os.path.join(self.tmp, "ledger.json"), encoding="utf-8") as f:
            return json.load(f)["decisoes"]

    def tem_ledger(self):
        return os.path.exists(os.path.join(self.tmp, "ledger.json"))

    def modelo(self):
        c = self.MOD_CLASSE({}, None, None)
        tabs = {}
        for chave, (ck, nome, obrig, opc) in c.ARQUIVOS.items():
            k = next((k for k, (ck2, _) in self.ARQ.items() if ck2 == ck), None)
            tabs[chave] = self.MOD.Tabela(self.gws.texto(self.ARQ[k][1]), nome, obrig) if k else None
        return c.montar(tabs)

    # ---- conferências comuns

    def conferir_hash_igual_ao_painel(self):
        itens, mod = self.base["itens"][self.NOME], self.modelo()
        self.assertTrue(itens)
        for iid, it in itens.items():
            self.assertIn(iid, mod)
            self.assertEqual(mod[iid]["snapshot_hash"], it["snapshot_hash"], iid)
            self.assertEqual(mod[iid]["estado"], it["estado"], iid)

    def conferir_teste_nao_grava(self, did):
        antes = {k: self.gws.texto(fid) for k, (_, fid) in self.ARQ.items()}
        self.assertEqual(self.rodar("--teste"), 0)
        self.assertEqual(self.rodar("--confirmar", did, "--teste"), 0)
        self.assertTrue(self.json["resultado"].startswith("aplicado (teste"))
        self.assertEqual(self.gws.escritas(), 0)
        self.assertFalse(self.tem_ledger())
        self.assertEqual({k: self.gws.texto(fid) for k, (_, fid) in self.ARQ.items()}, antes)

    def conferir_ciclo(self, ids, acoes):
        self.assertEqual(self.rodar("--plano"), 0, self.err)
        self.assertEqual([a["acao"] for a in self.json["acoes"]], acoes)
        self.assertEqual([a["decision_id"] for a in self.json["acoes"]], ids)
        self.assertEqual(self.json["rejeitadas"], [])
        self.assertTrue(all(self.ledger()[d]["fase"] == "planejada" for d in ids))
        self.assertEqual(self.gws.escritas(), 0)
        for d in ids:
            self.assertEqual(self.rodar("--confirmar", d), 0, self.err)
            self.assertEqual(self.json["resultado"], "aplicado")
            self.assertEqual(self.ledger()[d]["fase"], "recibo_criado")
            self.assertEqual(self.gws.recibo(d)["resultado"], "aplicado")
        # idempotência
        n = self.gws.escritas()
        for d in ids:
            self.assertEqual(self.rodar("--confirmar", d), 0)
            self.assertEqual(self.json["resultado"], "ja_existia")
        self.assertEqual(self.rodar("--plano"), 0)
        self.assertEqual(self.json["acoes"], [])
        self.assertEqual(self.json["ja_com_recibo"], len(ids))
        self.assertEqual(self.gws.escritas(), n)

    def conferir_desatualizada(self, did, fid, de, para):
        t = self.gws.texto(fid)
        self.assertIn(de, t)
        self.gws.add(fid, "x.csv", t.replace(de, para, 1))
        self.assertEqual(self.rodar("--confirmar", did), 3)  # agente tentou confirmar sobre versão velha: nada gravado
        self.assertIn("versão desatualizada", self.err)
        self.assertEqual(self.gws.escritas(), 0)
        self.assertEqual(self.rodar("--plano"), 0)
        self.assertEqual(self.json["rejeitadas"][0]["decision_id"], did)
        self.assertEqual(self.gws.recibo(did)["resultado"], "rejeitado")
        self.assertEqual(self.gws.recibo(did)["motivo"], "versão desatualizada")
        self.assertEqual(self.rodar("--confirmar", did), 0)
        self.assertEqual(self.json["resultado"], "ja_existia")

    def conferir_auth_e_contrato(self, fid, coluna):
        self.gws.falhas["get"] = ["auth"]
        self.assertEqual(self.rodar("--plano"), 2)
        self.assertIn("AUTENTICAÇÃO", self.err)
        t = self.gws.texto(fid)
        cab = t.split("\n", 1)[0]
        self.gws.add(fid, "x.csv", t.replace(cab, cab.replace(coluna, coluna + "_x", 1), 1))
        self.assertEqual(self.rodar("--plano"), 3)
        self.assertIn(coluna, self.err)

    def conferir_retomada(self, did, fid):
        self.assertEqual(self.rodar("--plano"), 0)
        self.gws.falhas["update"] = ["morte_depois"]
        with self.assertRaises(Morte):
            self.rodar("--confirmar", did)
        self.assertEqual(self.ledger()[did]["fase"], "confirmando")
        self.assertEqual(self.gws.recibos(), [])
        depois = self.gws.texto(fid)
        self.assertEqual(self.rodar("--confirmar", did), 0)
        self.assertTrue(self.json.get("retomada"))
        self.assertEqual(self.gws.texto(fid), depois)
        self.assertEqual(self.gws.contar("update"), 1)
        self.assertEqual(self.gws.recibos(), [did + ".json"])


# ---------------------------------------------------------------- e-mails

class TestEmails(Harness):
    MOD, MOD_CLASSE, NOME = CE, CE.ConsumidorEmails, "emails"
    ARQ = {"E1": ("movimentos_fileId", "MOV-FILE"), "E2": ("pendencias_fileId", "PEND-FILE")}

    def test_hash_e_estado_iguais_ao_painel(self):
        self.conferir_hash_igual_ao_painel()

    def test_ciclo_completo_com_decisoes_do_painel(self):
        itens = self.base["itens"]["emails"]
        pends = [k for k, v in itens.items() if k.startswith("pendencia:") and v["estado"] == "aberta"]
        ids = self.decidir({"item_id": "grupo:iCloud|RN Sports", "decisao": "aprovar"},
                           {"item_id": "grupo:Google|Promoções", "decisao": "recusar", "comentario": "texto=deixar na entrada"},
                           {"item_id": pends[0], "decisao": "resolvida", "comentario": "texto=já respondi pelo celular"},
                           {"item_id": pends[1], "decisao": "pedir_rascunho", "comentario": "texto=agradecer; pedir prazo"})
        self.assertEqual(self.rodar("--plano"), 0)
        mover = self.json["acoes"][0]
        self.assertEqual((mover["conta"], mover["pasta"]), ("iCloud", "RN Sports"))
        self.assertIn("icloud:lote-2026-11-12t|RN Sports", mover["message_ids"])
        self.assertGreaterEqual(mover["emails"], 13)
        self.assertEqual(self.json["acoes"][3]["texto"], "agradecer; pedir prazo")
        self.conferir_ciclo(ids, ["mover_grupo", "recusar_grupo", "marcar_resolvida", "pedir_rascunho"])
        mov = CE.Tabela(self.gws.texto("MOV-FILE"), "m")
        estados = [o["estado"] for _, o, _ in mov.linhas() if o["conta"] == "iCloud" and o["pasta"] == "RN Sports"]
        self.assertIn("movido 2026-11-12", estados)
        self.assertTrue(any(e == "recusado 2026-11-12 (deixar na entrada)" for _, o, _ in mov.linhas()
                            for e in [o["estado"]] if o["conta"] == "Google"))
        # só as linhas decididas mudaram; o resto do arquivo ficou byte a byte
        orig = CE.dividir_registros(self.base["arquivos"]["E1"])
        novo = CE.dividir_registros(self.gws.texto("MOV-FILE"))
        self.assertEqual(len(orig), len(novo))
        mudadas = [i for i in range(len(orig)) if orig[i] != novo[i]]
        self.assertTrue(mudadas)
        # o painel lê os arquivos atualizados: grupos somem, pendência fechada sai, rascunho pedido continua aberto
        depois = self.itens_painel()
        self.assertNotIn("grupo:iCloud|RN Sports", depois)
        self.assertNotIn("grupo:Google|Promoções", depois)
        self.assertNotEqual(depois.get(pends[0], {}).get("estado"), "aberta")
        self.assertEqual(depois[pends[1]]["estado"], "aberta")
        pend = {o["message_id"]: o for _, o, _ in CE.Tabela(self.gws.texto("PEND-FILE"), "p").linhas()}
        self.assertEqual(pend[pends[0][10:]]["estado"], "fechada (já respondi pelo celular)")
        self.assertEqual(pend[pends[0][10:]]["fechado_em"], "2026-11-12")
        self.assertEqual(pend[pends[1][10:]]["rascunho"], "sim 2026-11-12")

    def test_lotes_antigos_do_mesmo_destino_ficam_substituidos(self):
        t = self.gws.texto("MOV-FILE")
        velho = "icloud:lote-2026-11-01t|RN Sports,iCloud,RN Sports,5 e-mails por regras no Mac,2026-11-01 08:00,proposto\r\n"
        self.gws.add("MOV-FILE", "m", t + velho)
        hash_antes = self.base["itens"]["emails"]["grupo:iCloud|RN Sports"]["snapshot_hash"]
        self.assertEqual(self.modelo()["grupo:iCloud|RN Sports"]["snapshot_hash"], hash_antes)  # lote velho fora do hash
        did, = self.decidir({"item_id": "grupo:iCloud|RN Sports", "decisao": "aprovar"})
        self.assertEqual(self.rodar("--plano"), 0)
        self.assertEqual(self.json["acoes"][0]["lotes_antigos"], ["icloud:lote-2026-11-01t|RN Sports"])
        self.assertEqual(self.rodar("--confirmar", did), 0)
        self.assertIn("icloud:lote-2026-11-01t|RN Sports,iCloud,RN Sports,5 e-mails por regras no Mac,2026-11-01 08:00,"
                      "substituído 2026-11-12 (lote mais novo decidido em %s)\r\n" % did, self.gws.texto("MOV-FILE"))
        self.assertNotIn("grupo:iCloud|RN Sports", self.itens_painel())

    def test_teste_nao_grava_nada(self):
        did, = self.decidir({"item_id": "grupo:iCloud|Promoções", "decisao": "aprovar"})
        self.conferir_teste_nao_grava(did)

    def test_versao_desatualizada_e_rejeitada(self):
        did, = self.decidir({"item_id": "grupo:iCloud|RN Sports", "decisao": "aprovar"})
        self.conferir_desatualizada(did, "MOV-FILE", "13 e-mails por regras no Mac", "14 e-mails por regras no Mac")

    def test_decisao_em_item_que_nao_aceita(self):
        itens = self.base["itens"]["emails"]
        p = next(k for k in itens if k.startswith("pendencia:"))
        h = itens[p]["snapshot_hash"]
        csv_ = self.gws.texto(DEC_ID) + "D-20261112-150000-0000beef,2026-11-12T15:00:00-03:00,emails,%s,pendencia,,,%s,aprovar,,painel\n" % (p, h)
        self.gws.add(DEC_ID, "d", csv_)
        self.assertEqual(self.rodar("--plano"), 0)
        self.assertEqual(self.json["rejeitadas"][0]["motivo"], "decisão desconhecida")

    def test_auth_e_contrato(self):
        self.conferir_auth_e_contrato("MOV-FILE", "proposto_em")

    def test_retomada_depois_de_cair_no_meio(self):
        did, = self.decidir({"item_id": "grupo:iCloud|Promoções", "decisao": "aprovar"})
        self.conferir_retomada(did, "MOV-FILE")


# ---------------------------------------------------------------- finanças

class FinancasComum(Harness):
    MOD, MOD_CLASSE, NOME = CF, CF.ConsumidorFinancas, "financas"
    ARQ = {"F1": ("contas_fileId", "CONTAS-FILE"), "F2": ("recebidas_fileId", "RECEB-FILE"), "F5": ("rateios_fileId", "RAT-FILE")}

    def test_hash_e_estado_iguais_ao_painel(self):
        self.conferir_hash_igual_ao_painel()

    def test_teste_nao_grava_nada(self):
        did, = self.decidir({"item_id": "conta:Energia Minas|2026-11", "decisao": "paguei"})
        self.conferir_teste_nao_grava(did)

    def test_versao_desatualizada_e_rejeitada(self):
        did, = self.decidir({"item_id": "rateio:2026-10", "decisao": "recebi_mais_um"})
        self.conferir_desatualizada(did, "RAT-FILE", ",0/3", ",1/3")

    def test_auth_e_contrato(self):
        self.conferir_auth_e_contrato("CONTAS-FILE", "vencimento")

    def test_retomada_depois_de_cair_no_meio(self):
        did, = self.decidir({"item_id": "conta:Energia Minas|2026-11", "decisao": "paguei"})
        self.conferir_retomada(did, "CONTAS-FILE")

    def test_sem_recebidas_avisa(self):
        with open(self.cfg, encoding="utf-8") as f:
            c = json.load(f)
        del c["recebidas_fileId"]
        with open(self.cfg, "w", encoding="utf-8") as f:
            json.dump(c, f)
        self.assertEqual(self.rodar("--plano", "--teste"), 0)
        self.assertTrue(any("recebidas_fileId" in a for a in self.json["avisos"]))


class TestFinancas(FinancasComum):
    def test_ciclo_completo_formato_atual(self):
        seg = "conta:Seguradora Alfa seguro Hatch (renovação 2 anos, 1ª)|2026-11"
        ids = self.decidir({"item_id": seg, "decisao": "paguei", "comentario": "data=2026-11-12;valor=171.27;texto=pago no cartão; ok"},
                           {"item_id": "conta:Energia Minas|2026-11", "decisao": "paguei"},
                           {"item_id": "rateio:2026-10", "decisao": "recebi_mais_um", "comentario": "texto=Cunhado"})
        self.assertEqual(self.rodar("--plano"), 0)
        a = self.json["acoes"]
        self.assertEqual((a[0]["data"], a[0]["valor"], a[0]["texto"]), ("2026-11-12", "171.27", "pago no cartão; ok"))
        self.assertEqual(a[1]["data"], "2026-11-11")  # sem data: dia da decisão (campo quando do painel)
        self.assertEqual((a[2]["recebidos"], a[2]["de"], a[2]["nome"]), (0, 3, "Cunhado"))
        self.conferir_ciclo(ids, ["registrar_pagamento", "registrar_pagamento", "registrar_rateio_recebido"])
        contas = CF.Tabela(self.gws.texto("CONTAS-FILE"), "c")
        m = self.modelo()
        self.assertEqual(m[seg]["estado"], "pago")
        self.assertEqual(m[seg]["estado_texto"], "pago 2026-11-12 (valor pago R$ 171,27; pago no cartão; ok)")
        self.assertEqual(m["conta:Energia Minas|2026-11"]["estado_texto"], "pago 2026-11-11")
        self.assertIn("rateio:2026-10", m)
        self.assertEqual(m["rateio:2026-10"]["recebidos_texto"], "1/3")
        self.assertTrue(contas.linhas())
        depois = self.itens_painel()
        for iid in (seg, "conta:Energia Minas|2026-11"):
            self.assertNotIn(iid, depois)  # o painel tira as pagas da lista de decisão
        self.assertEqual(depois["rateio:2026-10"]["estado"], "aberto")
        self.assertNotEqual(depois["rateio:2026-10"]["snapshot_hash"], self.base["itens"]["financas"]["rateio:2026-10"]["snapshot_hash"])


    def test_linha_com_valor_sem_aspas(self):
        """Linha quebrada pela vírgula do valor: o painel publicado faz o hash da linha crua; o consumidor aceita
        esse hash (e o da linha consertada) e regrava a linha consertada, com aspas."""
        tv = "conta:TV Estrela (minha parte 1/4)|2026-11"
        m = self.modelo()[tv]
        self.assertTrue(m["consertada"])
        self.assertEqual(m["snapshot_hash"], self.base["itens"]["financas"][tv]["snapshot_hash"])
        self.assertEqual(len(m["hashes_alternativos"]), 1)
        did, = self.decidir({"item_id": tv, "decisao": "paguei", "comentario": "data=2026-11-12"})
        self.assertEqual(self.rodar("--plano"), 0)
        self.assertEqual(self.rodar("--confirmar", did), 0, self.err)
        self.assertIn("aspas", self.gws.recibo(did)["motivo"])
        linha = self.gws.texto("CONTAS-FILE").splitlines()[1]
        self.assertTrue(linha.startswith('TV Estrela (minha parte 1/4),2026-11,"136,34",2026-11-05,boleto,'
                                         'pago 2026-11-12,'), linha)
        self.assertNotIn(tv, self.itens_painel())


    def test_hash_alternativo_da_lib_aceito(self):
        tv = "conta:TV Estrela (minha parte 1/4)|2026-11"
        alt = self.modelo()[tv]["hashes_alternativos"][0]
        csv_ = self.gws.texto(DEC_ID) + ("D-20261112-150000-0000beef,2026-11-12T15:00:00-03:00,financas,%s,conta,,,%s,paguei,,painel\n"
                                        % (tv, alt))
        self.gws.add(DEC_ID, "d", csv_)
        self.assertEqual(self.rodar("--plano"), 0)
        self.assertEqual(len(self.json["acoes"]), 1)



class TestFinancasFormatoNovo(FinancasComum):
    EXTRA = {"F1": fx("financas-novo/Contas.csv"), "F2": fx("financas-novo/contas-recebidas.csv"),
             "F3": fx("financas-novo/Lancamentos.csv"), "F5": fx("financas-novo/Rateios.csv")}

    def test_versao_desatualizada_e_rejeitada(self):
        did, = self.decidir({"item_id": "conta:Energia Minas|2026-11", "decisao": "paguei"})
        self.conferir_desatualizada(did, "CONTAS-FILE", '"309,07",2026-11-18', '"309,70",2026-11-18')

    def test_retomada_depois_de_cair_no_meio(self):
        itens = self.base["itens"]["financas"]
        conta = next(k for k, v in itens.items() if k.startswith("conta:"))
        did, = self.decidir({"item_id": conta, "decisao": "paguei"})
        self.conferir_retomada(did, "CONTAS-FILE")

    def test_teste_nao_grava_nada(self):
        itens = self.base["itens"]["financas"]
        conta = next(k for k, v in itens.items() if k.startswith("conta:"))
        did, = self.decidir({"item_id": conta, "decisao": "paguei"})
        self.conferir_teste_nao_grava(did)

    def test_ciclo_formato_novo(self):
        itens = self.base["itens"]["financas"]
        contas = [k for k in itens if k.startswith("conta:")]
        rateio = next(k for k in itens if k.startswith("rateio:"))
        ids = self.decidir({"item_id": contas[0], "decisao": "paguei", "comentario": "data=2026-11-10"},
                           {"item_id": rateio, "decisao": "recebi_mais_um", "comentario": "texto=Prima Fictícia"})
        self.conferir_ciclo(ids, ["registrar_pagamento", "registrar_rateio_recebido"])
        m = self.modelo()
        self.assertEqual(m[contas[0]]["estado"], "pago")
        tab = CF.Tabela(self.gws.texto("CONTAS-FILE"), "c")
        linha = next(o for _, o, _ in tab.linhas() if "conta:%s|%s" % (o["emissor"], o["mes_ref"]) == contas[0])
        self.assertEqual(linha["pago_em"], "2026-11-10")
        r = m[rateio]
        self.assertIn("Prima Fictícia", r["pagaram"])
        self.assertNotIn(contas[0], self.itens_painel())


    def test_hash_alternativo_da_lib_aceito(self):
        """Rateio no formato novo: o painel publicado grava o hash de 5 campos; o de 7 (Lib com cabeçalho) também vale."""
        rid = next(k for k in self.base["itens"]["financas"] if k.startswith("rateio:"))
        m = self.modelo()[rid]
        self.assertEqual(m["snapshot_hash"], self.base["itens"]["financas"][rid]["snapshot_hash"])
        csv_ = self.gws.texto(DEC_ID) + ("D-20261112-150000-0000beef,2026-11-12T15:00:00-03:00,financas,%s,rateio,,,%s,recebi_mais_um,,painel\n"
                                        % (rid, m["hashes_alternativos"][0]))
        self.gws.add(DEC_ID, "d", csv_)
        self.assertEqual(self.rodar("--plano"), 0)
        self.assertEqual([a["acao"] for a in self.json["acoes"]], ["registrar_rateio_recebido"])


del FinancasComum  # só as subclasses (formato atual e novo) rodam


# ---------------------------------------------------------------- investimentos

class TestInvestimentos(Harness):
    MOD, MOD_CLASSE, NOME = CI, CI.ConsumidorInvestimentos, "investimentos"
    ARQ = {"I5": ("aportes_fileId", "APORTES-FILE")}
    ITEM = "aporte:2026-11-15|Reserva de emergência|pessoal"

    def test_hash_e_estado_iguais_ao_painel(self):
        self.conferir_hash_igual_ao_painel()

    def test_confirmar_aporte(self):
        did, = self.decidir({"item_id": self.ITEM, "decisao": "fiz_aporte", "comentario": "data=2026-11-14;valor=300.00;texto=Tesouro Selic 2029"})
        self.assertEqual(self.rodar("--plano"), 0)
        a = self.json["acoes"][0]
        self.assertEqual((a["acao"], a["data"], a["valor"], a["valor_planejado"]), ("confirmar_aporte", "2026-11-14", "300.00", "250.00"))
        self.conferir_ciclo([did], ["confirmar_aporte"])
        t = self.gws.texto("APORTES-FILE")
        self.assertIn("2026-11-15,Reserva de emergência,Fora da ARCA,Tesouro Selic,300.00,pessoal,"
                      "confirmado 2026-11-14 (Tesouro Selic 2029)\r\n", t)
        self.assertEqual(t.replace("300.00,pessoal,confirmado 2026-11-14 (Tesouro Selic 2029)", "250.00,pessoal,planejado (primeiro aporte da reserva; aguardando o usuário)"),
                         self.base["arquivos"]["I5"])
        self.assertNotIn(self.ITEM, self.itens_painel())  # confirmado não é mais pendente

    def test_marcar_nao_feito(self):
        did, = self.decidir({"item_id": self.ITEM, "decisao": "nao_fiz", "comentario": "texto=sem saldo este mês"})
        self.conferir_ciclo([did], ["marcar_nao_feito"])
        self.assertIn(",250.00,pessoal,não fiz (sem saldo este mês)\r\n", self.gws.texto("APORTES-FILE"))
        self.assertEqual(self.modelo()[self.ITEM]["estado"], "nao_feito")
        self.assertNotIn(self.ITEM, self.itens_painel())

    def test_teste_nao_grava_nada(self):
        did, = self.decidir({"item_id": self.ITEM, "decisao": "nao_fiz"})
        self.conferir_teste_nao_grava(did)

    def test_versao_desatualizada_e_rejeitada(self):
        did, = self.decidir({"item_id": self.ITEM, "decisao": "fiz_aporte"})
        self.conferir_desatualizada(did, "APORTES-FILE", "Tesouro Selic,250.00", "Tesouro Selic,260.00")

    def test_auth_e_contrato(self):
        self.conferir_auth_e_contrato("APORTES-FILE", "valor_brl")

    def test_retomada_depois_de_cair_no_meio(self):
        did, = self.decidir({"item_id": self.ITEM, "decisao": "nao_fiz"})
        self.conferir_retomada(did, "APORTES-FILE")

    def test_colunas_extras_preservadas(self):
        t = self.gws.texto("APORTES-FILE")
        cab = t.splitlines()[0]
        novo = "\r\n".join(l + (",valor,moeda" if i == 0 else ",1,BRL") for i, l in enumerate(t.splitlines()) if l) + "\r\n"
        self.gws.add("APORTES-FILE", "a", novo)
        self.assertTrue(cab)
        m = self.modelo()
        self.assertEqual(m[self.ITEM]["snapshot_hash"], self.base["itens"]["investimentos"][self.ITEM]["snapshot_hash"])


if __name__ == "__main__":
    unittest.main()
