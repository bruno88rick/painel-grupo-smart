#!/usr/bin/env python3
"""Consumidor das decisões modulo=financas do Painel Grupo Smart.

Roda do lado do Assistente Financeiro. Só biblioteca padrão do Python 3. Autocontido.

  --plano                 lê decisoes.csv (modulo=financas), confere cada decisão contra Contas.csv,
                          contas-recebidas.csv e Rateios.csv (snapshot_hash igual ao do painel; aceita o formato
                          antigo e o atual de Finanças) e imprime em JSON as ações: registrar_pagamento,
                          registrar_rateio_recebido. Decisões com versão velha ou inválidas recebem recibo rejeitado.
  --confirmar <decision_id> [--link URL]
                          atualiza pago_em e estado em Contas.csv, ou recebidos (e pagaram) em Rateios.csv,
                          e grava recibos/<decision_id>.json (ledger antes do recibo).
  --teste                 só leitura: não grava Drive, ledger nem recibo.

Este script não mexe em Lancamentos.csv nem paga nada. Contrato: docs/contrato-financas.md.

Códigos de saída: 0 ok; 1 pendência/erro recuperável; 2 erro de autenticação no Drive (parou tudo);
3 configuração, argumento ou arquivo fora do contrato.
"""

# ==================== BASE V3 (início) ====================
# Bloco idêntico em consumidor_emails.py, consumidor_financas.py e consumidor_investimentos.py
# (cada script é autocontido para ser publicado sozinho). test_consumidores_v3.py confere que os três são iguais.

import argparse
import csv
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import unicodedata
from datetime import datetime, timedelta, timezone

TZ_SP = timezone(timedelta(hours=-3))
SEP = "\u001f"
CABECALHO_DECISOES = "id,quando,modulo,item_id,tipo_item,versao,arte_fileId,snapshot_hash,decisao,comentario,origem".split(",")

# Mesmo conjunto de String.prototype.trim() do JavaScript (str.strip() puro difere).
_JS_WS = ("\t\n\u000b\u000c\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009"
          "\u200a\u2028\u2029\u202f\u205f\u3000\ufeff")

# Fases do ledger por decisão
F_REJEITADA = "rejeitada"          # recibo rejeitado ainda não criado
F_PLANEJADA = "planejada"          # ação entregue ao agente
F_CONFIRMANDO = "confirmando"      # agente confirmou; linhas novas previstas gravadas antes do upload
F_ATUALIZADA = "arquivo_atualizado"
F_RECIBO = "recibo_criado"
FASES_VALIDAS = (F_PLANEJADA, F_CONFIRMANDO, F_ATUALIZADA, F_RECIBO)


class ErroAuth(Exception):
    pass


class ErroDrive(Exception):
    pass


class ErroContrato(Exception):
    pass


# ---------------------------------------------------------------- texto canônico e hash (canonicoV3 de src/Lib.gs)

def trim_js(s):
    return s.strip(_JS_WS)


def normalizar(v):
    s = "" if v is None else str(v)
    return trim_js(s.replace("\r\n", "\n").replace("\r", "\n"))


def canonico(tipo, campos):
    return SEP.join(normalizar(x) for x in [tipo] + list(campos))


def sha256(texto):
    return hashlib.sha256(texto.encode("utf-8")).hexdigest()


def sem_acento(s):
    s = unicodedata.normalize("NFD", s or "")
    return trim_js("".join(ch for ch in s if not ("\u0300" <= ch <= "\u036f")).lower())


def classificar(txt, regras, padrao="outro"):
    """classificarComeco: texto livre sem acento, minúsculas, pelo começo."""
    s = sem_acento(txt)
    for rx, nome in regras:
        if re.match(rx, s):
            return nome
    return padrao


def _data_js(a, me, d, h=0, mi=0):
    """new Date(a, me-1, d, h, mi) com o mesmo transbordo do JavaScript (mês 13, dia 32...)."""
    a2, m2 = a + (me - 1) // 12, (me - 1) % 12 + 1
    return datetime(a2, m2, 1) + timedelta(days=d - 1, hours=h, minutes=mi)


def parse_data(txt, ano=None):
    """parseData de src/Lib.gs: "2026-11-09", "2026-11-11 18:30", "11/11/2026", "14/11 19:00"."""
    if not txt:
        return None
    s = trim_js(str(txt))
    m = re.search(r"([0-9]{4})-([0-9]{2})-([0-9]{2})(?:[ T]([0-9]{1,2}):([0-9]{2}))?", s)
    if m:
        return _data_js(int(m.group(1)), int(m.group(2)), int(m.group(3)), int(m.group(4) or 0), int(m.group(5) or 0))
    m = re.search(r"([0-9]{1,2})/([0-9]{1,2})(?:/([0-9]{4}))?(?:[^0-9]+([0-9]{1,2})[:h]([0-9]{2}))?", s)
    if m:
        a = int(m.group(3)) if m.group(3) else (ano or datetime.now(TZ_SP).year)
        return _data_js(a, int(m.group(2)), int(m.group(1)), int(m.group(4) or 0), int(m.group(5) or 0))
    return None


def dia_iso(d):
    return d.strftime("%Y-%m-%d")


# ---------------------------------------------------------------- CSV (parseCsv de src/Lib.gs), preservando bytes

def dividir_registros(texto):
    regs, ini, aspas = [], 0, False
    for i, ch in enumerate(texto):
        if ch == '"':
            aspas = not aspas
        elif ch == "\n" and not aspas:
            regs.append(texto[ini:i + 1])
            ini = i + 1
    if ini < len(texto):
        regs.append(texto[ini:])
    return regs


def separar_terminador(raw):
    if raw.endswith("\r\n"):
        return raw[:-2], "\r\n"
    if raw.endswith("\n"):
        return raw[:-1], "\n"
    return raw, ""


def campos_registro(raw):
    """Campos de um registro, com as mesmas regras do parseCsv do painel ([] = linha vazia)."""
    corpo, _ = separar_terminador(raw)
    linha, campo, aspas, i, n = [], "", False, 0, len(corpo)
    while i < n:
        c = corpo[i]
        if aspas:
            if c == '"':
                if i + 1 < n and corpo[i + 1] == '"':
                    campo += '"'
                    i += 2
                    continue
                aspas = False
                i += 1
                continue
            if c == "\r" and i + 1 < n and corpo[i + 1] == "\n":
                i += 1
                continue
            campo += c
            i += 1
            continue
        if c == '"':
            if campo:
                raise ErroContrato("aspas no meio do campo")
            aspas = True
            i += 1
            continue
        if c == ",":
            linha.append(campo)
            campo = ""
            i += 1
            continue
        if c == "\r":
            i += 1
            continue
        campo += c
        i += 1
    if aspas:
        raise ErroContrato("aspas sem fechar")
    linha.append(campo)
    if len(linha) == 1 and trim_js(linha[0]) == "":
        return []
    return linha


def csv_campo(v):
    s = "" if v is None else str(v)
    if re.search(r'[",\r\n]', s):
        return '"' + s.replace('"', '""') + '"'
    return s


class Tabela:
    """CSV do agente em memória; só as linhas alteradas são reserializadas (o resto fica byte a byte)."""

    def __init__(self, texto, nome, obrigatorias=()):
        self.nome = nome
        self.bom = texto.startswith("\ufeff")
        self.regs = dividir_registros(texto[1:] if self.bom else texto)
        try:
            cab = campos_registro(self.regs[0]) if self.regs else []
        except ErroContrato as e:
            raise ErroContrato("%s: %s no cabeçalho" % (nome, e))
        if not cab:
            raise ErroContrato("%s sem cabeçalho" % nome)
        self.cab = [trim_js(c) for c in cab]
        faltam = [c for c in obrigatorias if c not in self.cab]
        if faltam:
            raise ErroContrato("%s: faltam colunas: %s" % (nome, ", ".join(faltam)))
        self.col = {c: i for i, c in enumerate(self.cab)}  # nome repetido: vale a última, como no painel
        self.term = separar_terminador(self.regs[0])[1] or "\r\n"

    def linhas(self):
        """[(indice, objeto com campos sem espaços nas pontas, valores crus)] como csvParaObjetos."""
        out = []
        for i in range(1, len(self.regs)):
            try:
                v = campos_registro(self.regs[i])
            except ErroContrato as e:
                raise ErroContrato("%s: %s, registro %d" % (self.nome, e, i + 1))
            if not v:
                continue
            o = {}
            for k, c in enumerate(self.cab):
                o[c] = trim_js(v[k]) if k < len(v) else ""
            out.append((i, o, v))
        return out

    def valores_com(self, valores, mudancas):
        v = list(valores) + [""] * max(0, len(self.cab) - len(valores))
        for c, x in mudancas.items():
            if c not in self.col:
                raise ErroContrato("%s sem a coluna %s" % (self.nome, c))
            v[self.col[c]] = x
        return v

    def substituir(self, indice, valores):
        _, term = separar_terminador(self.regs[indice])
        self.regs[indice] = ",".join(csv_campo(x) for x in valores) + (term or self.term)

    def corpo(self, indice):
        return separar_terminador(self.regs[indice])[0]

    def texto(self):
        return ("\ufeff" if self.bom else "") + "".join(self.regs)


def ultima_por(linhas, chave):
    """ultimaPor: uma linha por chave (repetidas: vale a mais abaixo), na ordem da primeira aparição."""
    ordem, m = [], {}
    for x in linhas:
        k = chave(x)
        if not k:
            continue
        if k not in m:
            ordem.append(k)
        m[k] = x
    return [m[k] for k in ordem]


def ler_decisoes(texto):
    if texto.startswith("\ufeff"):
        texto = texto[1:]
    linhas = [l for l in csv.reader(io.StringIO(texto, newline="")) if l and not (len(l) == 1 and trim_js(l[0]) == "")]
    if not linhas:
        raise ErroContrato("decisoes.csv vazio")
    if [trim_js(c) for c in linhas[0]] != CABECALHO_DECISOES:
        raise ErroContrato("cabeçalho de decisoes.csv diferente do contrato")
    return [{c: (trim_js(l[i]) if i < len(l) else "") for i, c in enumerate(CABECALHO_DECISOES)} for l in linhas[1:]]


# ---------------------------------------------------------------- comentário (parseComentarioV3 de src/Lib.gs)

def validar_campo(k, v):
    if k == "data" and not re.match(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$", v):
        raise ValueError("data deve ser aaaa-mm-dd")
    if k == "valor" and not (re.match(r"^[0-9]+(\.[0-9]{1,2})?$", v) and float(v) > 0):
        raise ValueError("valor deve ser um número maior que zero (ponto decimal)")
    if k == "texto" and len(v) > 1500:
        raise ValueError("texto muito longo")


def parse_comentario(txt, campos):
    """campos = [(chave, obrigatorio)], na ordem da decisão; "texto" é sempre o último e pode ter ";" e "="."""
    s = trim_js(re.sub(r"[\r\n]+", " ", txt or ""))
    ordem = [k for k, _ in campos]
    r, pos = {}, 0
    while s:
        if s.startswith("texto="):
            if "texto" not in ordem:
                raise ValueError("esta decisão não aceita texto")
            r["texto"] = trim_js(s[6:])
            break
        i = s.find(";")
        par = s if i < 0 else s[:i]
        s = "" if i < 0 else re.sub(r"^\s+", "", s[i + 1:])
        m = re.match(r"^(\w+)=([^\u2028\u2029]*)\Z", par, re.A)  # como o regex do JS (\w ASCII; . sem U+2028/9)
        if not m:
            raise ValueError('fora do formato (esperado chave=valor): "%s"' % par)
        k, v = m.group(1), trim_js(m.group(2))
        if k not in ordem:
            raise ValueError('"%s" não vale para esta decisão' % k)
        idx = ordem.index(k)
        if idx < pos:
            raise ValueError("chaves fora de ordem (%s)" % ", ".join(ordem))
        pos = idx + 1
        validar_campo(k, v)
        r[k] = v
    if "texto" in r:
        validar_campo("texto", r["texto"])
    for k, obrig in campos:
        if obrig and not r.get(k):
            raise ValueError("texto obrigatório" if k == "texto" else "falta " + k)
    return r


# ---------------------------------------------------------------- Drive via gws

_RE_AUTH = re.compile(r"\b401\b|\b403\b|invalid_grant|unauthenticated|unauthorized|autentica", re.I)


def runner_subprocess(gws_bin):
    def run(args, cwd):
        p = subprocess.run([gws_bin] + args, cwd=cwd, capture_output=True, text=True, timeout=300)
        return p.returncode, p.stdout, p.stderr
    return run


def _q(s):
    return str(s).replace("\\", "\\\\").replace("'", "\\'")


class Drive:
    """Camada fina sobre o CLI gws. cwd = pasta de trabalho; --output/--upload sempre relativos."""

    def __init__(self, workdir, runner):
        self.workdir = workdir
        self.runner = runner

    def _rodar(self, args):
        try:
            rc, out, err = self.runner(args, self.workdir)
        except subprocess.TimeoutExpired:
            raise ErroDrive("timeout no gws")
        texto = (out or "") + "\n" + (err or "")
        if rc == 2 or (rc != 0 and _RE_AUTH.search(texto)):
            raise ErroAuth(trim_js(err or out or "falha de autenticação")[:300])
        if rc != 0:
            raise ErroDrive("gws saiu com código %s: %s" % (rc, trim_js(err or out)[:300]))
        try:
            j = json.loads(out) if out and out.strip().startswith("{") else None
        except ValueError:
            j = None
        if isinstance(j, dict) and isinstance(j.get("error"), dict):
            if j["error"].get("code") in (401, 403):
                raise ErroAuth(str(j["error"].get("message", ""))[:300])
            raise ErroDrive("erro da API: %s" % j["error"].get("message"))
        return out

    def baixar(self, file_id, rel):
        self._rodar(["drive", "files", "get", "--params", json.dumps({"fileId": file_id, "alt": "media"}), "--output", rel])
        with open(os.path.join(self.workdir, rel), encoding="utf-8", newline="") as f:
            return f.read()

    def md5(self, file_id):
        out = self._rodar(["drive", "files", "get", "--params", json.dumps({"fileId": file_id, "fields": "id,md5Checksum"})])
        try:
            return json.loads(out).get("md5Checksum")
        except ValueError:
            return None

    def listar(self, folder_id, nome=None):
        q = "'%s' in parents and trashed=false" % _q(folder_id)
        if nome is not None:
            q += " and name='%s'" % _q(nome)
        params = {"q": q, "fields": "nextPageToken,files(id,name)", "pageSize": 1000}
        out = self._rodar(["drive", "files", "list", "--params", json.dumps(params), "--page-all", "--page-limit", "50"])
        arquivos = []
        for linha in (out or "").splitlines():
            if linha.strip():
                try:
                    arquivos.extend(json.loads(linha).get("files", []))
                except ValueError:
                    raise ErroDrive("resposta inesperada do list")
        return arquivos

    def atualizar(self, file_id, rel, mime="text/csv"):
        self._rodar(["drive", "files", "update", "--params", json.dumps({"fileId": file_id}),
                     "--upload", rel, "--upload-content-type", mime])

    def criar(self, nome, parent, rel, mime="application/json"):
        self._rodar(["drive", "files", "create", "--json", json.dumps({"name": nome, "parents": [parent], "mimeType": mime}),
                     "--upload", rel, "--upload-content-type", mime])


# ---------------------------------------------------------------- ledger

class Ledger:
    def __init__(self, caminho, somente_leitura=False):
        self.caminho = caminho
        self.ro = somente_leitura
        self.dados = {"versao": 1, "decisoes": {}}
        if caminho and os.path.exists(caminho):
            with open(caminho, encoding="utf-8") as f:
                self.dados = json.load(f)
            self.dados.setdefault("decisoes", {})

    def get(self, did):
        return self.dados["decisoes"].get(did)

    def decididas(self):
        """(item_id, hash) -> decision_id das decisões válidas já planejadas/aplicadas."""
        return {(e.get("item_id"), e.get("snapshot_hash")): did for did, e in self.dados["decisoes"].items()
                if e.get("fase") in FASES_VALIDAS}

    def gravar(self, did, em, **campos):
        e = self.dados["decisoes"].setdefault(did, {"decision_id": did})
        e.update(campos)
        e.setdefault("historico", []).append({"fase": e.get("fase"), "em": em})
        if self.ro or not self.caminho:
            return
        pasta = os.path.dirname(os.path.abspath(self.caminho))
        os.makedirs(pasta, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix=".ledger-", dir=pasta)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(self.dados, f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, self.caminho)


def agora_iso(agora):
    return agora.astimezone(TZ_SP).isoformat(timespec="seconds")


def dia_da_decisao(dec, agora):
    """Data (aaaa-mm-dd) do campo quando da decisão; sem ela, a data de agora em São Paulo."""
    m = re.match(r"^([0-9]{4}-[0-9]{2}-[0-9]{2})", dec.get("quando") or "")
    return m.group(1) if m else agora.astimezone(TZ_SP).strftime("%Y-%m-%d")


# ---------------------------------------------------------------- consumidor genérico

class Consumidor:
    """Fluxo comum: --plano, --confirmar e --teste. Cada módulo define:
    MODULO, AGENTE, ARQUIVOS {chave: (chave_da_config, nome do arquivo, colunas obrigatórias, opcional)},
    REGRAS {tipo_item: {decisao: (estados aceitos, [(campo, obrigatorio)])}},
    montar(tabelas) -> {item_id: item}, montar_acao(dec, item, comentario) -> dict e
    aplicar(dec, item, comentario, tabelas, quando) -> (chave do arquivo, [(indice, valores)], motivo, estado_novo).
    """

    MODULO = AGENTE = ""
    ARQUIVOS = {}
    REGRAS = {}

    def __init__(self, cfg, drive, ledger, teste=False, agora=None, log=None):
        self.cfg = cfg
        self.drive = drive
        self.ledger = ledger
        self.teste = teste
        self.agora = agora or (lambda: datetime.now(TZ_SP))
        self.log = log or (lambda m: print(m, file=sys.stderr))
        self.avisos = []
        self.md5s = {}

    def aviso(self, m):
        self.avisos.append(m)
        self.log("aviso: " + m)

    def _fase(self, did, **campos):
        self.ledger.gravar(did, agora_iso(self.agora()), **campos)

    def file_id(self, chave):
        v = self.cfg.get(self.ARQUIVOS[chave][0]) or ""
        return "" if v == "PREENCHER" else v

    def _carregar(self):
        texto = self.drive.baixar(self.cfg["decisoes_fileId"], "decisoes.csv")
        decs, vistos = [], set()
        for d in ler_decisoes(texto):
            if d["modulo"] != self.MODULO or not d["id"]:
                continue
            if d["id"] in vistos:
                self.aviso("id repetido em decisoes.csv: %s (só a primeira linha vale)" % d["id"])
                continue
            vistos.add(d["id"])
            decs.append(d)
        tabs = {}
        for chave, (ck, nome, obrig, opcional) in self.ARQUIVOS.items():
            fid = self.file_id(chave)
            if not fid:
                if opcional:
                    tabs[chave] = None
                    continue
                raise ErroContrato("%s não configurado" % ck)
            t = self.drive.baixar(fid, chave + ".csv")
            self.md5s[chave] = hashlib.md5(t.encode("utf-8")).hexdigest()
            tabs[chave] = Tabela(t, nome, obrig)
        return decs, tabs

    def _contagem_recibos(self):
        c = {}
        for r in self.drive.listar(self.cfg["recibos_folderId"]):
            c[r.get("name")] = c.get(r.get("name"), 0) + 1
        for nome, n in sorted(c.items()):
            if n > 1:
                self.aviso("recibo duplicado em recibos/: %s (%d arquivos)" % (nome, n))
        return c

    def _recibo(self, did, hash_, resultado, motivo, link=""):
        r = {"decision_id": did, "snapshot_hash": hash_, "resultado": resultado, "motivo": motivo,
             "processado_em": agora_iso(self.agora()), "agente": self.cfg.get("agente", self.AGENTE)}
        if link:
            r["link"] = link
        return r

    def _criar_recibo(self, did, recibo, conferir_antes):
        """True se o recibo existe ao final; False se ficou pendente."""
        if self.teste:
            return True
        nome = did + ".json"
        os.makedirs(os.path.join(self.drive.workdir, "recibos"), exist_ok=True)
        rel = os.path.join("recibos", nome)
        with open(os.path.join(self.drive.workdir, rel), "w", encoding="utf-8") as f:
            json.dump(recibo, f, ensure_ascii=False, indent=2)
        if conferir_antes:
            existentes = self.drive.listar(self.cfg["recibos_folderId"], nome)
            if existentes:
                if len(existentes) > 1:
                    self.aviso("recibo duplicado: %s (%d arquivos); não criei outro" % (nome, len(existentes)))
                self._fase(did, fase=F_RECIBO)
                return True
        try:
            self.drive.criar(nome, self.cfg["recibos_folderId"], rel)
        except ErroDrive as ex:
            existentes = self.drive.listar(self.cfg["recibos_folderId"], nome)
            if not existentes:
                self.aviso("%s: criação do recibo falhou (%s) e ele não existe; rode de novo" % (did, ex))
                return False
            if len(existentes) > 1:
                self.aviso("recibo duplicado: %s (%d arquivos); não criei outro" % (nome, len(existentes)))
            else:
                self.aviso("%s: create respondeu erro, mas o recibo existe; considerado feito" % did)
        self._fase(did, fase=F_RECIBO)
        return True

    # ---------------- validação

    def avaliar(self, dec, modelo, decididas):
        """{"ok": True, "item", "comentario"} ou {"ok": False, "motivo"}."""
        def rej(m):
            return {"ok": False, "motivo": m}

        tipo = dec["tipo_item"]
        if tipo not in self.REGRAS:
            return rej("tipo_item inválido")
        if not dec["item_id"].startswith(tipo + ":") or len(dec["item_id"]) <= len(tipo) + 1:
            return rej("item_id inválido")
        h = dec["snapshot_hash"].lower()
        if not re.match(r"^[0-9a-f]{64}$", h):
            return rej("snapshot_hash inválido")
        outra = decididas.get((dec["item_id"], h))
        if outra and outra != dec["id"]:
            return rej("decisão duplicada: esta versão já foi decidida")
        item = modelo.get(dec["item_id"])
        if not item:
            return rej("item não existe mais nos arquivos do %s" % self.AGENTE)
        if item["snapshot_hash"] != h and h not in item.get("hashes_alternativos", ()):
            return rej("versão desatualizada")
        regra = self.REGRAS[tipo].get(dec["decisao"])
        if not regra:
            return rej("decisão desconhecida")
        if item["estado"] not in regra[0]:
            return rej("estado %s não aceita decisão" % (item.get("estado_texto") or item["estado"] or "vazio"))
        try:
            com = parse_comentario(dec.get("comentario", ""), regra[1])
        except ValueError as e:
            return rej("comentario inválido: %s" % e)
        return {"ok": True, "item": item, "comentario": com}

    # ---------------- --plano

    def plano(self):
        res = {"modo": "plano", "teste": self.teste, "acoes": [], "rejeitadas": [], "pendentes": [],
               "ja_com_recibo": 0, "avisos": self.avisos}
        decs, tabs = self._carregar()
        modelo = self.montar(tabs)
        recibos = self._contagem_recibos()
        decididas = self.ledger.decididas()
        for d in decs:
            did = d["id"]
            if recibos.get(did + ".json"):
                res["ja_com_recibo"] += 1
                continue
            e = self.ledger.get(did)
            if e and e.get("fase") == F_RECIBO:
                self.aviso("ledger diz recibo criado para %s, mas ele não aparece em recibos/; não recriei" % did)
                continue
            if e and e.get("fase") == F_REJEITADA and e.get("recibo"):
                ok = self._criar_recibo(did, e["recibo"], conferir_antes=True)
                (res["rejeitadas"] if ok else res["pendentes"]).append({"decision_id": did, "motivo": e["recibo"]["motivo"]})
                continue
            if e and e.get("fase") in (F_CONFIRMANDO, F_ATUALIZADA):
                res["pendentes"].append({"decision_id": did, "motivo": "confirmação incompleta; rode --confirmar de novo"})
                continue
            av = self.avaliar(d, modelo, decididas)
            if not av["ok"]:
                recibo = self._recibo(did, d["snapshot_hash"], "rejeitado", av["motivo"])
                self._fase(did, fase=F_REJEITADA, item_id=d["item_id"], snapshot_hash=d["snapshot_hash"].lower(), recibo=recibo)
                ok = self._criar_recibo(did, recibo, conferir_antes=False)
                (res["rejeitadas"] if ok else res["pendentes"]).append({"decision_id": did, "motivo": av["motivo"]})
                continue
            acao = dict({"decision_id": did, "item_id": d["item_id"], "decisao": d["decisao"],
                         "snapshot_hash": d["snapshot_hash"].lower()}, **self.montar_acao(d, av["item"], av["comentario"]))
            if e and e.get("fase") == F_PLANEJADA:
                acao["ja_planejada"] = True
            else:
                self._fase(did, fase=F_PLANEJADA, item_id=d["item_id"], snapshot_hash=d["snapshot_hash"].lower(),
                           decisao=d["decisao"], acao=acao["acao"])
            decididas[(d["item_id"], d["snapshot_hash"].lower())] = did
            res["acoes"].append(acao)
        return res

    # ---------------- --confirmar

    def confirmar(self, did, link=""):
        res = {"modo": "confirmar", "teste": self.teste, "decision_id": did, "resultado": None, "avisos": self.avisos}
        if link and not re.match(r"^https?://\S+$", link):
            raise ErroContrato("link deve começar com http:// ou https://")
        decs, tabs = self._carregar()
        d = next((x for x in decs if x["id"] == did), None)
        if d is None:
            raise ErroContrato("decisão %s não existe em decisoes.csv com modulo=%s" % (did, self.MODULO))
        nome = did + ".json"
        existentes = self.drive.listar(self.cfg["recibos_folderId"], nome)
        if existentes:
            if len(existentes) > 1:
                self.aviso("recibo duplicado: %s (%d arquivos); não criei outro" % (nome, len(existentes)))
            if not self.teste and (self.ledger.get(did) or {}).get("fase") != F_RECIBO:
                self._fase(did, fase=F_RECIBO)
            res["resultado"] = "ja_existia"
            return res

        e = self.ledger.get(did) or {}
        if e.get("fase") == F_REJEITADA:
            raise ErroContrato("decisão %s foi rejeitada no plano (%s); nada a confirmar" % (did, e["recibo"]["motivo"]))
        if e.get("fase") == F_ATUALIZADA:
            ok = self._criar_recibo(did, e["recibo"], conferir_antes=True)
            res.update(resultado="aplicado" if ok else "pendente", recibo=e["recibo"], retomada=True)
            return res
        if e.get("fase") == F_CONFIRMANDO:
            t = tabs.get(e.get("arquivo"))
            if t is not None:
                atuais = set(t.corpo(i) for i in range(1, len(t.regs)))
                if e.get("registros_depois") and all(r in atuais for r in e["registros_depois"]):
                    if not self.teste:
                        self._fase(did, fase=F_ATUALIZADA)
                    ok = self._criar_recibo(did, e["recibo"], conferir_antes=True)
                    res.update(resultado="aplicado" if ok else "pendente", recibo=e["recibo"], retomada=True)
                    return res
            # upload não chegou: refazer a confirmação do zero

        modelo = self.montar(tabs)
        av = self.avaliar(d, modelo, self.ledger.decididas())
        if not av["ok"]:
            raise ErroContrato("não dá para confirmar %s: %s. Nada foi gravado; se o agente já agiu, corrija o "
                               "arquivo à mão" % (did, av["motivo"]))
        quando = agora_iso(self.agora())
        chave, mudancas, motivo, estado_novo = self.aplicar(d, av["item"], av["comentario"], tabs, quando)
        tab = tabs[chave]
        for indice, valores in mudancas:
            tab.substituir(indice, valores)
        depois = [tab.corpo(i) for i, _ in mudancas]
        recibo = self._recibo(did, d["snapshot_hash"].lower(), "aplicado", motivo, link)
        res["recibo"] = recibo
        res["estado_novo"] = estado_novo
        if self.teste:
            res["resultado"] = "aplicado (teste, nada gravado)"
            return res
        self._fase(did, fase=F_CONFIRMANDO, item_id=d["item_id"], snapshot_hash=d["snapshot_hash"].lower(),
                   decisao=d["decisao"], arquivo=chave, registros_depois=depois, recibo=recibo)
        fid = self.file_id(chave)
        atual = self.drive.md5(fid)
        if atual and atual != self.md5s.get(chave):
            self.aviso("%s mudou no Drive durante a execução; parei sem gravar" % tab.nome)
            res["resultado"] = "pendente"
            return res
        rel = chave + "-novo.csv"
        with open(os.path.join(self.drive.workdir, rel), "w", encoding="utf-8", newline="") as f:
            f.write(tab.texto())
        try:
            self.drive.atualizar(fid, rel)
        except ErroDrive as ex:
            self.aviso("falha ao atualizar %s (%s); rode --confirmar de novo" % (tab.nome, ex))
            res["resultado"] = "pendente"
            return res
        self._fase(did, fase=F_ATUALIZADA)
        ok = self._criar_recibo(did, recibo, conferir_antes=False)
        res["resultado"] = "aplicado" if ok else "pendente"
        return res


# ---------------------------------------------------------------- CLI

def carregar_config(caminho, classe, padrao_trabalho, padrao_ledger):
    with open(caminho, encoding="utf-8") as f:
        cfg = json.load(f)
    obrig = ["decisoes_fileId", "recibos_folderId"] + [ck for ck, _, _, opc in classe.ARQUIVOS.values() if not opc]
    for k in obrig:
        if not cfg.get(k) or cfg[k] == "PREENCHER":
            raise ErroContrato("config sem %s" % k)
    base = os.path.dirname(os.path.abspath(caminho))
    for k, padrao in (("pasta_trabalho", padrao_trabalho), ("ledger_path", padrao_ledger)):
        v = cfg.get(k) or padrao
        cfg[k] = v if os.path.isabs(v) else os.path.join(base, v)
    return cfg


def executar(classe, nome_config, argv=None, runner=None, agora=None):
    m = classe.MODULO
    ap = argparse.ArgumentParser(description="Consumidor das decisões modulo=%s do Painel Grupo Smart" % m)
    ap.add_argument("--config", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), nome_config))
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--plano", action="store_true", help="lista em JSON as ações para o agente")
    g.add_argument("--confirmar", metavar="DECISION_ID", help="registra no ledger a ação que o agente já fez")
    ap.add_argument("--link", default="", help="com --confirmar: link opcional da evidência (vai no recibo)")
    ap.add_argument("--teste", action="store_true", help="só leitura: não grava Drive, ledger nem recibo")
    ap.add_argument("--ledger", help="caminho do ledger (sobrepõe a config)")
    a = ap.parse_args(argv)
    try:
        cfg = carregar_config(a.config, classe, "trabalho-" + m, "ledger-%s.json" % m)
    except (OSError, ValueError, ErroContrato) as e:
        print("erro de configuração: %s" % e, file=sys.stderr)
        return 3
    if a.ledger:
        cfg["ledger_path"] = a.ledger
    os.makedirs(cfg["pasta_trabalho"], exist_ok=True)
    drive = Drive(cfg["pasta_trabalho"], runner or runner_subprocess(cfg.get("gws_bin", "gws")))
    c = classe(cfg, drive, Ledger(cfg["ledger_path"], somente_leitura=a.teste), teste=a.teste, agora=agora)
    try:
        if a.confirmar:
            res = c.confirmar(a.confirmar, a.link)
            rc = 0 if res["resultado"] != "pendente" else 1
        else:
            res = c.plano()
            rc = 1 if res["pendentes"] else 0
    except ErroAuth as e:
        print("ERRO DE AUTENTICAÇÃO no Google Drive: %s. Parei tudo; reconecte o Drive e rode de novo." % e, file=sys.stderr)
        return 2
    except ErroContrato as e:
        print("erro: %s" % e, file=sys.stderr)
        return 3
    except ErroDrive as e:
        print("falha no Drive: %s" % e, file=sys.stderr)
        return 1
    print(json.dumps(res, ensure_ascii=False, indent=2))
    return rc

# ==================== BASE V3 (fim) ====================


# ---------------------------------------------------------------- módulo Finanças (montarFinancas de src/Lib.gs)

AGENTE = "Assistente Financeiro"
ESTADOS_CONTA = ((r"^a pagar", "a_pagar"), (r"^pag[oa]", "pago"), (r"^(em atraso|atrasad|vencid)", "atraso"),
                 (r"^sem confirma", "sem_confirmacao"))


def tipo_codigo(c):
    s = trim_js(c or "")
    if s.startswith("000201"):
        return "pix"
    if len(re.sub(r"[^0-9]", "", s)) >= 44 and re.match(r"^[0-9\s.\-]+$", s):
        return "barras"
    return "texto" if s else ""


def consertar(o, valores, cab):
    """consertarLinha: só no formato atual (última coluna sem nome). Devolve (objeto, valores, consertada)."""
    if not cab or cab[-1] != "":
        return o, valores, False
    l = [o.get(k, "") for k in cab]
    mudou, i = False, 0
    while i < len(l) - 1:
        if re.search(r"R\$\s?[0-9.]+$", l[i]) and re.match(r"^[0-9]{2}(?![0-9])", l[i + 1]):
            l[i:i + 2] = [l[i] + "," + l[i + 1]]
            l.append("")
            mudou = True
        i += 1
    if not mudou:
        return o, valores, False
    r = {k: trim_js(l[j] if j < len(l) else "") for j, k in enumerate(cab)}
    return r, [r[k] for k in cab], True


def lista_nomes(t):
    return [trim_js(x) for x in re.split(r"[;,]", t or "") if trim_js(x)]


def valor_br(v):
    inteiro, cent = ("%.2f" % float(v)).split(".")
    return "R$ " + "{:,}".format(int(inteiro)).replace(",", ".") + "," + cent


class ConsumidorFinancas(Consumidor):
    MODULO = "financas"
    AGENTE = AGENTE
    ARQUIVOS = {
        "contas": ("contas_fileId", "Contas.csv", ["emissor", "mes_ref", "valor", "vencimento", "estado"], False),
        "rateios": ("rateios_fileId", "Rateios.csv", ["mes_ref", "recebidos"], True),
        "recebidas": ("recebidas_fileId", "contas-recebidas.csv", ["emissor", "codigo_ou_pix", "message_id"], True),
    }
    REGRAS = {
        "conta": {"paguei": (["a_pagar", "atraso", "sem_confirmacao", "outro"], [("data", False), ("valor", False), ("texto", False)])},
        "rateio": {"recebi_mais_um": (["aberto"], [("texto", False)])},
    }

    def montar(self, tabs):
        modelo = {}
        if tabs.get("recebidas") is None:
            self.aviso("recebidas_fileId não configurado: o hash das contas com código ou PDF da recebida vai divergir do painel")
        recebidas = []
        for _, r, _ in (tabs["recebidas"].linhas() if tabs.get("recebidas") else []):
            if not (r.get("emissor") or r.get("message_id")):
                continue
            recebidas.append({"codigo": r.get("codigo_ou_pix", ""), "tipo": tipo_codigo(r.get("codigo_ou_pix")),
                              "pdf": r.get("pdf_fileId", ""), "mid": r.get("message_id", "")})
        t = tabs["contas"]
        # Desde a v3.2.0 o servidor passa o cabeçalho à Lib: a linha do formato atual quebrada pela vírgula do valor
        # é consertada antes do hash (consertarLinha). Decisões gravadas pelo painel até a v3.1.0 usavam o hash da
        # linha crua; esse hash continua aceito (hashes_alternativos).
        def hash_conta(x):
            texto = (x.get("link") or "") + " " + (x.get("estado") or "")
            mid, rec = x.get("message_id", ""), None
            for r in recebidas:
                if r["mid"] and (r["mid"] == mid if mid else r["mid"] in texto):
                    rec = r
            m = re.search(r"\bpdf\s+([A-Za-z0-9_-]{25,})", x.get("link") or "", re.A)
            pdf = x.get("pdf_fileId", "") or (m.group(1) if m else "") or (rec["pdf"] if rec else "")
            cod_col = x.get("codigo", "")
            if tipo_codigo(cod_col) in ("pix", "barras"):
                codigo = cod_col
            elif rec and rec["tipo"] in ("pix", "barras"):
                codigo = rec["codigo"]
            else:
                codigo = ""
            pago = parse_data(x.get("pago_em"))
            return sha256(canonico("conta", [x["emissor"], x.get("mes_ref"), x.get("valor"), x.get("vencimento"), x.get("forma"),
                                             x.get("estado"), x.get("link"), dia_iso(pago) if pago else "", codigo, pdf]))

        linhas = []
        for i, o, v in t.linhas():
            o2, v2, cons = consertar(o, v, t.cab)
            if o2.get("emissor"):
                linhas.append((i, o2, v2, cons, o))
        for i, x, v, cons, cru in ultima_por(linhas, lambda y: y[1]["emissor"] + "|" + y[1].get("mes_ref", "")):
            h = hash_conta(x)
            alt = [hash_conta(cru)] if cons and cru.get("emissor") else []
            k = x["emissor"] + "|" + x.get("mes_ref", "")
            modelo["conta:" + k] = {
                "tipo_item": "conta", "estado": classificar(x.get("estado"), ESTADOS_CONTA), "estado_texto": x.get("estado", ""),
                "indice": i, "valores": v, "consertada": cons, "emissor": x["emissor"], "mes_ref": x.get("mes_ref", ""),
                "valor": x.get("valor", ""), "vencimento": x.get("vencimento", ""), "forma": x.get("forma", ""),
                "snapshot_hash": h, "hashes_alternativos": [a for a in alt if a != h],
            }
        tr = tabs.get("rateios")
        rateios = [y for y in (tr.linhas() if tr else []) if y[1].get("mes_ref")]
        if rateios:
            i, r, v = sorted(rateios, key=lambda y: y[1]["mes_ref"])[-1]
            novo = any(c in tr.cab for c in ("emissor", "pagaram", "pagantes"))
            col_nomes = "pagaram" if "pagaram" in r else ("pagantes" if "pagantes" in r else None)
            pagaram = lista_nomes(r.get(col_nomes, "") if col_nomes else "")
            m = re.search(r"([0-9]+)\s*/\s*([0-9]+)", r.get("recebidos", ""))
            rec = max(int(m.group(1)), len(pagaram)) if m else len(pagaram)
            de = int(m.group(2)) if m else None
            enviado = re.match(r"^s", r.get("enviado", ""), re.I) is not None
            campos5 = [r.get(c) for c in ("mes_ref", "total", "por_pessoa", "enviado", "recebidos")]
            # Formato novo: o hash leva emissor e pagaram (docs/contrato-financas.md; servidor desde a v3.2.0).
            # O de 5 campos, que o painel gravava até a v3.1.0 no formato novo, continua aceito.
            campos = campos5 + [r.get("emissor"), r.get(col_nomes) if col_nomes else ""] if novo else campos5
            alt = [sha256(canonico("rateio", campos5))] if novo else []
            modelo["rateio:" + r["mes_ref"]] = {
                "tipo_item": "rateio", "estado": "nao_enviado" if not enviado else ("completo" if de is not None and rec >= de else "aberto"),
                "indice": i, "valores": v, "mes_ref": r["mes_ref"], "recebidos": rec, "de": de, "match": m,
                "recebidos_texto": r.get("recebidos", ""), "col_nomes": col_nomes, "pagaram": pagaram,
                "emissor": r.get("emissor") or "SKY", "total": r.get("total", ""), "por_pessoa": r.get("por_pessoa", ""),
                "snapshot_hash": sha256(canonico("rateio", campos)), "hashes_alternativos": alt,
            }
        return modelo

    def montar_acao(self, d, item, com):
        if d["tipo_item"] == "conta":
            return {"acao": "registrar_pagamento", "emissor": item["emissor"], "mes_ref": item["mes_ref"],
                    "data": com.get("data") or dia_da_decisao(d, self.agora()), "valor": com.get("valor", ""),
                    "valor_conta": item["valor"], "vencimento": item["vencimento"], "texto": com.get("texto", ""),
                    "instrucao": "lançar o pagamento em Lancamentos.csv se ainda não houver; depois rode --confirmar "
                                 "(o script marca a conta como paga em Contas.csv)"}
        return {"acao": "registrar_rateio_recebido", "mes_ref": item["mes_ref"], "emissor": item["emissor"],
                "nome": com.get("texto", ""), "recebidos": item["recebidos"], "de": item["de"],
                "instrucao": "conferir o recebimento e rodar --confirmar (o script soma 1 em recebidos)"}

    def aplicar(self, d, item, com, tabs, quando):
        texto = com.get("texto", "")
        if d["tipo_item"] == "conta":
            t = tabs["contas"]
            data = com.get("data") or dia_da_decisao(d, self.agora())
            # Coluna estado só com "pago"; a data vai em pago_em (coluna do ledger); valor pago e texto, no recibo.
            estado = "pago"
            vals = t.valores_com(item["valores"], {"estado": estado, "pago_em": data})
            motivo = "conta %s %s paga em %s" % (item["emissor"], item["mes_ref"], data)
            if com.get("valor"):
                motivo += " (valor pago %s)" % valor_br(com["valor"])
            if texto:
                motivo += ": %s" % texto
            if item["consertada"]:
                motivo += "; linha com valor sem aspas regravada com aspas"
            return "contas", [(item["indice"], vals)], motivo, estado
        t = tabs["rateios"]
        novo_n = item["recebidos"] + 1
        m = item["match"]
        if m:
            rt = item["recebidos_texto"]
            recebidos = rt[:m.start()] + "%d/%d" % (novo_n, item["de"]) + rt[m.end():]
        else:
            recebidos = str(novo_n)
        mud = {"recebidos": recebidos}
        motivo = "rateio %s: recebidos %s" % (item["mes_ref"], recebidos)
        if texto:
            motivo += " (de %s)" % texto
            if item["col_nomes"]:
                atual = item["valores"][t.col[item["col_nomes"]]] if t.col[item["col_nomes"]] < len(item["valores"]) else ""
                mud[item["col_nomes"]] = (trim_js(atual) + "; " + texto) if trim_js(atual) else texto
        return "rateios", [(item["indice"], t.valores_com(item["valores"], mud))], motivo, recebidos


def main(argv=None, runner=None, agora=None):
    return executar(ConsumidorFinancas, "config.financas.json", argv, runner, agora)


if __name__ == "__main__":
    sys.exit(main())
