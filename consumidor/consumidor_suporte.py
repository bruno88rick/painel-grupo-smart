#!/usr/bin/env python3
"""Consumidor das decisões modulo=suporte do Painel Grupo Smart.

Roda do lado do Agente de Suporte RN Sports. Só biblioteca padrão do Python 3.
Autocontido (não importa o consumidor de anúncios) para poder ser publicado sozinho.

Duas fases:
  --plano                       lê decisoes.csv (modulo=suporte), confere cada decisão contra a linha
                                atual de Rascunhos-painel.csv e imprime em JSON as ações para o agente
                                (enviar_resposta, refazer, recusar). Decisões com versão velha ou
                                inválidas recebem recibo rejeitado.
  --confirmar <decision_id> <link>
                                depois que o agente fez a ação no Zendesk: atualiza o estado da linha em
                                Rascunhos-painel.csv (tabela do contrato) e grava recibos/<decision_id>.json.
  --teste                       só leitura: não grava Drive, ledger nem recibo (sozinho = --plano --teste).

Este script NUNCA chama o Zendesk. Contrato: docs/contrato-suporte.md.

Códigos de saída: 0 ok; 1 pendência/erro recuperável; 2 erro de autenticação no Drive (parou tudo);
3 configuração, argumento ou arquivo fora do contrato.
"""

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

AGENTE = "Agente de Suporte RN Sports"
TZ_SP = timezone(timedelta(hours=-3))
SEP = "\u001f"

CABECALHO_RASCUNHOS = ("id_chamado,versao,evento,tipo,cliente_primeiro_nome,pedido_resumo,rascunho_texto,"
                       "estado,zendesk_link,prazo_evento,atualizado_em").split(",")
CAMPOS_HASH = CABECALHO_RASCUNHOS[:-1]  # atualizado_em não entra
CABECALHO_DECISOES = "id,quando,modulo,item_id,tipo_item,versao,arte_fileId,snapshot_hash,decisao,comentario,origem".split(",")

# Mesmo conjunto de String.prototype.trim() do JavaScript (str.strip() puro difere).
_JS_WS = ("\t\n\u000b\u000c\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009"
          "\u200a\u2028\u2029\u202f\u205f\u3000\ufeff")

# Fases do ledger por decisão
F_REJEITADA = "rejeitada"          # recibo rejeitado ainda não criado
F_PLANEJADA = "planejada"          # ação entregue ao agente
F_CONFIRMANDO = "confirmando"      # agente confirmou; hash_depois previsto gravado antes do upload
F_ATUALIZADA = "rascunho_atualizado"
F_RECIBO = "recibo_criado"
FASES_VALIDAS = (F_PLANEJADA, F_CONFIRMANDO, F_ATUALIZADA, F_RECIBO)


class ErroAuth(Exception):
    pass


class ErroDrive(Exception):
    pass


class ErroContrato(Exception):
    pass


# ---------------------------------------------------------------- hash (igual a canonicoResposta de src/Lib.gs)

def trim_js(s):
    return s.strip(_JS_WS)


def normalizar(v):
    s = "" if v is None else str(v)
    return trim_js(s.replace("\r\n", "\n").replace("\r", "\n"))


def canonico_resposta(linha):
    return SEP.join(["resposta"] + [normalizar(linha.get(c)) for c in CAMPOS_HASH])


def hash_resposta(linha):
    return hashlib.sha256(canonico_resposta(linha).encode("utf-8")).hexdigest()


def classificar_estado(estado):
    """Mesma regra do painel: sem acento, minúsculas, pelo começo."""
    s = unicodedata.normalize("NFD", estado or "")
    s = trim_js("".join(ch for ch in s if not ("\u0300" <= ch <= "\u036f")).lower())
    for pref, nome in (("aguardando", "aguardando_aprovo"), ("aprovad", "aprovado"), ("ajuste", "ajuste"),
                       ("recusad", "recusado"), ("enviad", "enviado")):
        if s.startswith(pref):
            return nome
    return "outro"


# ---------------------------------------------------------------- CSV preservando bytes

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


def ler_registro(raw):
    corpo, _ = separar_terminador(raw)
    if trim_js(corpo) == "":
        return []
    return next(csv.reader(io.StringIO(corpo, newline=""), strict=True))


def escrever_registro(valores, terminador):
    buf = io.StringIO(newline="")
    csv.writer(buf, lineterminator="\n").writerow(valores)
    return buf.getvalue()[:-1] + terminador


class Rascunhos:
    """Rascunhos-painel.csv em memória; só a linha alterada é reserializada."""

    def __init__(self, texto):
        self.bom = texto.startswith("\ufeff")
        self.regs = dividir_registros(texto[1:] if self.bom else texto)
        if not self.regs:
            raise ErroContrato("Rascunhos-painel.csv vazio")
        if [trim_js(c) for c in ler_registro(self.regs[0])] != CABECALHO_RASCUNHOS:
            raise ErroContrato("cabeçalho de Rascunhos-painel.csv diferente do contrato")
        self.term = separar_terminador(self.regs[0])[1] or "\r\n"

    def texto(self):
        return ("\ufeff" if self.bom else "") + "".join(self.regs)

    def _linhas(self, id_chamado):
        out = []
        for i in range(1, len(self.regs)):
            v = ler_registro(self.regs[i])
            if v and trim_js(v[0]) == id_chamado and len(v) == len(CABECALHO_RASCUNHOS):
                out.append((i, dict(zip(CABECALHO_RASCUNHOS, v))))
        return out

    def ultima(self, id_chamado):
        """Maior versão do chamado (empate: a última no arquivo), como o painel."""
        melhor = None
        for i, l in self._linhas(id_chamado):
            if melhor is None or _int(l["versao"]) >= _int(melhor[1]["versao"]):
                melhor = (i, l)
        return melhor

    def da_versao(self, id_chamado, versao):
        achou = None
        for i, l in self._linhas(id_chamado):
            if normalizar(l["versao"]) == versao:
                achou = (i, l)
        return achou

    def substituir(self, indice, linha):
        _, term = separar_terminador(self.regs[indice])
        self.regs[indice] = escrever_registro([linha.get(c, "") for c in CABECALHO_RASCUNHOS], term or self.term)

    def acrescentar(self, linha):
        if self.regs and not separar_terminador(self.regs[-1])[1]:
            self.regs[-1] += self.term
        self.regs.append(escrever_registro([linha.get(c, "") for c in CABECALHO_RASCUNHOS], self.term))


def _int(s):
    try:
        return int(normalizar(s))
    except ValueError:
        return 0


def ler_decisoes(texto):
    if texto.startswith("\ufeff"):
        texto = texto[1:]
    linhas = [l for l in csv.reader(io.StringIO(texto, newline="")) if l and not (len(l) == 1 and trim_js(l[0]) == "")]
    if not linhas:
        raise ErroContrato("decisoes.csv vazio")
    if [trim_js(c) for c in linhas[0]] != CABECALHO_DECISOES:
        raise ErroContrato("cabeçalho de decisoes.csv diferente do contrato")
    return [{c: (trim_js(l[i]) if i < len(l) else "") for i, c in enumerate(CABECALHO_DECISOES)} for l in linhas[1:]]


# ---------------------------------------------------------------- comentario (igual a parseComentarioV3)

REGRAS = {"aprovar": (False, False), "refazer": (True, True), "recusar": (True, False)}  # (aceita texto, obrigatório)


def parse_comentario(comentario, decisao):
    aceita, obrig = REGRAS[decisao]
    s = trim_js(re.sub(r"[\r\n]+", " ", comentario or ""))
    r = {}
    if s:
        if not s.startswith("texto="):
            par = s.split(";", 1)[0]
            if not re.match(r"^\w+=", par):
                raise ValueError('fora do formato (esperado chave=valor): "%s"' % par)
            raise ValueError('"%s" não vale para esta decisão' % par.split("=", 1)[0])
        if not aceita:
            raise ValueError("esta decisão não aceita texto")
        r["texto"] = trim_js(s[6:])
        if len(r["texto"]) > 1500:
            raise ValueError("texto muito longo")
    if obrig and not r.get("texto"):
        raise ValueError("texto obrigatório")
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


# ---------------------------------------------------------------- validação

def avaliar(dec, rascunhos, decididas):
    """Retorna {"ok": True, "linha", "indice", "comentario", "id_chamado"} ou {"ok": False, "motivo"}."""
    def rej(m):
        return {"ok": False, "motivo": m}

    if dec["tipo_item"] != "resposta":
        return rej("tipo_item inválido")
    m = re.match(r"^resposta:(.+)$", dec["item_id"])
    if not m:
        return rej("item_id inválido")
    idc = trim_js(m.group(1))
    h = dec["snapshot_hash"].lower()
    if not re.match(r"^[0-9a-f]{64}$", h):
        return rej("snapshot_hash inválido")
    outra = decididas.get((dec["item_id"], h))
    if outra and outra != dec["id"]:
        return rej("decisão duplicada: esta versão já foi decidida")
    achado = rascunhos.ultima(idc)
    if not achado:
        return rej("chamado não existe em Rascunhos-painel.csv")
    indice, linha = achado
    if hash_resposta(linha) != h:
        return rej("versão desatualizada")
    if dec.get("versao") and normalizar(dec["versao"]) != normalizar(linha["versao"]):
        return rej("versão desatualizada")
    if dec["decisao"] not in REGRAS:
        return rej("decisão desconhecida")
    if classificar_estado(linha["estado"]) != "aguardando_aprovo":
        return rej("estado %s não aceita decisão" % (normalizar(linha["estado"]) or "vazio"))
    try:
        com = parse_comentario(dec.get("comentario", ""), dec["decisao"])
    except ValueError as e:
        return rej("comentario inválido: %s" % e)
    return {"ok": True, "linha": linha, "indice": indice, "comentario": com, "id_chamado": idc}


def montar_acao(dec, av):
    l, did, idc = av["linha"], dec["id"], av["id_chamado"]
    base = {"decision_id": did, "id_chamado": idc, "versao": normalizar(l["versao"]),
            "snapshot_hash": dec["snapshot_hash"].lower(), "zendesk_link": normalizar(l["zendesk_link"])}
    if dec["decisao"] == "aprovar":
        # texto exato do campo, só com CRLF/CR convertidos para LF
        return dict(base, acao="enviar_resposta", texto=l["rascunho_texto"].replace("\r\n", "\n").replace("\r", "\n"),
                    instrucao="enviar como resposta pública, sem mudar o texto")
    if dec["decisao"] == "refazer":
        return dict(base, acao="refazer", texto=av["comentario"]["texto"],
                    instrucao="reescrever o rascunho com o pedido e registrar nova versão")
    return dict(base, acao="recusar", motivo=av["comentario"].get("texto") or "recusado pelo Bruno",
                instrucao="não enviar; registrar o motivo na nota interna")


# ---------------------------------------------------------------- consumidor

class Consumidor:
    def __init__(self, cfg, drive, ledger, teste=False, agora=None, log=None):
        self.cfg = cfg
        self.drive = drive
        self.ledger = ledger
        self.teste = teste
        self.agora = agora or (lambda: datetime.now(TZ_SP))
        self.log = log or (lambda m: print(m, file=sys.stderr))
        self.avisos = []

    def aviso(self, m):
        self.avisos.append(m)
        self.log("aviso: " + m)

    def _fase(self, did, **campos):
        self.ledger.gravar(did, agora_iso(self.agora()), **campos)

    def _carregar(self):
        texto = self.drive.baixar(self.cfg["decisoes_fileId"], "decisoes.csv")
        decs, vistos = [], set()
        for d in ler_decisoes(texto):
            if d["modulo"] != "suporte" or not d["id"]:
                continue
            if d["id"] in vistos:
                self.aviso("id repetido em decisoes.csv: %s (só a primeira linha vale)" % d["id"])
                continue
            vistos.add(d["id"])
            decs.append(d)
        rid = self.cfg.get("rascunhos_fileId") or ""
        if not rid or rid == "PREENCHER":
            raise ErroContrato("rascunhos_fileId não configurado")
        texto_r = self.drive.baixar(rid, "rascunhos.csv")
        self.md5_esperado = hashlib.md5(texto_r.encode("utf-8")).hexdigest()
        return decs, Rascunhos(texto_r)

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
             "processado_em": agora_iso(self.agora()), "agente": self.cfg.get("agente", AGENTE)}
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

    # ---------------- --plano

    def plano(self):
        res = {"modo": "plano", "teste": self.teste, "acoes": [], "rejeitadas": [], "pendentes": [],
               "ja_com_recibo": 0, "avisos": self.avisos}
        decs, rasc = self._carregar()
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
            av = avaliar(d, rasc, decididas)
            if not av["ok"]:
                recibo = self._recibo(did, d["snapshot_hash"], "rejeitado", av["motivo"])
                self._fase(did, fase=F_REJEITADA, item_id=d["item_id"], snapshot_hash=d["snapshot_hash"].lower(), recibo=recibo)
                ok = self._criar_recibo(did, recibo, conferir_antes=False)
                (res["rejeitadas"] if ok else res["pendentes"]).append({"decision_id": did, "motivo": av["motivo"]})
                continue
            acao = montar_acao(d, av)
            if e and e.get("fase") == F_PLANEJADA:
                acao["ja_planejada"] = True
            else:
                self._fase(did, fase=F_PLANEJADA, item_id=d["item_id"], snapshot_hash=d["snapshot_hash"].lower(),
                           decisao=d["decisao"], id_chamado=av["id_chamado"], versao=acao["versao"])
            decididas[(d["item_id"], d["snapshot_hash"].lower())] = did
            res["acoes"].append(acao)
        return res

    # ---------------- --confirmar

    def confirmar(self, did, link, novo_texto=None):
        res = {"modo": "confirmar", "teste": self.teste, "decision_id": did, "resultado": None, "avisos": self.avisos}
        if link and not re.match(r"^https?://\S+$", link):
            raise ErroContrato("link deve começar com http:// ou https://")
        decs, rasc = self._carregar()
        d = next((x for x in decs if x["id"] == did), None)
        if d is None:
            raise ErroContrato("decisão %s não existe em decisoes.csv com modulo=suporte" % did)
        if d["decisao"] == "aprovar" and not link:
            raise ErroContrato("aprovar exige o link da resposta enviada no Zendesk")
        if novo_texto is not None and d["decisao"] != "refazer":
            raise ErroContrato("--novo-texto só vale para refazer")
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
        idc = trim_js(d["item_id"].split(":", 1)[1]) if ":" in d["item_id"] else ""
        if e.get("fase") == F_REJEITADA:
            raise ErroContrato("decisão %s foi rejeitada no plano (%s); nada a confirmar" % (did, e["recibo"]["motivo"]))
        if e.get("fase") == F_ATUALIZADA:
            ok = self._criar_recibo(did, e["recibo"], conferir_antes=True)
            res.update(resultado="aplicado" if ok else "pendente", recibo=e["recibo"], retomada=True)
            return res
        if e.get("fase") == F_CONFIRMANDO:
            achado = rasc.da_versao(idc, e.get("versao", ""))
            if achado and hash_resposta(achado[1]) == e.get("hash_depois"):
                if not self.teste:
                    self._fase(did, fase=F_ATUALIZADA)
                ok = self._criar_recibo(did, e["recibo"], conferir_antes=True)
                res.update(resultado="aplicado" if ok else "pendente", recibo=e["recibo"], retomada=True)
                return res
            # upload não chegou: refazer a confirmação do zero

        decididas = self.ledger.decididas()
        av = avaliar(d, rasc, decididas)
        if not av["ok"]:
            raise ErroContrato("não dá para confirmar %s: %s. Nada foi gravado; se o agente já agiu no Zendesk, "
                               "corrija Rascunhos-painel.csv à mão" % (did, av["motivo"]))
        linha, indice = dict(av["linha"]), av["indice"]
        quando = agora_iso(self.agora())
        dia = quando[:16].replace("T", " ")
        texto = av["comentario"].get("texto", "")
        nova_versao = None
        if d["decisao"] == "aprovar":
            linha["estado"] = "enviado em %s" % dia
            motivo = "resposta enviada no chamado %s" % idc
        elif d["decisao"] == "refazer":
            linha["estado"] = "ajuste pedido em %s: %s" % (dia, texto)
            motivo = "ajuste pedido no chamado %s: %s" % (idc, texto)
            if novo_texto is not None:
                nova_versao = dict(av["linha"], versao=str(_int(av["linha"]["versao"]) + 1), rascunho_texto=novo_texto,
                                   estado="aguardando_aprovo", atualizado_em=quando)
                motivo += " (rascunho versao %s registrado)" % nova_versao["versao"]
        else:
            linha["estado"] = "recusado em %s: %s" % (dia, texto or "recusado pelo Bruno")
            motivo = "recusada pelo Bruno no chamado %s" % idc + (": %s" % texto if texto else "")
        linha["atualizado_em"] = quando
        hash_depois = hash_resposta(linha)
        recibo = self._recibo(did, d["snapshot_hash"], "aplicado", motivo, link)
        res["recibo"] = recibo
        if self.teste:
            res["resultado"] = "aplicado (teste, nada gravado)"
            res["estado_novo"] = linha["estado"]
            return res
        self._fase(did, fase=F_CONFIRMANDO, item_id=d["item_id"], snapshot_hash=d["snapshot_hash"].lower(),
                   decisao=d["decisao"], id_chamado=idc, versao=normalizar(av["linha"]["versao"]),
                   hash_depois=hash_depois, recibo=recibo)
        rasc.substituir(indice, linha)
        if nova_versao:
            rasc.acrescentar(nova_versao)
        atual = self.drive.md5(self.cfg["rascunhos_fileId"])
        if atual and atual != self.md5_esperado:
            self.aviso("Rascunhos-painel.csv mudou no Drive durante a execução; parei sem gravar")
            res["resultado"] = "pendente"
            return res
        with open(os.path.join(self.drive.workdir, "rascunhos-novo.csv"), "w", encoding="utf-8", newline="") as f:
            f.write(rasc.texto())
        try:
            self.drive.atualizar(self.cfg["rascunhos_fileId"], "rascunhos-novo.csv")
        except ErroDrive as ex:
            self.aviso("falha ao atualizar Rascunhos-painel.csv (%s); rode --confirmar de novo" % ex)
            res["resultado"] = "pendente"
            return res
        self._fase(did, fase=F_ATUALIZADA)
        ok = self._criar_recibo(did, recibo, conferir_antes=False)
        res["resultado"] = "aplicado" if ok else "pendente"
        return res


# ---------------------------------------------------------------- CLI

def carregar_config(caminho):
    with open(caminho, encoding="utf-8") as f:
        cfg = json.load(f)
    for k in ("decisoes_fileId", "recibos_folderId"):
        if not cfg.get(k) or cfg[k] == "PREENCHER":
            raise ErroContrato("config sem %s" % k)
    base = os.path.dirname(os.path.abspath(caminho))
    for k, padrao in (("pasta_trabalho", "trabalho-suporte"), ("ledger_path", "ledger-suporte.json")):
        v = cfg.get(k) or padrao
        cfg[k] = v if os.path.isabs(v) else os.path.join(base, v)
    return cfg


def main(argv=None, runner=None, agora=None):
    ap = argparse.ArgumentParser(description="Consumidor das decisões de Suporte do Painel Grupo Smart (não chama o Zendesk)")
    ap.add_argument("--config", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.suporte.json"))
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--plano", action="store_true", help="lista em JSON as ações para o agente")
    g.add_argument("--confirmar", nargs=2, metavar=("DECISION_ID", "LINK"),
                   help="registra a ação feita pelo agente (LINK pode ser '' em refazer/recusar)")
    ap.add_argument("--novo-texto", metavar="ARQUIVO", help="com --confirmar de refazer: texto do novo rascunho (versao+1)")
    ap.add_argument("--teste", action="store_true", help="só leitura: não grava Drive, ledger nem recibo")
    ap.add_argument("--ledger", help="caminho do ledger (sobrepõe a config)")
    a = ap.parse_args(argv)
    try:
        cfg = carregar_config(a.config)
    except (OSError, ValueError, ErroContrato) as e:
        print("erro de configuração: %s" % e, file=sys.stderr)
        return 3
    if a.ledger:
        cfg["ledger_path"] = a.ledger
    novo_texto = None
    if a.novo_texto:
        with open(a.novo_texto, encoding="utf-8") as f:
            novo_texto = f.read().replace("\r\n", "\n").strip("\n")
    os.makedirs(cfg["pasta_trabalho"], exist_ok=True)
    drive = Drive(cfg["pasta_trabalho"], runner or runner_subprocess(cfg.get("gws_bin", "gws")))
    c = Consumidor(cfg, drive, Ledger(cfg["ledger_path"], somente_leitura=a.teste), teste=a.teste, agora=agora)
    try:
        if a.confirmar:
            res = c.confirmar(a.confirmar[0], a.confirmar[1], novo_texto)
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


if __name__ == "__main__":
    sys.exit(main())
