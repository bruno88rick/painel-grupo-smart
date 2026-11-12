"""Testes do consumidor de anúncios. Rodar: python3 -m unittest discover consumidor

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
                       "pasta_trabalho": "trabalho", "ledger_path": "ledger.json", "acoes_path": "acoes.json"}, f)

    def decisoes(self, *decs):
        self.gws.add(DEC_ID, "decisoes.csv", csv_decisoes(decs))

    def rodar(self, *extra):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = C.main(["--config", self.cfg_path] + list(extra), runner=self.gws, agora=AGORA)
        self.saida = out.getvalue() + err.getvalue()
        return rc

    def linha(self, pid):
        return C.Propostas(self.gws.texto(PROP_ID)).buscar(pid)[0]

    def ledger(self):
        with open(os.path.join(self.tmp, "ledger.json"), encoding="utf-8") as f:
            return json.load(f)["decisoes"]

    def acoes(self):
        with open(os.path.join(self.tmp, "acoes.json"), encoding="utf-8") as f:
            return json.load(f)["acoes"]

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


class TestFluxo(Base):
    def test_decisao_valida_aplica_e_cria_recibo(self):
        self.decisoes(dec("D-1", "post:P-20261111-01", "aprovar", "legenda=1;texto=ok"))
        self.assertEqual(self.rodar(), 0)
        l = self.linha("P-20261111-01")
        self.assertEqual((l["estado"], l["legenda_escolhida"], l["versao"], l["horario"]),
                         ("aprovado", "1", "1", "2026-11-13 18:30"))
        self.assertEqual(l["atualizado_em"], "2026-11-12T15:00:00-03:00")
        self.outras_linhas_intactas("P-20261111-01")
        r = self.gws.recibo("D-1")
        self.assertEqual(r["resultado"], "aplicado")
        self.assertEqual(r["snapshot_hash"], VETORES["P-20261111-01"])
        self.assertEqual(r["agente"], "Gestor de Tráfego")
        self.assertEqual(r["processado_em"], "2026-11-12T15:00:00-03:00")
        e = self.ledger()["D-1"]
        self.assertEqual([h["fase"] for h in e["historico"]], ["recebida", "propostas_atualizada", "recibo_criado"])
        self.assertEqual(e["hash_depois"], C.hash_snapshot(l))
        a = self.acoes()
        self.assertEqual(a[0]["acao"], "programar_post")
        self.assertTrue(a[0]["legenda"].startswith("Mesa posta de Natal"))
        self.assertEqual(self.gws.contar("update"), 1)
        # segunda execução: nada a fazer
        self.assertEqual(self.rodar(), 0)
        self.assertEqual(self.gws.contar("update"), 1)
        self.assertEqual(self.gws.recibos(), ["D-1.json"])

    def test_hash_velho_rejeita_e_propostas_intacto(self):
        self.decisoes(dec("D-1", "post:P-20261111-01", "aprovar", "legenda=1", hash_="a" * 64))
        self.assertEqual(self.rodar(), 0)
        self.assertEqual(self.gws.texto(PROP_ID), ler_fixture())
        self.assertEqual(self.gws.contar("update"), 0)
        r = self.gws.recibo("D-1")
        self.assertEqual((r["resultado"], r["motivo"]), ("rejeitado", "versão desatualizada"))

    def test_duplicada_mesmo_item_hash_e_mesmo_id(self):
        d1 = dec("D-1", "campanha:C02", "aprovar")
        d2 = dec("D-2", "campanha:C02", "aprovar", "verba=5")
        d1b = dict(d1, comentario="verba=9")
        self.decisoes(d1, d1b, d2)
        self.assertEqual(self.rodar(), 0)
        self.assertEqual(self.gws.recibo("D-1")["resultado"], "aplicado")
        r2 = self.gws.recibo("D-2")
        self.assertEqual(r2["resultado"], "rejeitado")
        self.assertIn("duplicada", r2["motivo"])
        self.assertEqual(self.gws.recibos(), ["D-1.json", "D-2.json"])
        self.assertIn("id repetido", self.saida)
        l = self.linha("C02")
        self.assertEqual((l["estado"], l["verba_diaria"], l["versao"]), ("aprovado", "10", "1"))

    def test_duplicada_em_execucao_posterior_pelo_ledger(self):
        self.decisoes(dec("D-1", "campanha:C02", "aprovar"))
        self.rodar()
        self.decisoes(dec("D-1", "campanha:C02", "aprovar"), dec("D-2", "campanha:C02", "aprovar"))
        self.rodar()
        self.assertIn("duplicada", self.gws.recibo("D-2")["motivo"])

    def test_verba_acima_rejeita(self):
        self.decisoes(dec("D-1", "campanha:C02", "aprovar", "verba=12"))
        self.rodar()
        r = self.gws.recibo("D-1")
        self.assertEqual((r["resultado"], r["motivo"]), ("rejeitado", "verba acima da proposta"))
        self.assertEqual(self.gws.texto(PROP_ID), ler_fixture())

    def test_verba_menor_sobe_versao(self):
        self.decisoes(dec("D-1", "campanha:C02", "aprovar", "verba=8.50;texto=começar menor"))
        self.rodar()
        l = self.linha("C02")
        self.assertEqual((l["estado"], l["verba_diaria"], l["versao"]), ("aprovado", "8.5", "2"))
        a = self.acoes()[0]
        self.assertEqual((a["acao"], a["verba_diaria"]), ("criar_campanha", "8.5"))
        self.outras_linhas_intactas("C02")

    def test_pausar_campanha_ativa(self):
        self.decisoes(dec("D-1", "campanha:M-52562345108818", "pausar", "texto=gasto sem retorno"))
        self.rodar()
        self.assertEqual(self.linha("M-52562345108818")["estado"], "pausado")
        a = self.acoes()[0]
        self.assertEqual((a["acao"], a["campanha_id"]), ("pausar_campanha_meta", "M-52562345108818"))
        self.assertEqual(self.gws.recibo("D-1")["resultado"], "aplicado")

    def test_carrossel_10_midias_legenda_2_novo_horario(self):
        self.decisoes(dec("D-1", "post:P-20261112-CAT", "aprovar", "legenda=2;horario=2026-11-16 19:00"))
        self.rodar()
        l = self.linha("P-20261112-CAT")
        self.assertEqual((l["estado"], l["legenda_escolhida"], l["horario"], l["versao"]),
                         ("aprovado", "2", "2026-11-16 19:00", "2"))
        self.assertEqual(len(l["midia_fileIds"].split(";")), 10)
        a = self.acoes()[0]
        self.assertEqual(a["midia_fileIds"].split(";")[0], "1zkK0EmOdR57ZzABlTMhQyf4PcNEdEsMZ")
        self.assertTrue(a["legenda"].startswith("Natal chegando"))
        self.assertIn("versao 2", self.gws.recibo("D-1")["motivo"])
        self.outras_linhas_intactas("P-20261112-CAT")

    def test_comentario_invalido(self):
        self.decisoes(dec("D-1", "post:P-20261111-01", "aprovar", "texto=sem legenda"),
                      dec("D-2", "post:P-20261112-CAT", "refazer", "trocar a foto"))
        self.rodar()
        for did in ("D-1", "D-2"):
            r = self.gws.recibo(did)
            self.assertEqual(r["resultado"], "rejeitado")
            self.assertTrue(r["motivo"].startswith("comentario inválido"))
        self.assertEqual(self.gws.texto(PROP_ID), ler_fixture())

    def test_estado_nao_decidivel(self):
        self.decisoes(dec("D-1", "campanha:C02", "pausar"),
                      dec("D-2", "campanha:M-52562345108818", "aprovar"),
                      dec("D-3", "post:P-20261111-01", "pausar"))
        self.rodar()
        self.assertIn("não aceita", self.gws.recibo("D-1")["motivo"])
        self.assertIn("não aceita", self.gws.recibo("D-2")["motivo"])
        self.assertIn("não vale", self.gws.recibo("D-3")["motivo"])
        self.assertEqual(self.gws.texto(PROP_ID), ler_fixture())

    def test_item_inexistente_e_tipo_errado(self):
        d = dec("D-1", "post:P-20261111-01", "aprovar", "legenda=1")
        self.decisoes(dict(d, item_id="post:NAO-EXISTE"), dict(dec("D-2", "campanha:C02", "aprovar"), tipo_item="post",
                                                               item_id="post:C02"))
        self.rodar()
        self.assertIn("não existe", self.gws.recibo("D-1")["motivo"])
        self.assertIn("tipo_item", self.gws.recibo("D-2")["motivo"])

    def test_outros_modulos_ignorados(self):
        self.decisoes(dec("D-1", "post:P-20261111-01", "aprovar", "legenda=1", modulo="design"))
        self.assertEqual(self.rodar(), 0)
        self.assertEqual(self.gws.recibos(), [])
        self.assertEqual(self.gws.contar("update"), 0)

    def test_retomada_apos_falha_entre_update_e_recibo(self):
        self.decisoes(dec("D-1", "post:P-20261111-01", "aprovar", "legenda=1"))
        self.gws.falhas["create"] = ["morte_antes"]
        with self.assertRaises(Morte):
            self.rodar()
        self.assertEqual(self.ledger()["D-1"]["fase"], "propostas_atualizada")
        self.assertEqual(self.gws.recibos(), [])
        apos_update = self.gws.texto(PROP_ID)
        self.assertEqual(self.rodar(), 0)
        self.assertEqual(self.gws.contar("update"), 1)
        self.assertEqual(self.gws.texto(PROP_ID), apos_update)
        self.assertEqual(self.gws.recibo("D-1")["resultado"], "aplicado")
        self.assertEqual(self.ledger()["D-1"]["fase"], "recibo_criado")
        self.assertEqual(self.acoes()[0]["acao"], "programar_post")

    def test_retomada_quando_update_chegou_mas_ledger_nao_registrou(self):
        self.decisoes(dec("D-1", "campanha:C02", "aprovar", "verba=8"))
        self.gws.falhas["update"] = ["morte_depois"]
        with self.assertRaises(Morte):
            self.rodar()
        self.assertEqual(self.ledger()["D-1"]["fase"], "recebida")
        self.assertEqual(self.linha("C02")["verba_diaria"], "8")
        self.assertEqual(self.rodar(), 0)
        self.assertEqual(self.gws.contar("update"), 1)
        self.assertEqual(self.linha("C02")["versao"], "2")
        self.assertEqual(self.gws.recibo("D-1")["resultado"], "aplicado")

    def test_create_ambiguo_recibo_existe(self):
        self.decisoes(dec("D-1", "campanha:C02", "aprovar"))
        self.gws.falhas["create"] = ["ambiguo"]
        self.assertEqual(self.rodar(), 0)
        self.assertEqual(self.gws.recibos(), ["D-1.json"])
        self.assertEqual(self.gws.contar("create"), 1)
        self.assertEqual(self.ledger()["D-1"]["fase"], "recibo_criado")

    def test_create_falhou_sem_recibo_fica_pendente(self):
        self.decisoes(dec("D-1", "campanha:C02", "aprovar"))
        self.gws.falhas["create"] = ["erro"]
        self.assertEqual(self.rodar(), 1)
        self.assertEqual(self.gws.recibos(), [])
        self.assertEqual(self.ledger()["D-1"]["fase"], "propostas_atualizada")
        self.assertEqual(self.rodar(), 0)
        self.assertEqual(self.gws.recibos(), ["D-1.json"])
        self.assertEqual(self.gws.contar("update"), 1)

    def test_recibo_duplicado_nao_cria_outro(self):
        self.decisoes(dec("D-1", "campanha:C02", "aprovar"))
        self.gws.add("r1", "D-1.json", "{}", [REC_ID])
        self.gws.add("r2", "D-1.json", "{}", [REC_ID])
        self.assertEqual(self.rodar(), 0)
        self.assertEqual(self.gws.contar("create"), 0)
        self.assertIn("recibo duplicado", self.saida)

    def test_recibo_duplicado_na_retomada(self):
        self.decisoes(dec("D-1", "campanha:C02", "aprovar"))
        self.gws.falhas["create"] = ["morte_antes"]
        with self.assertRaises(Morte):
            self.rodar()
        # outro processo criou dois recibos e a listagem inicial ainda não os vê
        listar_orig = C.Drive.listar
        estado = {"n": 0}

        def listar(self_, folder, nome=None):
            estado["n"] += 1
            if nome is None:
                return []
            return [{"id": "x1", "name": nome}, {"id": "x2", "name": nome}]
        C.Drive.listar = listar
        try:
            self.assertEqual(self.rodar(), 0)
        finally:
            C.Drive.listar = listar_orig
        self.assertEqual(self.gws.contar("create"), 1)  # só a tentativa que morreu
        self.assertIn("recibo duplicado", self.saida)

    def test_erro_auth_para_tudo(self):
        self.decisoes(dec("D-1", "campanha:C02", "aprovar"))
        self.gws.falhas["list"] = ["auth"]
        self.assertEqual(self.rodar(), 2)
        self.assertIn("AUTENTICAÇÃO", self.saida)
        self.assertEqual(self.gws.contar("update") + self.gws.contar("create"), 0)
        self.assertEqual(self.gws.texto(PROP_ID), ler_fixture())

    def test_erro_auth_no_meio_para_as_proximas(self):
        self.decisoes(dec("D-1", "campanha:C02", "aprovar"), dec("D-2", "campanha:M-52562345108818", "pausar"))
        self.gws.falhas["update"] = ["auth"]
        self.assertEqual(self.rodar(), 2)
        self.assertEqual(self.gws.contar("update"), 1)
        self.assertEqual(self.gws.contar("create"), 0)
        self.assertEqual(self.gws.recibos(), [])
        self.assertEqual(self.gws.texto(PROP_ID), ler_fixture())

    def test_propostas_nao_configurado(self):
        self.escrever_config("PREENCHER")
        self.decisoes(dec("D-1", "campanha:C02", "aprovar"))
        self.assertEqual(self.rodar(), 0)
        self.assertIn("não configurado", self.saida)
        self.assertEqual(self.gws.recibos(), [])

    def test_dry_run_nao_grava(self):
        self.decisoes(dec("D-1", "campanha:C02", "aprovar"), dec("D-2", "post:P-20261111-01", "aprovar", "legenda=9"))
        self.assertEqual(self.rodar("--dry-run"), 0)
        self.assertEqual(self.gws.contar("update") + self.gws.contar("create"), 0)
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "ledger.json")))
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "acoes.json")))
        self.assertIn("aplicada D-1", self.saida)
        self.assertIn("rejeitada D-2", self.saida)

    def test_propostas_mudou_no_drive_durante_execucao(self):
        self.decisoes(dec("D-1", "campanha:C02", "aprovar"))
        orig = FakeGws.__call__

        def chamada(self_, args, cwd):
            if args[2] == "get" and len(args) > 4 and "md5Checksum" in args[4]:
                self_.arquivos[PROP_ID]["conteudo"] += b"X,post\r\n"
            return orig(self_, args, cwd)
        FakeGws.__call__ = chamada
        try:
            self.assertEqual(self.rodar(), 1)
        finally:
            FakeGws.__call__ = orig
        self.assertEqual(self.gws.contar("update"), 0)
        self.assertIn("mudou no Drive", self.saida)


if __name__ == "__main__":
    unittest.main()
