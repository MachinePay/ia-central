"""Teste de falhas: troca a chave da OpenAI por uma invalida e confere que cada IA registra a falha com o
motivo legivel, que nada vai para o contato e que o painel mostra (admin_saude / admin_agente_feed).

Uso: python scripts/testar_saude.py [--manter]   (--manter deixa os eventos para ver no painel)
Numeros DDD 00 (nao existem no WhatsApp). O WhatsApp do admin fica nulo durante o teste (nao recebe aviso).
Restaura a chave verdadeira no final.
"""
import json
import pathlib
import subprocess
import sys
import time
import urllib.error
import urllib.request

PROJ = pathlib.Path(__file__).resolve().parent.parent
env = dict(l.split("=", 1) for l in (PROJ / ".env").read_text(encoding="utf-8").splitlines() if "=" in l and not l.startswith("#"))
U = "http://localhost:5678/webhook"
CLI = "5500912340000"
falhas = 0


def post(caminho, corpo, tok=""):
    req = urllib.request.Request(f"{U}/{caminho}", json.dumps(corpo).encode(), {"Content-Type": "application/json", "Authorization": "Bearer " + tok})
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def api(acao, dados=None):
    return post("painel", {"acao": acao, "dados": dados or {}}, TOK)


def sql(q):
    return subprocess.run(["docker", "compose", "exec", "-T", "postgres", "psql", "-U", env["POSTGRES_USER"], env["POSTGRES_DB"], "-tAc", q],
                          cwd=PROJ, capture_output=True, text=True, encoding="utf-8").stdout.strip()


def n8n(*args):
    return subprocess.run(["docker", "compose", "exec", "-T", "n8n", "n8n", *args], cwd=PROJ, capture_output=True, text=True, encoding="utf-8")


def confere(nome, cond, extra=""):
    global falhas
    print(("  OK   " if cond else "  FALHA") + f" {nome}" + (f"  -> {str(extra)[:300]}" if not cond else ""))
    falhas += 0 if cond else 1


def chave_openai(valor):
    cred = json.loads((PROJ / "workflows" / "credenciais.json").read_text(encoding="utf-8"))
    for c in cred:
        if c["id"] == "openai01":
            c["data"]["apiKey"] = valor
    tmp = PROJ / "workflows" / ".cred-teste.json"
    tmp.write_text(json.dumps(cred), encoding="utf-8")
    try:
        r = n8n("import:credentials", "--input=/import/workflows/.cred-teste.json")
        assert "uccess" in r.stdout + r.stderr, r.stdout + r.stderr
    finally:
        tmp.unlink()


TOK = post("painel", {"acao": "login", "dados": {"login": env["ADMIN_LOGIN"], "senha": env["ADMIN_SENHA"]}})[1]["token"]
admin_zap = sql("SELECT coalesce(whatsapp, '') FROM nucleo.usuarios WHERE id = 1")
antes = {k: sql(f"SELECT valor::text FROM nucleo.config WHERE chave = '{k}'") for k in ["joao_modo", "joao_alcance", "joao_observar"]}
inicio = sql("SELECT now()")

try:
    sql("UPDATE nucleo.usuarios SET whatsapp = NULL WHERE id = 1")
    print("== chave da OpenAI invalida (temporario)")
    chave_openai("sk-invalida-teste-ia-central")

    print("\n== chat do painel (Leo)")
    s, r = api("chat", {"mensagem": "oi, tudo bem?", "sessao": "teste-saude"})
    confere("devolve 502", s == 502, (s, r))
    confere("motivo legivel: chave invalida", "chave da openai invalida" in (r.get("motivo") or "").lower(), r)

    print("\n== simulador do Joao")
    s, r = api("admin_atendimento_teste", {"mensagem": "quanto custa?", "sessao": "teste-saude", "agente": "joao"})
    confere("devolve 502 com motivo", s == 502 and "chave" in (r.get("motivo") or "").lower(), (s, r))

    print("\n== WhatsApp do Joao (aprovacao) com cliente de teste")
    sql("UPDATE nucleo.config SET valor = '\"aprovacao\"' WHERE chave = 'joao_modo'")
    sql("UPDATE nucleo.config SET valor = '\"todos\"' WHERE chave = 'joao_alcance'")
    sql("UPDATE nucleo.config SET valor = '\"todos\"' WHERE chave = 'joao_observar'")
    post("whatsapp", {"event": "messages.upsert", "instance": "joao", "apikey": env["WHATSAPP_WEBHOOK_SEGREDO"] + "-joao",
                      "sender": "5500900000000@s.whatsapp.net",
                      "data": {"key": {"remoteJid": f"{CLI}@s.whatsapp.net", "fromMe": False, "id": f"T{time.time_ns()}"},
                               "pushName": "Cliente Teste", "message": {"conversation": "oi, quero saber o preco"}}})
    ev = ""
    for _ in range(30):
        time.sleep(3)
        ev = sql(f"SELECT titulo FROM nucleo.eventos WHERE agente = 'joao' AND contexto->>'numero' = '{CLI}' AND criado_em >= '{inicio}' ORDER BY id DESC LIMIT 1")
        if ev:
            break
    confere("falha do Joao registrada com motivo", "chave" in ev.lower(), ev)
    confere("nada na fila de aprovacao (nao manda desculpa generica)",
            sql(f"SELECT count(*) FROM nucleo.atendimento_fila WHERE criado_em >= '{inicio}'") == "0")

    print("\n== workflow de erros")
    # id que nao e numero: o banco quebra no meio da execucao da API -> workflow de erros registra
    s, r = api("esquecer", {"id": "nao-e-numero"})
    ev = ""
    for _ in range(10):
        time.sleep(2)
        ev = sql(f"SELECT contexto::text FROM nucleo.eventos WHERE agente = 'sistema' AND criado_em >= '{inicio}' ORDER BY id DESC LIMIT 1")
        if ev:
            break
    confere("execucao que quebrou vira evento (com workflow e no)", "API do Painel" in ev, (s, r, ev))

    print("\n== painel")
    s, saude = api("admin_saude")
    por = {a["agente"]: a for a in saude.get("agentes", [])}
    confere("saude: Joao com erro e motivo", por.get("joao", {}).get("erros_24h", 0) >= 1 and "chave" in (por["joao"].get("ultimo_erro") or {}).get("titulo", "").lower(), por.get("joao"))
    confere("saude: Leo com erro", por.get("leo", {}).get("erros_24h", 0) >= 1, por.get("leo"))
    s, feed = api("admin_agente_feed", {"agente": "joao"})
    confere("feed do Joao traz o evento com contexto", any((e.get("contexto") or {}).get("numero") == CLI for e in feed.get("eventos", [])), feed.get("eventos", [])[:2])
finally:
    print("\n== restaurando")
    chave_openai(env["OPENAI_API_KEY"])
    sql(f"UPDATE nucleo.usuarios SET whatsapp = {'NULL' if not admin_zap else repr(admin_zap)} WHERE id = 1")
    for k, v in antes.items():
        if v:
            sql(f"UPDATE nucleo.config SET valor = '{v}'::jsonb WHERE chave = '{k}'")
    sql(f"DELETE FROM nucleo.conversas WHERE criado_em >= '{inicio}' AND contato LIKE '{CLI}%'")
    sql(f"DELETE FROM nucleo.clientes WHERE whatsapp = '{CLI}'")
    sql("DELETE FROM nucleo_memoria_chat WHERE session_id LIKE '%teste-saude%'")
    if "--manter" not in sys.argv:
        sql(f"DELETE FROM nucleo.eventos WHERE criado_em >= '{inicio}'")
    s, r = api("chat", {"mensagem": "responda so: ok", "sessao": "teste-saude-2"})
    confere("chave verdadeira de volta (Leo responde)", s == 200, (s, r))
    sql("DELETE FROM nucleo_memoria_chat WHERE session_id LIKE '%teste-saude%'")

print(f"\n{'TUDO OK' if not falhas else f'{falhas} FALHA(S)'}")
