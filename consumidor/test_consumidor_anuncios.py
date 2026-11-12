"""Testes do consumidor de anúncios (--plano, --confirmar, --teste). Rodar: python3 -m unittest discover -s consumidor

O gws é simulado por FakeGws: um Drive em memória que entende os mesmos
comandos que a camada Drive usa (get/list/update/create) e confere que
--output/--upload são caminhos relativos dentro do cwd.
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
import consumidor_anuncios as C  # noqa: E402

FIXTURE = os.path.join(AQUI, "..", "test", "fixtures", "anuncios", "Propostas.csv")
DEC_ID, REC_ID, PROP_ID = "DEC-FILE", "REC-FOLDER", "PROP-FILE"
AGORA = lambda: datetime(2026, 11, 12, 15, 0, tzinfo=C.TZ_SP)  # noqa: E731

VETORES = {
    "P-20261111-01": "607f35ce898e949de9408f739e5b049b9ef984b67a6c0bc46dc7927ee17a6502",
    "P-20261112-CAT": "86cada420b41ff4707640d9a70763d5c8f35667919d43201060594c2b1da6b00",
    "C02": "8ed605d1139b49e8e40f52a1489e2e05bc852ed588cbd375a9511bc9e6c30ac3",
    "M-52562345108818": "fd52e27553dbcc2bdf543f01b409a4cadcb03a57fb155ac30c90413edb1f5ab4",
}


class Morte(Exception):
    """Simula o processo morrendo no meio de um comando."""


class FakeGws:
    def __init__(self):
        self.arquivos = {}  # id -> {"name", "parents", "conteudo": bytes}
        self.chamadas = []
        self.seq = 0
        self.falhas = {}  # metodo -> lista de modos: "auth", "erro", "ambiguo", "morte_depois", "morte_antes"

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
        return None

    def contar(self, metodo):
        return sum(1 for c in self.chamadas if c == metodo)

    def _caminho(self, rel, cwd):
        assert not os.path.isabs(rel), "caminho absoluto no gws: %s" % rel
        p = os.path.normpath(os.path.join(cwd, rel))
        assert p.startswith(os.path.normpath(cwd) + os.sep), "fora do cwd: %s" % rel
        return p

    def __call__(self, args, cwd):
        assert args[:2] == ["drive", "files"], args
        metodo = args[2]
        op = {}
        i = 3
        while i < len(args):
            op[args[i]] = args[i + 1] if i + 1 < len(args) and not args[i + 1].startswith("--") else True
            i += 2 if op[args[i]] is not True else 1
        self.chamadas.append(metodo)
        modo = (self.falhas.get(metodo) or [None]).pop(0) if self.falhas.get(metodo) else None
        if modo == "auth":
            return 1, "", "Error: 401 Unauthorized: invalid_grant"
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
                return 0, json.dumps({"saved": op["--output"]}), ""
            return 0, json.dumps({"id": params["fileId"], "md5Checksum": hashlib.md5(f["conteudo"]).hexdigest()}), ""
        if metodo == "list":
            m = re.match(r"^'([^']+)' in parents and trashed=false(?: and name='(.*)')?$", params["q"])
            pasta, nome = m.group(1), m.group(2)
            fs = [{"id": k, "name": v["name"]} for k, v in self.arquivos.items()
                  if pasta in v["parents"] and (nome is None or v["name"] == nome)]
            return 0, json.dumps({"files": fs}) + "\n", ""
        if metodo == "update":
            with open(self._caminho(op["--upload"], cwd), "rb") as h:
                self.arquivos[params["fileId"]]["conteudo"] = h.read()
            if modo == "morte_depois":
                raise Morte()
            return 0, json.dumps({"id": params["fileId"]}), ""
        if metodo == "create":
            corpo = json.loads(op["--json"])
            with open(self._caminho(op["--upload"], cwd), "rb") as h:
                dados = h.read()
            self.seq += 1
            self.add("novo-%d" % self.seq, corpo["name"], dados, corpo["parents"])
            if modo == "ambiguo":
                return 5, "", "error: HTTP request failed"
            if modo == "morte_depois":
                raise Morte()
            return 0, json.dumps({"id": "novo-%d" % self.seq}), ""
        raise AssertionError("método inesperado %s" % metodo)


def ler_fixture():
    with open(FIXTURE, encoding="utf-8", newline="") as f:
        return f.read()


def linhas_fixture():
    P = C.Propostas(ler_fixture())
    return {i: P.buscar(i)[0] for i in VETORES}


def csv_decisoes(decs):
    buf = io.StringIO(newline="")
    w = csv.writer(buf, lineterminator="\r\n")
    w.writerow(C.CABECALHO_DECISOES)
    for d in decs:
        w.writerow([d.get(c, "") for c in C.CABECALHO_DECISOES])
    return buf.getvalue()


def dec(did, item, decisao, comentario="", hash_=None, versao=None, modulo="anuncios"):
    tipo, pid = item.split(":", 1)
    linha = linhas_fixture()[pid]
    return {"id": did, "quando": "2026-11-12T14:00:00-03:00", "modulo": modulo, "item_id": item, "tipo_item": tipo,
            "versao": versao or linha["versao"], "arte_fileId": linha["midia_fileIds"] if tipo == "post" else "",
            "snapshot_hash": hash_ or C.hash_snapshot(linha), "decisao": decisao, "comentario": comentario, "origem": "painel"}


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="consumidor-test-")
        self.gws = FakeGws()
        self.gws.add(PROP_ID, "Propostas.csv", ler_fixture())
        self.cfg_path = os.path.join(self.tmp, "config.json")
        self.escrever_config(PROP_ID)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def escrever_config(self, prop):
        with open(self.cfg_path, "w", encoding="utf-8") as f:
            json.dump({"decisoes_fileId": DEC_ID, "recibos_folderId": REC_ID, "propostas_fileId": prop,
                       "pasta_trabalho": "trabalho", "ledger_path": "ledger.json"}, f)

    def decisoes(self, *decs):
        self.gws.add(DEC_ID, "decisoes.csv", csv_decisoes(decs))

    def rodar(self, *extra):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = C.main(["--config", self.cfg_path] + list(extra), runner=self.gws, agora=AGORA)
        self.saida = out.getvalue() + err.getvalue()
        self.stderr = err.getvalue()
        try:
            self.res = json.loads(out.getvalue()) if out.getvalue().strip() else None
        except ValueError:
            self.res = None
        return rc

    def plano(self, *extra):
        return self.rodar("--plano", *extra)

    def confirmar(self, did, *extra):
        return self.rodar("--confirmar", did, *extra)

    def linha(self, pid):
        return C.Propostas(self.gws.texto(PROP_ID)).buscar(pid)[0]

    def ledger(self):
        with open(os.path.join(self.tmp, "ledger.json"), encoding="utf-8") as f:
            return json.load(f)["decisoes"]

    def tem_ledger(self):
        return os.path.exists(os.path.join(self.tmp, "ledger.json"))

    def escrever_ledger(self, decisoes):
        with open(os.path.join(self.tmp, "ledger.json"), "w", encoding="utf-8") as f:
            json.dump({"versao": 1, "decisoes": decisoes}, f)

    def outras_linhas_intactas(self, pid):
        orig = C.dividir_registros(ler_fixture())
        novo = C.dividir_registros(self.gws.texto(PROP_ID))
        self.assertEqual(len(orig), len(novo))
        for a, b in zip(orig, novo):
            if C.ler_registro(a)[0] != pid:
                self.assertEqual(a, b)
            else:
                self.assertTrue(b.endswith("\r\n"))


class TestHashVetores(unittest.TestCase):
    def test_vetores_fixos_e_arquivo(self):
        calc = {i: C.hash_snapshot(l) for i, l in linhas_fixture().items()}
        for i, h in calc.items():
            print("vetor %s %s" % (i, h))
        self.assertEqual(calc, VETORES)
        with open(os.path.join(AQUI, "vetores_hash.json"), "w", encoding="utf-8") as f:
            json.dump(calc, f, indent=2)
            f.write("\n")

    def test_canonico_normaliza(self):
        l = dict(linhas_fixture()["P-20261111-01"])
        self.assertIn("\n\n", C.canonico_post(l))
        l2 = dict(l, legenda_1="  " + l["legenda_1"].replace("\n", "\r\n") + "\r\n ")
        self.assertEqual(C.hash_snapshot(l2), VETORES["P-20261111-01"])
        self.assertTrue(C.canonico_campanha(linhas_fixture()["C02"]).startswith("campanha\u001fC02\u001f1\u001f10\u001f"))

    def test_trim_igual_js(self):
        self.assertEqual(C.normalizar("\u001fa\u001f"), "\u001fa\u001f")  # str.strip() removeria
        self.assertEqual(C.normalizar("\ufeff a \u00a0"), "a")

    def test_csv_round_trip_byte_a_byte(self):
        t = ler_fixture()
        P = C.Propostas(t)
        self.assertEqual(P.texto(), t)
        for r in P.regs:
            corpo, term = C._separar_terminador(r)
            self.assertEqual(term, "\r\n")
            self.assertEqual(C.escrever_registro(C.ler_registro(r), term), r)


class TestComentario(unittest.TestCase):
    def ok(self, s, t, d):
        return C.parse_comentario(s, t, d)

    def ruim(self, s, t, d):
        with self.assertRaises(ValueError):
            C.parse_comentario(s, t, d)

    def test_validos(self):
        self.assertEqual(self.ok("legenda=1;horario=2026-11-13 18:30;texto=usar a foto 2", "post", "aprovar"),
                         {"legenda": "1", "horario": "2026-11-13 18:30", "texto": "usar a foto 2"})
        self.assertEqual(self.ok("verba=8", "campanha", "aprovar"), {"verba": "8"})
        self.assertEqual(self.ok("texto=trocar o público", "campanha", "refazer"), {"texto": "trocar o público"})
        self.assertEqual(self.ok("texto=a;b=c\nd", "post", "refazer"), {"texto": "a;b=c d"})
        self.assertEqual(self.ok("", "post", "recusar"), {})
        self.assertEqual(self.ok("", "campanha", "pausar"), {})
        self.assertEqual(self.ok("verba=8.5;texto=", "campanha", "aprovar"), {"verba": "8.5", "texto": ""})

    def test_invalidos(self):
        self.ruim("", "post", "aprovar")
        self.ruim("legenda=3", "post", "aprovar")
        self.ruim("horario=2026-11-13 18:30;legenda=1", "post", "aprovar")
        self.ruim("legenda=1;legenda=2", "post", "aprovar")
        self.ruim("legenda=1;horario=2026-13-40 18:30", "post", "aprovar")
        self.ruim("legenda=1;horario=13/11 18h", "post", "aprovar")
        self.ruim("legenda=1;", "post", "aprovar")
        self.ruim("legenda=1; texto=x", "post", "aprovar")
        self.ruim("trocar a foto", "post", "refazer")
        self.ruim("texto=", "post", "refazer")
        self.ruim("legenda=1;texto=x", "post", "refazer")
        self.ruim("verba=8", "post", "aprovar")
        self.ruim("verba=0", "campanha", "aprovar")
        self.ruim("verba=8,5", "campanha", "aprovar")
        self.ruim("verba=-1", "campanha", "aprovar")
        self.ruim("legenda=1", "campanha", "aprovar")
        self.ruim("texto=x", "post", "pausar")


class TestPlano(Base):
    def test_plano_lista_acoes_sem_recibo_nem_update(self):
        self.decisoes(dec("D-1", "post:P-20261111-01", "aprovar", "legenda=1;texto=ok"),
                      dec("D-2", "campanha:C02", "aprovar", "verba=8.50;texto=começar menor"),
                      dec("D-3", "campanha:M-52562345108818", "pausar", "texto=gasto sem retorno"))
        self.assertEqual(self.plano(), 0)
        self.assertEqual(self.gws.contar("update") + self.gws.contar("create"), 0)
        self.assertEqual(self.gws.texto(PROP_ID), ler_fixture())
        self.assertEqual(self.gws.recibos(), [])
        self.assertEqual(self.res["modo"], "plano")
        a = {x["decision_id"]: x for x in self.res["acoes"]}
        self.assertEqual(a["D-1"]["acao"], "programar_post")
        self.assertTrue(a["D-1"]["legenda"].startswith("Mesa posta de Natal"))
        self.assertEqual(a["D-1"]["snapshot_hash"], VETORES["P-20261111-01"])
        self.assertEqual((a["D-2"]["acao"], a["D-2"]["verba_diaria"], a["D-2"]["versao"]), ("criar_campanha", "8.5", "2"))
        self.assertEqual((a["D-3"]["acao"], a["D-3"]["campanha_id"]), ("pausar_campanha_meta", "M-52562345108818"))
        led = self.ledger()
        self.assertEqual({k: v["fase"] for k, v in led.items()}, {"D-1": "planejada", "D-2": "planejada", "D-3": "planejada"})
        # segunda vez: mesmas ações, marcadas como já planejadas, ledger não cresce
        self.assertEqual(self.plano(), 0)
        self.assertTrue(all(x.get("ja_planejada") for x in self.res["acoes"]))
        self.assertEqual(len(self.ledger()["D-1"]["historico"]), 1)

    def test_sem_flag_e_plano(self):
        self.decisoes(dec("D-1", "campanha:C02", "aprovar"))
        self.assertEqual(self.rodar(), 0)
        self.assertEqual(self.res["modo"], "plano")
        self.assertEqual(self.gws.recibos(), [])

    def test_carrossel_10_midias_legenda_2_novo_horario(self):
        self.decisoes(dec("D-1", "post:P-20261112-CAT", "aprovar", "legenda=2;horario=2026-11-16 19:00"))
        self.plano()
        a = self.res["acoes"][0]
        self.assertEqual(len(a["midia_fileIds"].split(";")), 10)
        self.assertEqual(a["midia_fileIds"].split(";")[0], "1zkK0EmOdR57ZzABlTMhQyf4PcNEdEsMZ")
        self.assertTrue(a["legenda"].startswith("Natal chegando"))
        self.assertEqual((a["horario"], a["versao"]), ("2026-11-16 19:00", "2"))

    def test_rejeicoes_recebem_recibo_e_propostas_intacto(self):
        d = dec("D-6", "post:P-20261111-01", "aprovar", "legenda=1")
        self.decisoes(dec("D-1", "post:P-20261111-01", "aprovar", "legenda=1", hash_="a" * 64),
                      dec("D-2", "campanha:C02", "aprovar", "verba=12"),
                      dec("D-3", "campanha:C02", "pausar"),
                      dec("D-4", "post:P-20261111-01", "pausar"),
                      dec("D-5", "post:P-20261112-CAT", "refazer", "trocar a foto"),
                      dict(d, item_id="post:NAO-EXISTE"),
                      dict(dec("D-7", "campanha:C02", "aprovar"), tipo_item="post", item_id="post:C02"))
        self.assertEqual(self.plano(), 0)
        self.assertEqual(self.res["acoes"], [])
        mot = {did: self.gws.recibo(did)["motivo"] for did in ("D-1", "D-2", "D-3", "D-4", "D-5", "D-6", "D-7")}
        self.assertEqual(mot["D-1"], "versão desatualizada")
        self.assertEqual(mot["D-2"], "verba acima da proposta")
        self.assertIn("não aceita", mot["D-3"])
        self.assertIn("não vale", mot["D-4"])
        self.assertTrue(mot["D-5"].startswith("comentario inválido"))
        self.assertIn("não existe", mot["D-6"])
        self.assertIn("tipo_item", mot["D-7"])
        for did in mot:
            self.assertEqual(self.gws.recibo(did)["resultado"], "rejeitado")
        self.assertEqual(self.gws.texto(PROP_ID), ler_fixture())
        self.assertEqual(self.gws.contar("update"), 0)
        self.assertEqual(self.ledger()["D-1"]["fase"], "recibo_criado")

    def test_duplicada_mesmo_item_hash_e_mesmo_id(self):
        d1 = dec("D-1", "campanha:C02", "aprovar")
        self.decisoes(d1, dict(d1, comentario="verba=9"), dec("D-2", "campanha:C02", "aprovar", "verba=5"))
        self.plano()
        self.assertEqual([x["decision_id"] for x in self.res["acoes"]], ["D-1"])
        self.assertIn("duplicada", self.gws.recibo("D-2")["motivo"])
        self.assertEqual(self.res["ignoradas"], [{"decision_id": "D-1", "motivo": "id repetido em decisoes.csv"}])
        self.assertIn("id repetido", self.saida)

    def test_rejeitada_nao_bloqueia_nova_decisao(self):
        self.decisoes(dec("D-1", "campanha:C02", "aprovar", "verba=12"))
        self.plano()
        self.decisoes(dec("D-1", "campanha:C02", "aprovar", "verba=12"), dec("D-2", "campanha:C02", "aprovar"))
        self.plano()
        self.assertEqual([x["decision_id"] for x in self.res["acoes"]], ["D-2"])

    def test_outros_modulos_ignorados(self):
        self.decisoes(dec("D-1", "post:P-20261111-01", "aprovar", "legenda=1", modulo="design"))
        self.assertEqual(self.plano(), 0)
        self.assertEqual(self.res["acoes"], [])
        self.assertEqual(self.gws.recibos(), [])

    def test_propostas_nao_configurado(self):
        self.escrever_config("PREENCHER")
        self.decisoes(dec("D-1", "campanha:C02", "aprovar"))
        self.assertEqual(self.plano(), 0)
        self.assertTrue(self.res["sem_propostas"])
        self.assertIn("não configurado", self.saida)
        self.assertEqual(self.gws.recibos(), [])

    def test_recibo_existente_conta_e_nao_planeja(self):
        self.decisoes(dec("D-1", "campanha:C02", "aprovar"))
        self.gws.add("r1", "D-1.json", "{}", [REC_ID])
        self.gws.add("r2", "D-1.json", "{}", [REC_ID])
        self.assertEqual(self.plano(), 0)
        self.assertEqual((self.res["ja_com_recibo"], self.res["acoes"]), (1, []))
        self.assertIn("recibo duplicado", self.saida)
        self.assertEqual(self.gws.contar("create"), 0)


class TestTeste(Base):
    def test_teste_sem_escrita(self):
        self.decisoes(dec("D-1", "campanha:C02", "aprovar"), dec("D-2", "post:P-20261111-01", "aprovar", "legenda=9"))
        self.assertEqual(self.rodar("--teste"), 0)
        self.assertEqual(self.gws.contar("update") + self.gws.contar("create"), 0)
        self.assertFalse(self.tem_ledger())
        self.assertTrue(self.res["teste"])
        self.assertEqual([x["decision_id"] for x in self.res["acoes"]], ["D-1"])
        self.assertEqual([x["decision_id"] for x in self.res["rejeitadas"]], ["D-2"])
        self.assertEqual(self.gws.texto(PROP_ID), ler_fixture())

    def test_plano_teste_sem_escrita(self):
        self.decisoes(dec("D-1", "campanha:C02", "aprovar"))
        self.assertEqual(self.plano("--teste"), 0)
        self.assertEqual(self.gws.contar("update") + self.gws.contar("create"), 0)
        self.assertFalse(self.tem_ledger())

    def test_confirmar_teste_sem_escrita(self):
        self.decisoes(dec("D-1", "campanha:C02", "aprovar", "verba=8"))
        self.assertEqual(self.confirmar("D-1", "--teste"), 0)
        self.assertEqual(self.res["resultado"], "aplicado (teste, nada gravado)")
        self.assertEqual((self.res["estado_novo"], self.res["versao_nova"]), ("aprovado", "2"))
        self.assertEqual(self.gws.contar("update") + self.gws.contar("create"), 0)
        self.assertFalse(self.tem_ledger())
        self.assertEqual(self.gws.texto(PROP_ID), ler_fixture())

    def test_dry_run_e_apelido_de_teste(self):
        self.decisoes(dec("D-1", "campanha:C02", "aprovar"), dec("D-2", "post:P-20261111-01", "aprovar", "legenda=9"))
        self.assertEqual(self.rodar("--dry-run"), 0)
        self.assertIn("--dry-run está obsoleto", self.stderr)
        self.assertTrue(self.res["teste"])
        self.assertEqual(self.gws.contar("update") + self.gws.contar("create"), 0)
        self.assertFalse(self.tem_ledger())
        self.assertEqual([x["decision_id"] for x in self.res["acoes"]], ["D-1"])


class TestConfirmar(Base):
    def test_confirmar_post_grava_ledger_antes_do_recibo(self):
        self.decisoes(dec("D-1", "post:P-20261111-01", "aprovar", "legenda=1;texto=ok"))
        self.plano()
        self.assertEqual(self.confirmar("D-1", "--link", "https://business.facebook.com/x"), 0)
        self.assertEqual(self.res["resultado"], "aplicado")
        l = self.linha("P-20261111-01")
        self.assertEqual((l["estado"], l["legenda_escolhida"], l["versao"], l["horario"]),
                         ("aprovado", "1", "1", "2026-11-13 18:30"))
        self.assertEqual(l["atualizado_em"], "2026-11-12T15:00:00-03:00")
        self.outras_linhas_intactas("P-20261111-01")
        r = self.gws.recibo("D-1")
        self.assertEqual((r["resultado"], r["snapshot_hash"], r["agente"], r["link"]),
                         ("aplicado", VETORES["P-20261111-01"], "Gestor de Tráfego", "https://business.facebook.com/x"))
        e = self.ledger()["D-1"]
        self.assertEqual([h["fase"] for h in e["historico"]],
                         ["planejada", "confirmando", "propostas_atualizada", "recibo_criado"])
        self.assertEqual(e["hash_depois"], C.hash_snapshot(l))
        self.assertEqual(self.gws.contar("update"), 1)

    def test_confirmar_campanha_verba_menor_sobe_versao(self):
        self.decisoes(dec("D-1", "campanha:C02", "aprovar", "verba=8.50"))
        self.assertEqual(self.confirmar("D-1"), 0)
        l = self.linha("C02")
        self.assertEqual((l["estado"], l["verba_diaria"], l["versao"]), ("aprovado", "8.5", "2"))
        self.assertIn("versao 2", self.gws.recibo("D-1")["motivo"])
        self.assertNotIn("link", self.gws.recibo("D-1"))
        self.outras_linhas_intactas("C02")

    def test_confirmar_pausar_refazer_recusar(self):
        self.decisoes(dec("D-1", "campanha:M-52562345108818", "pausar", "texto=gasto sem retorno"),
                      dec("D-2", "post:P-20261112-CAT", "refazer", "texto=trocar a capa"),
                      dec("D-3", "campanha:C02", "recusar"))
        for did in ("D-1", "D-2", "D-3"):
            self.assertEqual(self.confirmar(did), 0)
        self.assertEqual(self.linha("M-52562345108818")["estado"], "pausado")
        self.assertEqual(self.linha("P-20261112-CAT")["estado"], "ajuste")
        self.assertEqual(self.linha("C02")["estado"], "encerrado")
        self.assertEqual(self.gws.recibo("D-3")["motivo"], "recusada pelo Bruno")

    def test_idempotencia_confirmar_duas_vezes(self):
        self.decisoes(dec("D-1", "campanha:C02", "aprovar"))
        self.assertEqual(self.confirmar("D-1"), 0)
        depois = self.gws.texto(PROP_ID)
        self.assertEqual(self.confirmar("D-1"), 0)
        self.assertEqual(self.res["resultado"], "ja_existia")
        self.assertEqual(self.gws.contar("update"), 1)
        self.assertEqual(self.gws.contar("create"), 1)
        self.assertEqual(self.gws.texto(PROP_ID), depois)
        # e o plano não lista de novo
        self.plano()
        self.assertEqual((self.res["acoes"], self.res["ja_com_recibo"]), ([], 1))

    def test_versao_velha_nao_grava(self):
        self.decisoes(dec("D-1", "post:P-20261111-01", "aprovar", "legenda=1", hash_="b" * 64))
        self.assertEqual(self.confirmar("D-1"), 3)
        self.assertIn("versão desatualizada", self.saida)
        self.assertEqual(self.gws.contar("update") + self.gws.contar("create"), 0)
        self.assertFalse(self.tem_ledger())

    def test_proposta_mudou_entre_plano_e_confirmar(self):
        self.decisoes(dec("D-1", "campanha:C02", "aprovar"))
        self.plano()
        self.gws.add(PROP_ID, "Propostas.csv", ler_fixture().replace(",C02,10,", ",C02,9,"))
        self.assertEqual(self.confirmar("D-1"), 3)
        self.assertIn("versão desatualizada", self.saida)
        self.assertEqual(self.gws.contar("update") + self.gws.contar("create"), 0)

    def test_confirmar_rejeitada_no_plano(self):
        self.decisoes(dec("D-1", "campanha:C02", "aprovar", "verba=12"))
        self.gws.falhas["create"] = ["erro"]
        self.assertEqual(self.plano(), 1)  # recibo rejeitado não saiu
        self.assertEqual(self.confirmar("D-1"), 3)
        self.assertIn("rejeitada no plano", self.saida)

    def test_decisao_inexistente_e_link_invalido(self):
        self.decisoes(dec("D-1", "campanha:C02", "aprovar"))
        self.assertEqual(self.confirmar("D-9"), 3)
        self.assertEqual(self.confirmar("D-1", "--link", "ftp://x"), 3)
        self.assertEqual(self.gws.contar("update") + self.gws.contar("create"), 0)

    def test_propostas_nao_configurado_no_confirmar(self):
        self.escrever_config("PREENCHER")
        self.decisoes(dec("D-1", "campanha:C02", "aprovar"))
        self.assertEqual(self.confirmar("D-1"), 3)

    def test_propostas_mudou_no_drive_durante_execucao(self):
        self.decisoes(dec("D-1", "campanha:C02", "aprovar"))
        orig = FakeGws.__call__

        def chamada(self_, args, cwd):
            if args[2] == "get" and len(args) > 4 and "md5Checksum" in args[4]:
                self_.arquivos[PROP_ID]["conteudo"] += b"X,post\r\n"
            return orig(self_, args, cwd)
        FakeGws.__call__ = chamada
        try:
            self.assertEqual(self.confirmar("D-1"), 1)
        finally:
            FakeGws.__call__ = orig
        self.assertEqual(self.gws.contar("update"), 0)
        self.assertIn("mudou no Drive", self.saida)


class TestRetomada(Base):
    def test_queda_entre_update_e_recibo(self):
        self.decisoes(dec("D-1", "post:P-20261111-01", "aprovar", "legenda=1"))
        self.gws.falhas["create"] = ["morte_antes"]
        with self.assertRaises(Morte):
            self.confirmar("D-1")
        self.assertEqual(self.ledger()["D-1"]["fase"], "propostas_atualizada")
        self.assertEqual(self.gws.recibos(), [])
        apos = self.gws.texto(PROP_ID)
        self.plano()
        self.assertEqual(self.res["pendentes"][0]["decision_id"], "D-1")
        self.assertEqual(self.confirmar("D-1"), 0)
        self.assertTrue(self.res["retomada"])
        self.assertEqual(self.gws.contar("update"), 1)
        self.assertEqual(self.gws.texto(PROP_ID), apos)
        self.assertEqual(self.gws.recibo("D-1")["resultado"], "aplicado")
        self.assertEqual(self.ledger()["D-1"]["fase"], "recibo_criado")

    def test_update_chegou_mas_ledger_nao_registrou(self):
        self.decisoes(dec("D-1", "campanha:C02", "aprovar", "verba=8"))
        self.gws.falhas["update"] = ["morte_depois"]
        with self.assertRaises(Morte):
            self.confirmar("D-1")
        self.assertEqual(self.ledger()["D-1"]["fase"], "confirmando")
        self.assertEqual(self.linha("C02")["verba_diaria"], "8")
        self.assertEqual(self.confirmar("D-1"), 0)
        self.assertTrue(self.res["retomada"])
        self.assertEqual(self.gws.contar("update"), 1)
        self.assertEqual(self.linha("C02")["versao"], "2")
        self.assertEqual(self.gws.recibo("D-1")["resultado"], "aplicado")

    def test_queda_antes_do_update_refaz_do_zero(self):
        self.decisoes(dec("D-1", "campanha:C02", "aprovar", "verba=8"))
        self.gws.falhas["update"] = ["morte_antes"]
        with self.assertRaises(Morte):
            self.confirmar("D-1")
        self.assertEqual(self.gws.texto(PROP_ID), ler_fixture())
        self.assertEqual(self.confirmar("D-1"), 0)
        self.assertEqual(self.linha("C02")["verba_diaria"], "8")
        self.assertEqual(self.gws.recibos(), ["D-1.json"])

    def test_create_ambiguo_recibo_existe(self):
        self.decisoes(dec("D-1", "campanha:C02", "aprovar"))
        self.gws.falhas["create"] = ["ambiguo"]
        self.assertEqual(self.confirmar("D-1"), 0)
        self.assertEqual(self.gws.recibos(), ["D-1.json"])
        self.assertEqual(self.gws.contar("create"), 1)
        self.assertEqual(self.ledger()["D-1"]["fase"], "recibo_criado")

    def test_create_falhou_sem_recibo_fica_pendente(self):
        self.decisoes(dec("D-1", "campanha:C02", "aprovar"))
        self.gws.falhas["create"] = ["erro"]
        self.assertEqual(self.confirmar("D-1"), 1)
        self.assertEqual(self.gws.recibos(), [])
        self.assertEqual(self.ledger()["D-1"]["fase"], "propostas_atualizada")
        self.assertEqual(self.confirmar("D-1"), 0)
        self.assertEqual(self.gws.recibos(), ["D-1.json"])
        self.assertEqual(self.gws.contar("update"), 1)

    def test_falha_no_update_fica_pendente(self):
        self.decisoes(dec("D-1", "campanha:C02", "aprovar"))
        self.gws.falhas["update"] = ["erro"]
        self.assertEqual(self.confirmar("D-1"), 1)
        self.assertEqual(self.gws.recibos(), [])
        self.assertEqual(self.confirmar("D-1"), 0)
        self.assertEqual(self.gws.recibo("D-1")["resultado"], "aplicado")

    def test_recibo_duplicado_na_retomada(self):
        self.decisoes(dec("D-1", "campanha:C02", "aprovar"))
        self.gws.falhas["create"] = ["morte_antes"]
        with self.assertRaises(Morte):
            self.confirmar("D-1")
        listar_orig = C.Drive.listar
        estado = {"n": 0}

        def listar(self_, folder, nome=None):
            estado["n"] += 1
            if estado["n"] == 1:
                return []  # listagem atrasada do Drive na primeira consulta
            return [{"id": "x1", "name": nome}, {"id": "x2", "name": nome}]
        C.Drive.listar = listar
        try:
            self.assertEqual(self.confirmar("D-1"), 0)
        finally:
            C.Drive.listar = listar_orig
        self.assertEqual(self.gws.contar("create"), 1)  # só a tentativa que morreu
        self.assertIn("recibo duplicado", self.saida)

    def test_ledger_do_fluxo_antigo(self):
        # entrada antiga (fase "recebida") com o upload já feito: vira recibo e devolve as ações antigas
        self.decisoes(dec("D-1", "campanha:C02", "aprovar", "verba=8"), dec("D-2", "campanha:C02", "aprovar", "verba=99"))
        self.gws.falhas["update"] = ["morte_depois"]
        with self.assertRaises(Morte):
            self.confirmar("D-1")
        e = self.ledger()["D-1"]
        recibo_rej = {"decision_id": "D-2", "snapshot_hash": VETORES["C02"], "resultado": "rejeitado",
                      "motivo": "verba acima da proposta", "processado_em": "2026-11-12T14:00:00-03:00",
                      "agente": "Gestor de Tráfego"}
        self.escrever_ledger({
            "D-1": {"decision_id": "D-1", "fase": "recebida", "resultado": "aplicado", "item_id": "campanha:C02",
                    "pid": "C02", "snapshot_hash": VETORES["C02"], "hash_depois": e["hash_depois"],
                    "recibo": e["recibo"], "acoes": [{"acao": "criar_campanha", "item_id": "campanha:C02"}]},
            "D-2": {"decision_id": "D-2", "fase": "recebida", "resultado": "rejeitado", "item_id": "campanha:C02",
                    "snapshot_hash": VETORES["C02"], "recibo": recibo_rej}})
        self.assertEqual(self.plano(), 0)
        self.assertEqual(self.gws.recibos(), ["D-1.json", "D-2.json"])
        self.assertEqual(self.res["acoes"], [{"acao": "criar_campanha", "item_id": "campanha:C02", "legado": True}])
        self.assertEqual(self.gws.recibo("D-2")["resultado"], "rejeitado")
        self.assertEqual(self.gws.contar("update"), 1)


class TestCodigos(Base):
    def test_auth_no_plano_para_tudo(self):
        self.decisoes(dec("D-1", "campanha:C02", "aprovar"))
        self.gws.falhas["list"] = ["auth"]
        self.assertEqual(self.plano(), 2)
        self.assertIn("AUTENTICAÇÃO", self.saida)
        self.assertEqual(self.gws.contar("update") + self.gws.contar("create"), 0)

    def test_auth_exit2_do_gws(self):
        self.decisoes(dec("D-1", "campanha:C02", "aprovar"))
        orig = FakeGws.__call__
        FakeGws.__call__ = lambda self_, args, cwd: (2, "", "falha")
        try:
            self.assertEqual(self.plano(), 2)
        finally:
            FakeGws.__call__ = orig

    def test_auth_no_update_do_confirmar(self):
        self.decisoes(dec("D-1", "campanha:C02", "aprovar"))
        self.gws.falhas["update"] = ["auth"]
        self.assertEqual(self.confirmar("D-1"), 2)
        self.assertEqual(self.gws.contar("create"), 0)
        self.assertEqual(self.gws.recibos(), [])
        self.assertEqual(self.gws.texto(PROP_ID), ler_fixture())

    def test_contrato_3(self):
        self.gws.add(DEC_ID, "decisoes.csv", "id,quando,modulo\r\nD-1,x,anuncios\r\n")
        self.assertEqual(self.plano(), 3)
        self.decisoes(dec("D-1", "campanha:C02", "aprovar"))
        self.gws.add(PROP_ID, "Propostas.csv", "id,tipo\r\nC02,campanha\r\n")
        self.assertEqual(self.plano(), 3)
        self.assertIn("cabeçalho de Propostas.csv", self.saida)
        self.assertEqual(self.gws.contar("update") + self.gws.contar("create"), 0)

    def test_config_e_argumentos_3(self):
        with open(self.cfg_path, "w", encoding="utf-8") as f:
            json.dump({"decisoes_fileId": "PREENCHER", "recibos_folderId": REC_ID}, f)
        self.assertEqual(self.plano(), 3)
        self.escrever_config(PROP_ID)
        self.decisoes(dec("D-1", "campanha:C02", "aprovar"))
        self.assertEqual(self.rodar("--acoes", "x.json"), 3)
        self.assertIn("--acoes foi removido", self.saida)
        self.assertEqual(self.rodar("--plano", "--link", "https://x"), 3)
        with self.assertRaises(SystemExit) as cm:
            self.rodar("--plano", "--confirmar", "D-1")
        self.assertEqual(cm.exception.code, 3)
        self.assertEqual(self.gws.contar("update") + self.gws.contar("create"), 0)


if __name__ == "__main__":
    unittest.main()
