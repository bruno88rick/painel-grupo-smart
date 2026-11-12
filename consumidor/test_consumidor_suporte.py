"""Testes do consumidor de Suporte. Rodar: python3 -m unittest discover consumidor

gws simulado por FakeGws (Drive em memória que confere caminhos relativos ao cwd).
"""

import contextlib
import csv
import hashlib
import io
import json
import os
import re
import shutil
import sys
import tempfile
import unittest
from datetime import datetime

AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, AQUI)
import consumidor_suporte as S  # noqa: E402

FIXTURE = os.path.join(AQUI, "..", "test", "fixtures", "suporte", "Rascunhos-painel.csv")
DEC_ID, REC_ID, RASC_ID = "DEC-FILE", "REC-FOLDER", "RASC-FILE"
AGORA = lambda: datetime(2026, 11, 12, 16, 0, tzinfo=S.TZ_SP)  # noqa: E731

VETOR_CONTRATO = {
    "id_chamado": "645", "versao": "1", "evento": "2ª Trilha Runners (13/12)", "tipo": "correcao_dados",
    "cliente_primeiro_nome": "Carlos", "pedido_resumo": "Pede para corrigir a data.",
    "rascunho_texto": "Olá, Carlos!\n\nSó falta o ano.", "estado": "aguardando_aprovo",
    "zendesk_link": "https://exemplo.zendesk.com/agent/tickets/645", "prazo_evento": "2026-12-13",
    "atualizado_em": "2026-11-08T16:34-03:00",
}
HASH_CONTRATO = "dd235ce26ee191ea3e4bfe51281998d4857e85c240793b97f0f9144e2c2c5a94"
# Calculados com sha256(canonicoResposta(linha)) de src/Lib.gs sobre o fixture (conferido em Node).
VETORES_FIXTURE = {
    ("663", "1"): "50a3eb1a43865d0d9cf87862c2f440189f02de9c4c3d07401722bdc4ecd82a14",
    ("645", "1"): "6ae25c50ecee5d479fac82e7504a499fb7c225184fdbe2478bead6ab66f312b7",
    ("643", "1"): "ac7d98d1f128340a26cd837ea14777bfcba67531d1d35a85e318aa3dca5f3dab",
    ("643", "2"): "99063a5aa8d42aae32104abf4953ebcf8a5ff0a1df2aa5b85375852fa0655de5",
    ("638", "1"): "1424f6403723fbf3b912af18be186193bb8549dbf99df88e4df4ebbda5e09bb0",
    ("626", "1"): "444c3e5d5679d8d4a52f9bd72e206c3ae9c14529782142f0ddaded805dce7214",
    ("666", "1"): "5c4b92adc4f820500189f462852debd9acec8edbc0e8dc6e68ba65171a043b12",
}


class Morte(Exception):
    pass


class FakeGws:
    def __init__(self):
        self.arquivos, self.chamadas, self.seq, self.falhas = {}, [], 0, {}

    def add(self, fid, nome, conteudo, parents=()):
        self.arquivos[fid] = {"name": nome, "parents": list(parents),
                              "conteudo": conteudo if isinstance(conteudo, bytes) else conteudo.encode("utf-8")}

    def texto(self, fid):
        return self.arquivos[fid]["conteudo"].decode("utf-8")

    def recibos(self):
        return sorted(f["name"] for f in self.arquivos.values() if REC_ID in f["parents"])

    def recibo(self, did):
        for f in self.arquivos.values():
            if REC_ID in f["parents"] and f["name"] == did + ".json":
                return json.loads(f["conteudo"].decode("utf-8"))

    def contar(self, m):
        return self.chamadas.count(m)

    def escritas(self):
        return self.contar("update") + self.contar("create")

    def _caminho(self, rel, cwd):
        assert not os.path.isabs(rel), rel
        p = os.path.normpath(os.path.join(cwd, rel))
        assert p.startswith(os.path.normpath(cwd) + os.sep), rel
        return p

    def __call__(self, args, cwd):
        assert args[:2] == ["drive", "files"]
        metodo, op, i = args[2], {}, 3
        while i < len(args):
            if i + 1 < len(args) and not args[i + 1].startswith("--"):
                op[args[i]] = args[i + 1]
                i += 2
            else:
                op[args[i]] = True
                i += 1
        self.chamadas.append(metodo)
        modo = self.falhas[metodo].pop(0) if self.falhas.get(metodo) else None
        if modo == "auth":
            return 1, "", "Error: 401 Unauthorized: invalid_grant"
        if modo == "auth2":
            return 2, "", "Error de autenticación: {}"
        if modo == "erro":
            return 5, "", "error: HTTP request failed"
        if modo == "morte_antes":
            raise Morte()
        params = json.loads(op.get("--params", "{}"))
        if metodo == "get":
            f = self.arquivos.get(params["fileId"])
            if not f:
                return 1, "", "404 notFound"
            if params.get("alt") == "media":
                with open(self._caminho(op["--output"], cwd), "wb") as h:
                    h.write(f["conteudo"])
                return 0, "{}", ""
            return 0, json.dumps({"id": params["fileId"], "md5Checksum": hashlib.md5(f["conteudo"]).hexdigest()}), ""
        if metodo == "list":
            m = re.match(r"^'([^']+)' in parents and trashed=false(?: and name='(.*)')?$", params["q"])
            fs = [{"id": k, "name": v["name"]} for k, v in self.arquivos.items()
                  if m.group(1) in v["parents"] and (m.group(2) is None or v["name"] == m.group(2))]
            return 0, json.dumps({"files": fs}) + "\n", ""
        if metodo == "update":
            with open(self._caminho(op["--upload"], cwd), "rb") as h:
                self.arquivos[params["fileId"]]["conteudo"] = h.read()
            if modo == "morte_depois":
                raise Morte()
            return 0, "{}", ""
        if metodo == "create":
            corpo = json.loads(op["--json"])
            with open(self._caminho(op["--upload"], cwd), "rb") as h:
                dados = h.read()
            self.seq += 1
            self.add("novo-%d" % self.seq, corpo["name"], dados, corpo["parents"])
            if modo == "ambiguo":
                return 5, "", "error: HTTP request failed"
            return 0, "{}", ""
        raise AssertionError(metodo)


def ler_fixture():
    with open(FIXTURE, encoding="utf-8", newline="") as f:
        return f.read()


def linha_fixture(idc, versao):
    R = S.Rascunhos(ler_fixture())
    return R.da_versao(idc, versao)[1]


def dec(did, idc, versao, decisao, comentario="", hash_=None, modulo="suporte"):
    return {"id": did, "quando": "2026-11-12T15:00:00-03:00", "modulo": modulo, "item_id": "resposta:" + idc,
            "tipo_item": "resposta", "versao": versao, "arte_fileId": "",
            "snapshot_hash": hash_ or VETORES_FIXTURE[(idc, versao)], "decisao": decisao,
            "comentario": comentario, "origem": "painel"}


def csv_decisoes(decs):
    buf = io.StringIO(newline="")
    w = csv.writer(buf, lineterminator="\r\n")
    w.writerow(S.CABECALHO_DECISOES)
    for d in decs:
        w.writerow([d.get(c, "") for c in S.CABECALHO_DECISOES])
    return buf.getvalue()


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="consup-test-")
        self.gws = FakeGws()
        self.gws.add(RASC_ID, "Rascunhos-painel.csv", ler_fixture())
        self.cfg = os.path.join(self.tmp, "config.suporte.json")
        with open(self.cfg, "w", encoding="utf-8") as f:
            json.dump({"decisoes_fileId": DEC_ID, "recibos_folderId": REC_ID, "rascunhos_fileId": RASC_ID,
                       "pasta_trabalho": "trabalho", "ledger_path": "ledger.json"}, f)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def decisoes(self, *decs):
        self.gws.add(DEC_ID, "decisoes.csv", csv_decisoes(decs))

    def rodar(self, *args):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = S.main(["--config", self.cfg] + list(args), runner=self.gws, agora=AGORA)
        self.err = err.getvalue()
        self.json = json.loads(out.getvalue()) if out.getvalue().strip() else None
        return rc

    def ledger(self):
        with open(os.path.join(self.tmp, "ledger.json"), encoding="utf-8") as f:
            return json.load(f)["decisoes"]

    def tem_ledger(self):
        return os.path.exists(os.path.join(self.tmp, "ledger.json"))

    def rasc(self):
        return S.Rascunhos(self.gws.texto(RASC_ID))

    def intacto_exceto(self, *indices):
        orig = S.dividir_registros(ler_fixture())
        novo = S.dividir_registros(self.gws.texto(RASC_ID))
        for i, a in enumerate(orig):
            if i not in indices:
                self.assertEqual(a, novo[i])
        return novo


class TestHash(unittest.TestCase):
    def test_vetor_do_contrato(self):
        esperado = SEP_JOIN = "\u001f".join(["resposta", "645", "1", "2ª Trilha Runners (13/12)", "correcao_dados", "Carlos",
                                            "Pede para corrigir a data.", "Olá, Carlos!\n\nSó falta o ano.",
                                            "aguardando_aprovo", "https://exemplo.zendesk.com/agent/tickets/645",
                                            "2026-12-13"])
        self.assertEqual(S.canonico_resposta(VETOR_CONTRATO), SEP_JOIN)
        self.assertEqual(S.canonico_resposta(dict(VETOR_CONTRATO, atualizado_em="x")), esperado)
        self.assertEqual(S.hash_resposta(VETOR_CONTRATO), HASH_CONTRATO)
        crlf = dict(VETOR_CONTRATO, rascunho_texto="  Olá, Carlos!\r\n\r\nSó falta o ano.\r\n")
        self.assertEqual(S.hash_resposta(crlf), HASH_CONTRATO)
        self.assertNotEqual(S.hash_resposta(dict(VETOR_CONTRATO, rascunho_texto="outro")), HASH_CONTRATO)

    def test_vetores_do_fixture_iguais_ao_lib(self):
        R = S.Rascunhos(ler_fixture())
        for (idc, v), h in VETORES_FIXTURE.items():
            self.assertEqual(S.hash_resposta(R.da_versao(idc, v)[1]), h, (idc, v))
        self.assertEqual(R.ultima("643")[1]["versao"], "2")

    def test_round_trip_byte_a_byte(self):
        t = ler_fixture()
        R = S.Rascunhos(t)
        self.assertEqual(R.texto(), t)
        for r in R.regs:
            corpo, term = S.separar_terminador(r)
            self.assertEqual(S.escrever_registro(S.ler_registro(r), term), r)

    def test_estado_e_comentario(self):
        self.assertEqual(S.classificar_estado("Aguardando aprovo (lembrete enviado)"), "aguardando_aprovo")
        self.assertEqual(S.classificar_estado("Enviado em 2026-11-12"), "enviado")
        self.assertEqual(S.parse_comentario("texto=trocar o prazo; manter=o resto", "refazer"),
                         {"texto": "trocar o prazo; manter=o resto"})
        self.assertEqual(S.parse_comentario("texto=linha 1\nlinha 2", "recusar"), {"texto": "linha 1 linha 2"})
        self.assertEqual(S.parse_comentario("", "aprovar"), {})
        self.assertEqual(S.parse_comentario("", "recusar"), {})
        for c, d in (("", "refazer"), ("texto=", "refazer"), ("texto=x", "aprovar"), ("valor=10", "recusar"),
                     ("sem formato", "refazer"), ("texto=" + "x" * 1501, "refazer")):
            with self.assertRaises(ValueError):
                S.parse_comentario(c, d)


class TestPlano(Base):
    def test_plano_lista_acoes_sem_gravar_no_drive(self):
        self.decisoes(dec("D-1", "645", "1", "aprovar"), dec("D-2", "643", "2", "refazer", "texto=citar o prazo; ok"),
                      dec("D-3", "638", "1", "recusar"), dec("D-X", "645", "1", "aprovar", modulo="anuncios"))
        self.assertEqual(self.rodar("--plano"), 0)
        a = {x["decision_id"]: x for x in self.json["acoes"]}
        self.assertEqual(sorted(a), ["D-1", "D-2", "D-3"])
        self.assertEqual(a["D-1"]["acao"], "enviar_resposta")
        self.assertEqual(a["D-1"]["id_chamado"], "645")
        self.assertEqual(a["D-1"]["versao"], "1")
        self.assertEqual(a["D-1"]["texto"], linha_fixture("645", "1")["rascunho_texto"])
        self.assertTrue(a["D-1"]["texto"].startswith("Olá, Carlos!\n\nConseguimos corrigir"))
        self.assertEqual((a["D-2"]["acao"], a["D-2"]["texto"], a["D-2"]["versao"]), ("refazer", "citar o prazo; ok", "2"))
        self.assertEqual((a["D-3"]["acao"], a["D-3"]["motivo"]), ("recusar", "recusado pelo Bruno"))
        self.assertEqual(self.gws.escritas(), 0)
        self.assertEqual(self.gws.texto(RASC_ID), ler_fixture())
        self.assertEqual(self.ledger()["D-1"]["fase"], "planejada")
        # rodar de novo: mesma lista, marcada como já planejada
        self.rodar("--plano")
        self.assertTrue(all(x.get("ja_planejada") for x in self.json["acoes"]))

    def test_hash_divergente_rejeitado(self):
        self.decisoes(dec("D-1", "645", "1", "aprovar", hash_="a" * 64),
                      dec("D-2", "643", "1", "aprovar"))  # versão 1 já foi substituída pela 2
        self.assertEqual(self.rodar("--plano"), 0)
        self.assertEqual(self.json["acoes"], [])
        for did in ("D-1", "D-2"):
            r = self.gws.recibo(did)
            self.assertEqual((r["resultado"], r["motivo"]), ("rejeitado", "versão desatualizada"))
            self.assertEqual(r["agente"], "Agente de Suporte RN Sports")
            self.assertEqual(self.ledger()[did]["fase"], "recibo_criado")
        self.assertEqual(self.gws.contar("update"), 0)
        self.assertEqual(self.gws.texto(RASC_ID), ler_fixture())

    def test_estado_comentario_e_duplicada(self):
        self.decisoes(dec("D-1", "666", "1", "aprovar"), dec("D-2", "626", "1", "refazer"),
                      dec("D-3", "663", "1", "aprovar"), dec("D-4", "663", "1", "recusar"))
        self.rodar("--plano")
        self.assertIn("não aceita", self.gws.recibo("D-1")["motivo"])
        self.assertIn("comentario inválido", self.gws.recibo("D-2")["motivo"])
        self.assertEqual([x["decision_id"] for x in self.json["acoes"]], ["D-3"])
        self.assertIn("duplicada", self.gws.recibo("D-4")["motivo"])

    def test_recibo_duplicado_nao_refaz(self):
        self.decisoes(dec("D-1", "645", "1", "aprovar"))
        self.gws.add("r1", "D-1.json", "{}", [REC_ID])
        self.gws.add("r2", "D-1.json", "{}", [REC_ID])
        self.assertEqual(self.rodar("--plano"), 0)
        self.assertEqual(self.json["acoes"], [])
        self.assertEqual(self.json["ja_com_recibo"], 1)
        self.assertIn("recibo duplicado", self.err)
        self.assertEqual(self.rodar("--confirmar", "D-1", "https://exemplo.zendesk.com/agent/tickets/645"), 0)
        self.assertEqual(self.json["resultado"], "ja_existia")
        self.assertEqual(self.gws.escritas(), 0)

    def test_teste_sem_escrita(self):
        self.decisoes(dec("D-1", "645", "1", "aprovar"), dec("D-2", "638", "1", "aprovar", hash_="b" * 64))
        self.assertEqual(self.rodar("--teste"), 0)  # sozinho = plano
        self.assertEqual(self.json["modo"], "plano")
        self.assertEqual([x["decision_id"] for x in self.json["acoes"]], ["D-1"])
        self.assertEqual(self.json["rejeitadas"][0]["motivo"], "versão desatualizada")
        self.assertEqual(self.rodar("--confirmar", "D-1", "https://exemplo.zendesk.com/agent/tickets/645", "--teste"), 0)
        self.assertTrue(self.json["resultado"].startswith("aplicado (teste"))
        self.assertTrue(self.json["estado_novo"].startswith("enviado"))
        self.assertEqual(self.gws.escritas(), 0)
        self.assertFalse(self.tem_ledger())
        self.assertEqual(self.gws.texto(RASC_ID), ler_fixture())

    def test_auth_falha_para(self):
        self.decisoes(dec("D-1", "645", "1", "aprovar", hash_="c" * 64))
        self.gws.falhas["get"] = ["auth"]
        self.assertEqual(self.rodar("--plano"), 2)
        self.assertIn("AUTENTICAÇÃO", self.err)
        self.gws.falhas["list"] = ["auth2"]
        self.assertEqual(self.rodar("--plano"), 2)
        self.assertEqual(self.gws.escritas(), 0)
        self.assertEqual(self.gws.recibos(), [])


class TestConfirmar(Base):
    LINK = "https://exemplo.zendesk.com/agent/tickets/645"

    def test_confirmar_aprovar(self):
        self.decisoes(dec("D-1", "645", "1", "aprovar"))
        self.rodar("--plano")
        self.assertEqual(self.rodar("--confirmar", "D-1", self.LINK), 0)
        self.assertEqual(self.json["resultado"], "aplicado")
        l = self.rasc().da_versao("645", "1")[1]
        self.assertEqual(l["estado"], "enviado em 2026-11-12 16:00")
        self.assertEqual(l["atualizado_em"], "2026-11-12T16:00:00-03:00")
        self.assertEqual(l["rascunho_texto"], linha_fixture("645", "1")["rascunho_texto"])
        self.intacto_exceto(2)
        r = self.gws.recibo("D-1")
        self.assertEqual(r, {"decision_id": "D-1", "snapshot_hash": VETORES_FIXTURE[("645", "1")], "resultado": "aplicado",
                             "motivo": "resposta enviada no chamado 645", "processado_em": "2026-11-12T16:00:00-03:00",
                             "agente": "Agente de Suporte RN Sports", "link": self.LINK})
        fases = [h["fase"] for h in self.ledger()["D-1"]["historico"]]
        self.assertEqual(fases, ["planejada", "confirmando", "rascunho_atualizado", "recibo_criado"])
        # repetir não refaz
        self.assertEqual(self.rodar("--confirmar", "D-1", self.LINK), 0)
        self.assertEqual(self.json["resultado"], "ja_existia")
        self.assertEqual(self.gws.contar("update"), 1)
        self.assertEqual(self.gws.recibos(), ["D-1.json"])

    def test_confirmar_refazer_com_novo_texto(self):
        self.decisoes(dec("D-1", "643", "2", "refazer", "texto=citar o prazo"))
        novo = os.path.join(self.tmp, "novo.txt")
        with open(novo, "w", encoding="utf-8") as f:
            f.write("Olá, Ana!\n\nNovo texto.\n")
        self.assertEqual(self.rodar("--confirmar", "D-1", "", "--novo-texto", novo), 0)
        R = self.rasc()
        self.assertTrue(R.da_versao("643", "2")[1]["estado"].startswith("ajuste pedido em 2026-11-12 16:00: citar o prazo"))
        v3 = R.ultima("643")[1]
        self.assertEqual((v3["versao"], v3["estado"], v3["rascunho_texto"]), ("3", "aguardando_aprovo", "Olá, Ana!\n\nNovo texto."))
        self.assertTrue(self.gws.texto(RASC_ID).endswith("\r\n"))
        self.assertNotIn("link", self.gws.recibo("D-1"))

    def test_confirmar_recusar(self):
        self.decisoes(dec("D-1", "638", "1", "recusar", "texto=sem parceria agora"))
        self.assertEqual(self.rodar("--confirmar", "D-1", ""), 0)
        self.assertEqual(self.rasc().ultima("638")[1]["estado"], "recusado em 2026-11-12 16:00: sem parceria agora")
        self.assertIn("recusada pelo Bruno", self.gws.recibo("D-1")["motivo"])

    def test_confirmar_hash_divergente_nao_grava(self):
        self.decisoes(dec("D-1", "645", "1", "aprovar", hash_="d" * 64))
        self.assertEqual(self.rodar("--confirmar", "D-1", self.LINK), 3)
        self.assertIn("versão desatualizada", self.err)
        self.assertEqual(self.gws.escritas(), 0)

    def test_confirmar_aprovar_exige_link(self):
        self.decisoes(dec("D-1", "645", "1", "aprovar"))
        self.assertEqual(self.rodar("--confirmar", "D-1", ""), 3)
        self.assertEqual(self.rodar("--confirmar", "D-1", "zendesk 645"), 3)
        self.assertEqual(self.gws.escritas(), 0)

    def test_create_ambiguo_recibo_existe(self):
        self.decisoes(dec("D-1", "645", "1", "aprovar"))
        self.gws.falhas["create"] = ["ambiguo"]
        self.assertEqual(self.rodar("--confirmar", "D-1", self.LINK), 0)
        self.assertEqual(self.json["resultado"], "aplicado")
        self.assertEqual(self.gws.recibos(), ["D-1.json"])
        self.assertEqual(self.gws.contar("create"), 1)
        self.assertEqual(self.ledger()["D-1"]["fase"], "recibo_criado")

    def test_create_falhou_sem_recibo_e_retomada(self):
        self.decisoes(dec("D-1", "645", "1", "aprovar"))
        self.gws.falhas["create"] = ["erro"]
        self.assertEqual(self.rodar("--confirmar", "D-1", self.LINK), 1)
        self.assertEqual(self.gws.recibos(), [])
        self.assertEqual(self.ledger()["D-1"]["fase"], "rascunho_atualizado")
        self.assertEqual(self.rodar("--confirmar", "D-1", self.LINK), 0)
        self.assertTrue(self.json.get("retomada"))
        self.assertEqual(self.gws.recibos(), ["D-1.json"])
        self.assertEqual(self.gws.contar("update"), 1)

    def test_retomada_quando_update_chegou_mas_ledger_nao(self):
        self.decisoes(dec("D-1", "645", "1", "aprovar"))
        self.gws.falhas["update"] = ["morte_depois"]
        with self.assertRaises(Morte):
            self.rodar("--confirmar", "D-1", self.LINK)
        self.assertEqual(self.ledger()["D-1"]["fase"], "confirmando")
        self.assertEqual(self.rodar("--confirmar", "D-1", self.LINK), 0)
        self.assertEqual(self.gws.contar("update"), 1)
        self.assertEqual(self.gws.recibo("D-1")["resultado"], "aplicado")

    def test_auth_falha_no_update(self):
        self.decisoes(dec("D-1", "645", "1", "aprovar"))
        self.gws.falhas["update"] = ["auth"]
        self.assertEqual(self.rodar("--confirmar", "D-1", self.LINK), 2)
        self.assertEqual(self.gws.contar("create"), 0)
        self.assertEqual(self.gws.texto(RASC_ID), ler_fixture())

    def test_rascunhos_mudou_no_drive(self):
        self.decisoes(dec("D-1", "645", "1", "aprovar"))
        orig = FakeGws.__call__

        def chamada(self_, args, cwd):
            if args[2] == "get" and "md5Checksum" in args[4]:
                self_.arquivos[RASC_ID]["conteudo"] += b"x"
            return orig(self_, args, cwd)
        FakeGws.__call__ = chamada
        try:
            self.assertEqual(self.rodar("--confirmar", "D-1", self.LINK), 1)
        finally:
            FakeGws.__call__ = orig
        self.assertEqual(self.gws.escritas(), 0)

    def test_arquivo_com_lf_preservado(self):
        self.gws.add(RASC_ID, "Rascunhos-painel.csv", ler_fixture().replace("\r\n", "\n"))
        self.decisoes(dec("D-1", "645", "1", "aprovar"))
        self.assertEqual(self.rodar("--confirmar", "D-1", self.LINK), 0)
        self.assertNotIn("\r", self.gws.texto(RASC_ID))


if __name__ == "__main__":
    unittest.main()
