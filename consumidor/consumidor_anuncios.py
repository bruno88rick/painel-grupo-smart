#!/usr/bin/env python3
"""Consumidor das decisões modulo=anuncios do Painel Grupo Smart.

Roda do lado do Gestor de Tráfego. Só biblioteca padrão do Python 3. Autocontido.

  --plano                 lê decisoes.csv (modulo=anuncios), confere cada decisão contra a linha atual de
                          Propostas.csv (item, tipo, hash do snapshot, estado, comentario, verba) e imprime em
                          JSON as ações para o agente: programar_post, criar_campanha, pausar_campanha_meta,
                          refazer_post, refazer_campanha, registrar_recusa_post, registrar_recusa_campanha.
                          Não grava recibo de ação; decisões com versão velha ou inválidas recebem recibo rejeitado.
  --confirmar <decision_id> [--link URL]
                          depois que o agente executou a ação na Meta: grava o ledger, atualiza a linha em
                          Propostas.csv (só ela; as outras ficam byte a byte iguais) e cria recibos/<decision_id>.json.
  --teste                 só leitura: não grava Drive, ledger nem recibo (sozinho = --plano --teste).
  --dry-run               obsoleto: apelido de --teste (avisa no stderr).

Este script nunca publica, nunca chama a Meta e nunca aumenta verba. Contrato: docs/contrato-propostas.md.

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
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation

AGENTE = "Gestor de Tráfego"
TZ_SP = timezone(timedelta(hours=-3))  # São Paulo, sem horário de verão desde 2019
SEP = "\u001f"

CABECALHO_PROPOSTAS = (
    "id,tipo,empresa,pedido_id,versao,formato,contas,horario,midia_fileIds,legenda_1,legenda_2,"
    "legenda_escolhida,hashtags,campanha_id,verba_diaria,inicio,fim,publico_resumo,plano_fileId,"
    "estado,atualizado_em,plataforma_link"
).split(",")
CABECALHO_DECISOES = "id,quando,modulo,item_id,tipo_item,versao,arte_fileId,snapshot_hash,decisao,comentario,origem".split(",")

CAMPOS_POST = ["id", "versao", "midia_fileIds", "legenda_1", "legenda_2", "hashtags", "contas", "horario", "estado"]
CAMPOS_CAMPANHA = ["id", "versao", "verba_diaria", "inicio", "fim", "publico_resumo", "plano_fileId", "estado"]

ESTADOS_DECIDIVEIS = {
    ("post", "aprovar"): {"rascunho", "aguardando_aprovo"},
    ("post", "refazer"): {"rascunho", "aguardando_aprovo"},
    ("post", "recusar"): {"rascunho", "aguardando_aprovo"},
    ("campanha", "aprovar"): {"plano", "ajuste"},
    ("campanha", "refazer"): {"plano", "ajuste"},
    ("campanha", "recusar"): {"plano", "ajuste"},
    ("campanha", "pausar"): {"ativo"},
}

# Chaves permitidas do comentario por (tipo, decisao): {chave: obrigatória?}
REGRAS_COMENTARIO = {
    ("post", "aprovar"): {"legenda": True, "horario": False, "texto": False},
    ("post", "refazer"): {"texto": True},
    ("post", "recusar"): {"texto": False},
    ("campanha", "aprovar"): {"verba": False, "texto": False},
    ("campanha", "refazer"): {"texto": True},
    ("campanha", "recusar"): {"texto": False},
    ("campanha", "pausar"): {"texto": False},
}
ORDEM_CHAVES = ["legenda", "horario", "verba", "texto"]

# Mesmo conjunto de String.prototype.trim() do JavaScript. Não usar str.strip():
# o Python também remove U+001C..U+001F e U+0085, e não remove U+FEFF.
_JS_WS = "\t\n\u000b\u000c\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"


class ErroAuth(Exception):
    """Falha de autenticação no Drive: parar tudo."""


class ErroDrive(Exception):
    def __init__(self, msg, codigo=None, saida=""):
        super().__init__(msg)
        self.codigo = codigo
        self.saida = saida


class ErroContrato(Exception):
    """Arquivo ou configuração fora do contrato."""


# ---------------------------------------------------------------- hash

def trim_js(s):
    return s.strip(_JS_WS)


def normalizar(valor):
    s = "" if valor is None else str(valor)
    s = s.replace("\r\n", "\n").replace("\r", "\n")
    return trim_js(s)


def canonico_post(linha):
    return SEP.join(["post"] + [normalizar(linha.get(c)) for c in CAMPOS_POST])


def canonico_campanha(linha):
    return SEP.join(["campanha"] + [normalizar(linha.get(c)) for c in CAMPOS_CAMPANHA])


def sha256_hex(texto):
    return hashlib.sha256(texto.encode("utf-8")).hexdigest()


def hash_snapshot(linha, tipo=None):
    tipo = tipo or normalizar(linha.get("tipo"))
    if tipo == "post":
        return sha256_hex(canonico_post(linha))
    if tipo == "campanha":
        return sha256_hex(canonico_campanha(linha))
    raise ValueError("tipo desconhecido: %r" % tipo)


# ---------------------------------------------------------------- CSV com preservação de bytes

def dividir_registros(texto):
    """Divide o texto em registros brutos (com o terminador), respeitando aspas."""
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


def _separar_terminador(raw):
    if raw.endswith("\r\n"):
        return raw[:-2], "\r\n"
    if raw.endswith("\n"):
        return raw[:-1], "\n"
    return raw, ""


def ler_registro(raw):
    corpo, _ = _separar_terminador(raw)
    if corpo == "":
        return []
    return next(csv.reader(io.StringIO(corpo, newline=""), strict=True))


def escrever_registro(valores, terminador):
    buf = io.StringIO(newline="")
    csv.writer(buf, lineterminator="\n", quoting=csv.QUOTE_MINIMAL).writerow(valores)
    return buf.getvalue()[:-1] + terminador


class Propostas:
    """Propostas.csv em memória, regravando só a linha alterada."""

    def __init__(self, texto):
        self.bom = texto.startswith("\ufeff")
        corpo = texto[1:] if self.bom else texto
        self.regs = dividir_registros(corpo)
        if not self.regs:
            raise ErroContrato("Propostas.csv vazio")
        cab = [trim_js(c) for c in ler_registro(self.regs[0])]
        if cab != CABECALHO_PROPOSTAS:
            raise ErroContrato("cabeçalho de Propostas.csv diferente do contrato")

    def texto(self):
        return ("\ufeff" if self.bom else "") + "".join(self.regs)

    def _indices(self, item_id):
        out = []
        for i in range(1, len(self.regs)):
            vals = ler_registro(self.regs[i])
            if vals and trim_js(vals[0]) == item_id:
                out.append(i)
        return out

    def buscar(self, item_id):
        """Retorna (linha_dict, erro). erro em texto se não achou/duplicado/malformado."""
        idx = self._indices(item_id)
        if not idx:
            return None, "item não existe em Propostas.csv"
        if len(idx) > 1:
            return None, "id duplicado em Propostas.csv"
        vals = ler_registro(self.regs[idx[0]])
        if len(vals) != len(CABECALHO_PROPOSTAS):
            return None, "linha malformada em Propostas.csv"
        return dict(zip(CABECALHO_PROPOSTAS, vals)), None

    def substituir(self, item_id, linha):
        idx = self._indices(item_id)
        if len(idx) != 1:
            raise ErroContrato("não foi possível localizar %s para regravar" % item_id)
        _, term = _separar_terminador(self.regs[idx[0]])
        self.regs[idx[0]] = escrever_registro([linha.get(c, "") for c in CABECALHO_PROPOSTAS], term or "\r\n")


def ler_decisoes(texto):
    if texto.startswith("\ufeff"):
        texto = texto[1:]
    linhas = list(csv.reader(io.StringIO(texto, newline="")))
    linhas = [l for l in linhas if not (len(l) == 0 or (len(l) == 1 and trim_js(l[0]) == ""))]
    if not linhas:
        raise ErroContrato("decisoes.csv vazio")
    cab = [trim_js(c) for c in linhas[0]]
    if cab != CABECALHO_DECISOES:
        raise ErroContrato("cabeçalho de decisoes.csv diferente do contrato")
    out = []
    for l in linhas[1:]:
        d = {c: (trim_js(l[i]) if i < len(l) else "") for i, c in enumerate(CABECALHO_DECISOES)}
        out.append(d)
    return out


# ---------------------------------------------------------------- comentario

RE_HORARIO = re.compile(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$")
RE_VERBA = re.compile(r"^(0|[1-9]\d*)(\.\d+)?$")


def parse_comentario(comentario, tipo, decisao):
    """Parser estrito. Retorna dict com as chaves presentes ou lança ValueError."""
    regras = REGRAS_COMENTARIO.get((tipo, decisao))
    if regras is None:
        raise ValueError("decisão %s não vale para %s" % (decisao, tipo))
    s = comentario or ""
    res, pos, ultima = {}, 0, -1
    while pos < len(s):
        if s.startswith("texto=", pos):
            res["texto"] = re.sub(r"\r\n|\r|\n", " ", s[pos + 6:]).strip(_JS_WS)
            break
        fim = s.find(";", pos)
        token = s[pos:] if fim < 0 else s[pos:fim]
        if "=" not in token:
            raise ValueError("par sem '=': %r" % token)
        chave, valor = token.split("=", 1)
        if chave not in ORDEM_CHAVES or chave == "texto":
            raise ValueError("chave desconhecida: %r" % chave)
        ordem = ORDEM_CHAVES.index(chave)
        if ordem <= ultima:
            raise ValueError("chave fora de ordem ou repetida: %s" % chave)
        ultima = ordem
        res[chave] = valor
        if fim < 0:
            break
        pos = fim + 1
        if pos == len(s):
            raise ValueError("';' sobrando no fim")
    for chave in res:
        if chave not in regras:
            raise ValueError("chave %s não vale para %s %s" % (chave, tipo, decisao))
    for chave, obrig in regras.items():
        if obrig and chave not in res:
            raise ValueError("falta %s" % chave)
    if "legenda" in res and res["legenda"] not in ("1", "2"):
        raise ValueError("legenda deve ser 1 ou 2")
    if "horario" in res:
        if not RE_HORARIO.match(res["horario"]):
            raise ValueError("horario deve ser aaaa-mm-dd HH:mm")
        try:
            datetime.strptime(res["horario"], "%Y-%m-%d %H:%M")
        except ValueError:
            raise ValueError("horario inválido")
    if "verba" in res:
        if not RE_VERBA.match(res["verba"]) or Decimal(res["verba"]) <= 0:
            raise ValueError("verba deve ser número > 0 com ponto decimal")
    if regras.get("texto") and not res.get("texto"):
        raise ValueError("texto obrigatório")
    return res


def _fmt_verba(s):
    if "." in s:
        s = s.rstrip("0").rstrip(".")
    return s


# ---------------------------------------------------------------- Drive via gws

_RE_AUTH = re.compile(r"\b401\b|\b403\b|invalid_grant|unauthenticated|unauthorized|autentica", re.I)


def runner_subprocess(gws_bin):
    def run(args, cwd):
        p = subprocess.run([gws_bin] + args, cwd=cwd, capture_output=True, text=True, timeout=300)
        return p.returncode, p.stdout, p.stderr
    return run


class Drive:
    """Camada fina sobre o CLI gws. Caminhos de --output/--upload sempre relativos ao cwd."""

    def __init__(self, workdir, runner):
        self.workdir = workdir
        self.runner = runner

    def _rodar(self, args):
        try:
            rc, out, err = self.runner(args, self.workdir)
        except subprocess.TimeoutExpired:
            raise ErroDrive("timeout no gws", codigo="timeout")
        texto = (out or "") + "\n" + (err or "")
        if rc == 2 or (rc != 0 and _RE_AUTH.search(texto)):
            raise ErroAuth(trim_js(err or out or "falha de autenticação")[:300])
        if rc == 0:
            try:
                j = json.loads(out) if out and out.strip().startswith("{") else None
            except ValueError:
                j = None
            if isinstance(j, dict) and isinstance(j.get("error"), dict):
                code = j["error"].get("code")
                if code in (401, 403):
                    raise ErroAuth(str(j["error"].get("message", ""))[:300])
                raise ErroDrive("erro da API: %s" % j["error"].get("message"), codigo=code, saida=out)
            return out
        raise ErroDrive("gws saiu com código %s: %s" % (rc, trim_js(err or out)[:300]), codigo=rc, saida=texto)

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
            linha = linha.strip()
            if not linha:
                continue
            try:
                arquivos.extend(json.loads(linha).get("files", []))
            except ValueError:
                raise ErroDrive("resposta inesperada do list", saida=out)
        return arquivos

    def atualizar(self, file_id, rel, mime="text/csv"):
        self._rodar(["drive", "files", "update", "--params", json.dumps({"fileId": file_id}),
                     "--upload", rel, "--upload-content-type", mime])

    def criar(self, nome, parent, rel, mime="application/json"):
        self._rodar(["drive", "files", "create", "--json", json.dumps({"name": nome, "parents": [parent], "mimeType": mime}),
                     "--upload", rel, "--upload-content-type", mime])


def _q(s):
    return str(s).replace("\\", "\\\\").replace("'", "\\'")


# ---------------------------------------------------------------- ledger

# Fases do ledger por decisão (mesmos nomes dos outros consumidores)
F_REJEITADA = "rejeitada"            # recibo rejeitado ainda não criado
F_PLANEJADA = "planejada"            # ação entregue ao agente no --plano
F_CONFIRMANDO = "confirmando"        # agente confirmou; hash_depois previsto gravado antes do upload
F_ATUALIZADA = "propostas_atualizada"
F_RECIBO = "recibo_criado"
FASES_VALIDAS = (F_PLANEJADA, F_CONFIRMANDO, F_ATUALIZADA, F_RECIBO)
# Fase do fluxo antigo (antes de --plano/--confirmar). Entradas com ela são tratadas como legado.
F_LEGADO_RECEBIDA = "recebida"


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
        """(item_id, hash) -> decision_id das decisões válidas já planejadas/aplicadas.
        Rejeitadas não contam: uma decisão rejeitada não bloqueia outra sobre a mesma versão."""
        return {(e.get("item_id"), (e.get("snapshot_hash") or "").lower()): did
                for did, e in self.dados["decisoes"].items()
                if e.get("fase") in FASES_VALIDAS and e.get("resultado") != "rejeitado"}

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


def agora_iso(agora=None):
    return (agora or datetime.now(TZ_SP)).astimezone(TZ_SP).isoformat(timespec="seconds")


# ---------------------------------------------------------------- regras de decisão

def avaliar(dec, propostas, decididas):
    """Decide o que fazer com uma decisão, sem gravar nada. Retorna dict:
    {resultado: aplicado|rejeitado, motivo, linha_nova?, acoes?, pid?}
    """
    did = dec["id"]
    item_id, tipo_item, decisao = dec["item_id"], dec["tipo_item"], dec["decisao"]
    h = dec["snapshot_hash"].lower()

    def rej(motivo):
        return {"resultado": "rejeitado", "motivo": motivo}

    if tipo_item not in ("post", "campanha"):
        return rej("tipo_item inválido")
    if ":" not in item_id or item_id.split(":", 1)[0] != tipo_item or not item_id.split(":", 1)[1]:
        return rej("item_id não confere com tipo_item")
    pid = item_id.split(":", 1)[1]
    if not re.match(r"^[0-9a-f]{64}$", h):
        return rej("snapshot_hash inválido")
    outra = decididas.get((item_id, h))
    if outra and outra != did:
        return rej("decisão duplicada: esta versão já foi decidida")
    linha, erro = propostas.buscar(pid)
    if erro:
        return rej(erro)
    if normalizar(linha["tipo"]) != tipo_item:
        return rej("tipo_item não confere com Propostas.csv")
    if hash_snapshot(linha, tipo_item) != h:
        return rej("versão desatualizada")
    if dec.get("versao") and normalizar(dec["versao"]) != normalizar(linha["versao"]):
        return rej("versão desatualizada")
    if decisao not in ("aprovar", "refazer", "recusar", "pausar"):
        return rej("decisão desconhecida")
    estados = ESTADOS_DECIDIVEIS.get((tipo_item, decisao))
    if estados is None:
        return rej("decisão %s não vale para %s" % (decisao, tipo_item))
    estado = normalizar(linha["estado"])
    if estado not in estados:
        return rej("estado %s não aceita %s" % (estado or "vazio", decisao))
    try:
        com = parse_comentario(dec.get("comentario", ""), tipo_item, decisao)
    except ValueError as e:
        return rej("comentario inválido: %s" % e)

    nova = dict(linha)
    texto = com.get("texto", "")
    base = {"decision_id": did, "item_id": item_id, "id": pid, "empresa": linha["empresa"]}
    acoes, motivo = [], ""
    try:
        versao = int(normalizar(linha["versao"]) or "0")
    except ValueError:
        return rej("versao da proposta não é inteiro")

    if tipo_item == "post":
        if decisao == "aprovar":
            nova["estado"] = "aprovado"
            nova["legenda_escolhida"] = com["legenda"]
            partes = ["aprovado com legenda %s" % com["legenda"]]
            if "horario" in com and com["horario"] != normalizar(linha["horario"]):
                nova["horario"] = com["horario"]
                versao += 1
                nova["versao"] = str(versao)
                partes.append("horário %s (versao %d)" % (com["horario"], versao))
            motivo = "; ".join(partes)
            acoes.append(dict(base, acao="programar_post", formato=nova["formato"], contas=nova["contas"],
                              horario=nova["horario"], midia_fileIds=nova["midia_fileIds"],
                              legenda=nova["legenda_" + com["legenda"]], hashtags=nova["hashtags"],
                              versao=nova["versao"], observacao=texto,
                              nota="programar no horário; não publicar sem seguir as regras do agente"))
        elif decisao == "refazer":
            nova["estado"] = "ajuste"
            motivo = "ajuste pedido: %s" % texto
            acoes.append(dict(base, acao="refazer_post", pedido=texto))
        else:
            nova["estado"] = "recusado"
            motivo = "recusado pelo Bruno" + (": %s" % texto if texto else "")
            acoes.append(dict(base, acao="registrar_recusa_post", observacao=texto))
    else:
        if decisao == "aprovar":
            nova["estado"] = "aprovado"
            motivo = "aprovada"
            if "verba" in com:
                try:
                    proposta = Decimal(normalizar(linha["verba_diaria"]))
                except InvalidOperation:
                    return rej("proposta sem verba_diaria válida")
                v = Decimal(com["verba"])
                if v > proposta:
                    return rej("verba acima da proposta")
                if v < proposta:
                    nova["verba_diaria"] = _fmt_verba(com["verba"])
                    versao += 1
                    nova["versao"] = str(versao)
                    motivo = "aprovada com verba %s (versao %d)" % (nova["verba_diaria"], versao)
            acoes.append(dict(base, acao="criar_campanha", campanha_id=nova["campanha_id"],
                              verba_diaria=nova["verba_diaria"], inicio=nova["inicio"], fim=nova["fim"],
                              publico_resumo=nova["publico_resumo"], plano_fileId=nova["plano_fileId"],
                              versao=nova["versao"], observacao=texto,
                              nota="criar pausada/conforme regras do agente; não aumentar verba"))
        elif decisao == "refazer":
            nova["estado"] = "ajuste"
            motivo = "ajuste pedido: %s" % texto
            acoes.append(dict(base, acao="refazer_campanha", pedido=texto))
        elif decisao == "recusar":
            nova["estado"] = "encerrado"
            motivo = "recusada pelo Bruno" + (": %s" % texto if texto else "")
            acoes.append(dict(base, acao="registrar_recusa_campanha", observacao=texto))
        else:
            nova["estado"] = "pausado"
            motivo = "pausada pelo Bruno" + (": %s" % texto if texto else "")
            acoes.append(dict(base, acao="pausar_campanha_meta", campanha_id=nova["campanha_id"], observacao=texto,
                              nota="pausar na Meta pelo agente; este consumidor não chama a Meta"))
    return {"resultado": "aplicado", "motivo": motivo, "linha_nova": nova, "acoes": acoes, "pid": pid}


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
        self.ignoradas = []
        self.md5_esperado = None

    def aviso(self, m):
        self.avisos.append(m)
        self.log("aviso: " + m)

    def _fase(self, did, **campos):
        self.ledger.gravar(did, agora_iso(self.agora()), **campos)

    def _propostas_id(self):
        v = self.cfg.get("propostas_fileId") or ""
        return "" if v == "PREENCHER" else v

    def _decisoes(self):
        texto = self.drive.baixar(self.cfg["decisoes_fileId"], "decisoes.csv")
        decs, vistos = [], set()
        for d in ler_decisoes(texto):
            if d["modulo"] != "anuncios":
                continue
            if not d["id"]:
                self.aviso("decisão sem id ignorada (item %s)" % d["item_id"])
                continue
            if d["id"] in vistos:
                self.ignoradas.append({"decision_id": d["id"], "motivo": "id repetido em decisoes.csv"})
                self.aviso("id repetido em decisoes.csv: %s (só a primeira linha vale)" % d["id"])
                continue
            vistos.add(d["id"])
            decs.append(d)
        return decs

    def _propostas(self):
        texto = self.drive.baixar(self._propostas_id(), "propostas.csv")
        self.md5_esperado = hashlib.md5(texto.encode("utf-8")).hexdigest()
        return Propostas(texto)

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

    def _entrada(self, did, d, propostas):
        """Entrada do ledger, convertendo a do fluxo antigo (fase "recebida").
        Antigo aplicado com o upload já feito vira propostas_atualizada; sem o upload, é descartado
        (a decisão volta a ser avaliada do zero); antigo rejeitado vira rejeitada."""
        e = self.ledger.get(did)
        if not e or e.get("fase") != F_LEGADO_RECEBIDA:
            return e
        if e.get("resultado") == "rejeitado" and e.get("recibo"):
            return dict(e, fase=F_REJEITADA, legado=True)
        if e.get("resultado") == "aplicado" and propostas is not None:
            linha, _ = propostas.buscar(e.get("pid", ""))
            if linha and hash_snapshot(linha, d["tipo_item"]) == e.get("hash_depois"):
                return dict(e, fase=F_ATUALIZADA, legado=True)
        return None

    # ---------------- --plano

    def plano(self):
        res = {"modo": "plano", "teste": self.teste, "acoes": [], "rejeitadas": [], "pendentes": [],
               "ignoradas": self.ignoradas, "ja_com_recibo": 0, "avisos": self.avisos}
        decs = self._decisoes()
        recibos = self._contagem_recibos()
        fila = []
        for d in decs:
            if recibos.get(d["id"] + ".json"):
                res["ja_com_recibo"] += 1
            else:
                fila.append(d)
        if not fila:
            return res
        if not self._propostas_id():
            res["sem_propostas"] = True
            self.aviso("Propostas.csv ainda não configurado (propostas_fileId). %d decisão(ões) aguardando; "
                       "nada foi feito." % len(fila))
            return res
        prop = self._propostas()
        decididas = self.ledger.decididas()
        for d in fila:
            did = d["id"]
            e = self._entrada(did, d, prop)
            if e and e.get("fase") == F_RECIBO:
                self.aviso("ledger diz recibo criado para %s, mas ele não aparece em recibos/; não recriei" % did)
                continue
            if e and e.get("fase") == F_REJEITADA and e.get("recibo"):
                ok = self._criar_recibo(did, e["recibo"], conferir_antes=True)
                (res["rejeitadas"] if ok else res["pendentes"]).append({"decision_id": did, "motivo": e["recibo"]["motivo"]})
                continue
            if e and e.get("legado") and e.get("fase") == F_ATUALIZADA:
                # fluxo antigo: Propostas já foi atualizado e as ações nunca chegaram ao agente
                ok = self._criar_recibo(did, e["recibo"], conferir_antes=True)
                if ok:
                    res["acoes"].extend(dict(a, legado=True) for a in (e.get("acoes") or []))
                else:
                    res["pendentes"].append({"decision_id": did, "motivo": "recibo do fluxo antigo não criado; rode de novo"})
                continue
            if e and e.get("fase") in (F_CONFIRMANDO, F_ATUALIZADA):
                res["pendentes"].append({"decision_id": did, "motivo": "confirmação incompleta; rode --confirmar de novo"})
                continue
            r = avaliar(d, prop, decididas)
            h = d["snapshot_hash"].lower()
            if r["resultado"] == "rejeitado":
                recibo = self._recibo(did, d["snapshot_hash"], "rejeitado", r["motivo"])
                self._fase(did, fase=F_REJEITADA, resultado="rejeitado", item_id=d["item_id"], snapshot_hash=h,
                           recibo=recibo)
                ok = self._criar_recibo(did, recibo, conferir_antes=False)
                (res["rejeitadas"] if ok else res["pendentes"]).append({"decision_id": did, "motivo": r["motivo"]})
                continue
            for a in r["acoes"]:
                acao = dict({"decision_id": did, "item_id": d["item_id"], "decisao": d["decisao"], "snapshot_hash": h},
                            **a)
                acao["motivo"] = r["motivo"]
                if e and e.get("fase") == F_PLANEJADA:
                    acao["ja_planejada"] = True
                res["acoes"].append(acao)
            if not (e and e.get("fase") == F_PLANEJADA):
                self._fase(did, fase=F_PLANEJADA, resultado="planejado", item_id=d["item_id"], snapshot_hash=h,
                           decisao=d["decisao"], pid=r["pid"], acao=r["acoes"][0]["acao"])
            decididas[(d["item_id"], h)] = did
        return res

    # ---------------- --confirmar

    def confirmar(self, did, link=""):
        res = {"modo": "confirmar", "teste": self.teste, "decision_id": did, "resultado": None, "avisos": self.avisos}
        if link and not re.match(r"^https?://\S+$", link):
            raise ErroContrato("link deve começar com http:// ou https://")
        if not self._propostas_id():
            raise ErroContrato("propostas_fileId não configurado")
        decs = self._decisoes()
        d = next((x for x in decs if x["id"] == did), None)
        if d is None:
            raise ErroContrato("decisão %s não existe em decisoes.csv com modulo=anuncios" % did)
        nome = did + ".json"
        existentes = self.drive.listar(self.cfg["recibos_folderId"], nome)
        if existentes:
            if len(existentes) > 1:
                self.aviso("recibo duplicado: %s (%d arquivos); não criei outro" % (nome, len(existentes)))
            if not self.teste and (self.ledger.get(did) or {}).get("fase") != F_RECIBO:
                self._fase(did, fase=F_RECIBO)
            res["resultado"] = "ja_existia"
            return res

        prop = self._propostas()
        e = self._entrada(did, d, prop) or {}
        if e.get("fase") == F_REJEITADA:
            raise ErroContrato("decisão %s foi rejeitada no plano (%s); nada a confirmar" % (did, e["recibo"]["motivo"]))
        if e.get("fase") in (F_ATUALIZADA, F_RECIBO):
            ok = self._criar_recibo(did, e["recibo"], conferir_antes=True)
            res.update(resultado="aplicado" if ok else "pendente", recibo=e["recibo"], retomada=True)
            return res
        if e.get("fase") == F_CONFIRMANDO:
            linha, _ = prop.buscar(e.get("pid", ""))
            if linha and hash_snapshot(linha, d["tipo_item"]) == e.get("hash_depois"):
                # o upload chegou ao Drive, mas o ledger não registrou: só avançar
                if not self.teste:
                    self._fase(did, fase=F_ATUALIZADA)
                ok = self._criar_recibo(did, e["recibo"], conferir_antes=True)
                res.update(resultado="aplicado" if ok else "pendente", recibo=e["recibo"], retomada=True)
                return res
            # upload não chegou: refazer a confirmação do zero

        r = avaliar(d, prop, self.ledger.decididas())
        if r["resultado"] != "aplicado":
            raise ErroContrato("não dá para confirmar %s: %s. Nada foi gravado; se o agente já agiu na Meta, "
                               "corrija Propostas.csv à mão" % (did, r["motivo"]))
        quando = agora_iso(self.agora())
        nova = r["linha_nova"]
        nova["atualizado_em"] = quando
        hash_depois = hash_snapshot(nova, d["tipo_item"])
        h = d["snapshot_hash"].lower()
        recibo = self._recibo(did, d["snapshot_hash"], "aplicado", r["motivo"], link)
        res["recibo"] = recibo
        res["estado_novo"] = nova["estado"]
        res["versao_nova"] = nova["versao"]
        if self.teste:
            res["resultado"] = "aplicado (teste, nada gravado)"
            return res
        # ledger antes de tudo: com o hash_depois previsto, uma queda depois do upload é reconhecida
        self._fase(did, fase=F_CONFIRMANDO, resultado="aplicado", item_id=d["item_id"], snapshot_hash=h,
                   decisao=d["decisao"], pid=r["pid"], hash_depois=hash_depois, recibo=recibo, acoes=r["acoes"])
        prop.substituir(r["pid"], nova)
        atual = self.drive.md5(self._propostas_id())
        if self.md5_esperado and atual and atual != self.md5_esperado:
            self.aviso("Propostas.csv mudou no Drive durante a execução; parei sem gravar")
            res["resultado"] = "pendente"
            return res
        with open(os.path.join(self.drive.workdir, "propostas-novo.csv"), "w", encoding="utf-8", newline="") as f:
            f.write(prop.texto())
        try:
            self.drive.atualizar(self._propostas_id(), "propostas-novo.csv")
        except ErroDrive as ex:
            self.aviso("falha ao atualizar Propostas.csv (%s); rode --confirmar de novo" % ex)
            res["resultado"] = "pendente"
            return res
        self._fase(did, fase=F_ATUALIZADA)
        ok = self._criar_recibo(did, recibo, conferir_antes=False)
        res["resultado"] = "aplicado" if ok else "pendente"
        return res


# ---------------------------------------------------------------- CLI

class _Parser(argparse.ArgumentParser):
    """Argumento inválido sai com 3 (fora do contrato), não com o 2 do argparse, que é o código de autenticação."""

    def error(self, message):
        self.print_usage(sys.stderr)
        self.exit(3, "%s: erro: %s\n" % (self.prog, message))


def carregar_config(caminho):
    with open(caminho, encoding="utf-8") as f:
        cfg = json.load(f)
    for k in ("decisoes_fileId", "recibos_folderId"):
        if not cfg.get(k) or cfg[k] == "PREENCHER":
            raise ErroContrato("config sem %s" % k)
    base = os.path.dirname(os.path.abspath(caminho))
    for k, padrao in (("pasta_trabalho", "trabalho"), ("ledger_path", "ledger-anuncios.json")):
        v = cfg.get(k) or padrao
        cfg[k] = v if os.path.isabs(v) else os.path.join(base, v)
    return cfg


def main(argv=None, runner=None, agora=None):
    ap = _Parser(description="Consumidor das decisões modulo=anuncios do Painel Grupo Smart (não chama a Meta)")
    ap.add_argument("--config", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json"))
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--plano", action="store_true", help="lista em JSON as ações para o agente (padrão)")
    g.add_argument("--confirmar", metavar="DECISION_ID", help="registra a ação que o agente já fez na Meta")
    ap.add_argument("--link", default="", help="com --confirmar: link opcional da evidência (vai no recibo)")
    ap.add_argument("--teste", action="store_true", help="só leitura: não grava Drive, ledger nem recibo")
    ap.add_argument("--dry-run", action="store_true", help="obsoleto: apelido de --teste")
    ap.add_argument("--ledger", help="caminho do ledger (sobrepõe a config)")
    ap.add_argument("--acoes", help=argparse.SUPPRESS)
    a = ap.parse_args(argv)
    if a.acoes is not None:
        print("erro: --acoes foi removido. As ações agora saem em JSON no stdout de --plano; "
              "veja a migração no README.", file=sys.stderr)
        return 3
    if a.dry_run:
        print("aviso: --dry-run está obsoleto; use --teste (mesmo efeito).", file=sys.stderr)
        a.teste = True
    if a.link and not a.confirmar:
        print("erro: --link só vale com --confirmar", file=sys.stderr)
        return 3
    try:
        cfg = carregar_config(a.config)
    except (OSError, ValueError, ErroContrato) as e:
        print("erro de configuração: %s" % e, file=sys.stderr)
        return 3
    if a.ledger:
        cfg["ledger_path"] = a.ledger
    os.makedirs(cfg["pasta_trabalho"], exist_ok=True)
    drive = Drive(cfg["pasta_trabalho"], runner or runner_subprocess(cfg.get("gws_bin", "gws")))
    c = Consumidor(cfg, drive, Ledger(cfg["ledger_path"], somente_leitura=a.teste), teste=a.teste, agora=agora)
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


if __name__ == "__main__":
    sys.exit(main())
