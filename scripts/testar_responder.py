"""Responder pessoas por voce (igual nas 4 IAs): Leo responde contato escolhido como voce; Joao so os escolhidos.

Uso: python scripts/testar_responder.py   (numeros DDD 00 nao existem no WhatsApp; desfaz tudo no final)
"""
import json
import pathlib
import subprocess
import time
import urllib.error
import urllib.request

PROJ = pathlib.Path(__file__).resolve().parent.parent
env = dict(l.split("=", 1) for l in (PROJ / ".env").read_text(encoding="utf-8").splitlines() if "=" in l and not l.startswith("#"))
LEO, JOAO = "5500900000013", "5500900000011"
AMIGA, CLI1, CLI2 = "5500977771001", "5500977771002", "5500977771003"
falhas = 0


def sql(q):
    return subprocess.run(["docker", "compose", "exec", "-T", "postgres", "psql", "-U", env["POSTGRES_USER"], env["POSTGRES_DB"], "-tA"],
                          input=q, cwd=PROJ, capture_output=True, text=True, encoding="utf-8").stdout.strip()


def post(caminho, corpo, tok=""):
    req = urllib.request.Request(f"http://localhost:5678/webhook/{caminho}", json.dumps(corpo).encode(),
                                 {"Content-Type": "application/json", "Authorization": "Bearer " + tok})
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return {"http": e.code}


def api(acao, dados=None):
    return post("painel", {"acao": acao, "dados": dados or {}}, TOK)


def confere(nome, cond, extra=""):
    global falhas
    print(("  OK   " if cond else "  FALHA") + f" {nome}" + (f"  -> {str(extra)[:300]}" if not cond else ""))
    falhas += 0 if cond else 1


def zap(inst, eu, outro, texto, nome=""):
    apikey = env["WHATSAPP_WEBHOOK_SEGREDO"] + ("" if inst == "nucleo" else "-" + inst)
    post("whatsapp", {"event": "messages.upsert", "instance": inst, "apikey": apikey, "sender": f"{eu}@s.whatsapp.net",
                      "data": {"key": {"remoteJid": f"{outro}@s.whatsapp.net", "fromMe": False, "id": f"T{time.time_ns()}"},
                               "pushName": nome, "message": {"conversation": texto}}})


def fila(num, inicio):
    for _ in range(40):
        time.sleep(3)
        r = sql(f"SELECT agente || ' | ' || rascunho FROM nucleo.atendimento_fila WHERE numero = '{num}' AND criado_em >= '{inicio}' LIMIT 1;")
        if r:
            return r
    return ""


TOK = post("painel", {"acao": "login", "dados": {"login": env["ADMIN_LOGIN"], "senha": env["ADMIN_SENHA"]}})["token"]
chaves = ["leo_modo", "leo_observar", "joao_modo", "joao_alcance", "joao_observar"]
antes = {k: sql(f"SELECT valor::text FROM nucleo.config WHERE chave = '{k}';") for k in chaves}
inicio = sql("SELECT now();")
try:
    print("== Leo responde uma pessoa escolhida, como voce")
    sql("""UPDATE nucleo.config SET valor = '"somente"' WHERE chave = 'leo_observar';""")
    r = api("admin_responder_config", {"agente": "leo", "modo": "aprovacao"})
    r = api("admin_responder_definir", {"agente": "leo", "numero": AMIGA, "nome": "Carla", "sim": "true"})
    confere("painel: Leo com aprovacao e 1 pessoa escolhida", r.get("modo") == "aprovacao" and len(r.get("contatos", [])) == 1, r)
    zap("nucleo", LEO, AMIGA, "Oi! Amanha voce consegue passar aqui na loja pra gente conversar?", "Carla")
    f = fila(AMIGA, inicio)
    print(f"    {f}")
    confere("Leo escreveu a resposta (esperando aprovacao)", f.startswith("leo |"), f)

    print("\n== Joao responde so quem foi escolhido")
    sql("""UPDATE nucleo.config SET valor = '"todos"' WHERE chave = 'joao_observar';""")
    api("admin_responder_config", {"agente": "joao", "modo": "aprovacao", "alcance": "selecionados"})
    api("admin_responder_definir", {"agente": "joao", "numero": CLI1, "nome": "Cliente Escolhido", "sim": "true"})
    zap("joao", JOAO, CLI1, "Boa tarde, quanto custa a maquininha?", "Cliente Escolhido")
    zap("joao", JOAO, CLI2, "Boa tarde, quanto custa a maquininha?", "Outro Cliente")
    f = fila(CLI1, inicio)
    print(f"    {f}")
    confere("escolhido: Joao escreveu a resposta", f.startswith("joao |"), f)
    time.sleep(10)
    confere("nao escolhido: Joao so leu (sem resposta)", sql(f"SELECT count(*) FROM nucleo.atendimento_fila WHERE numero = '{CLI2}';") == "0")

    print("\n== tirar da lista para de responder")
    r = api("admin_responder_definir", {"agente": "joao", "numero": CLI1, "nome": "", "sim": "false"})
    confere("saiu da lista", not any(c["numero"] == CLI1 for c in r.get("contatos", [])), r.get("contatos"))
    confere("pode_responder agora e falso", sql(f"SELECT nucleo.pode_responder('joao', '{CLI1}');") == "f")
finally:
    nums = f"('{AMIGA}', '{CLI1}', '{CLI2}')"
    sql(f"DELETE FROM nucleo.atendimento_fila WHERE criado_em >= '{inicio}'; DELETE FROM nucleo.responde_para WHERE numero IN {nums};"
        f" DELETE FROM nucleo.conversas WHERE split_part(contato, ' ', 1) IN {nums} AND criado_em >= '{inicio}';"
        f" DELETE FROM nucleo.clientes WHERE whatsapp IN {nums}; DELETE FROM nucleo.lote_mensagens WHERE criado_em >= '{inicio}';"
        f" DELETE FROM nucleo.perfis_contato WHERE numero IN {nums}; DELETE FROM nucleo_memoria_chat WHERE session_id LIKE 'l:%' OR session_id LIKE 'c%:joao';")
    for k, v in antes.items():
        if v:
            sql(f"UPDATE nucleo.config SET valor = '{v}'::jsonb WHERE chave = '{k}';")
print(f"\n{'TUDO OK' if not falhas else f'{falhas} FALHA(S)'}")
