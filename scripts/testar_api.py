"""Teste de ponta a ponta da API do painel com varios usuarios (isolamento de memoria).

Uso: python scripts/testar_api.py
Cria usuarios TESTE_ana / TESTE_beto, conversa com a IA de cada um, confere quem ve o que
e apaga tudo no final. Precisa do n8n no ar e da chave da OpenAI.
"""
import json
import pathlib
import subprocess
import sys
import urllib.error
import urllib.request

PROJ = pathlib.Path(__file__).resolve().parent.parent
URL = "http://localhost:5678/webhook/painel"
env = dict(l.split("=", 1) for l in (PROJ / ".env").read_text(encoding="utf-8").splitlines() if "=" in l and not l.startswith("#"))


def post(acao, dados=None, tok=None, url=URL, corpo=None, tipo="application/json"):
    data = corpo if corpo is not None else json.dumps({"acao": acao, "dados": dados or {}}).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST", headers={"Content-Type": tipo, "Authorization": f"Bearer {tok or ''}"})
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            b = r.read()
            return r.status, (json.loads(b) if r.headers.get_content_type() == "application/json" else b)
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def sql(q):
    return subprocess.run(["docker", "compose", "exec", "-T", "postgres", "psql", "-U", env["POSTGRES_USER"], env["POSTGRES_DB"], "-tAc", q],
                          cwd=PROJ, capture_output=True, text=True, encoding="utf-8").stdout.strip()


falhas = 0


def confere(nome, cond, extra=""):
    global falhas
    print(("  OK   " if cond else "  FALHA") + f" {nome}" + (f"  -> {extra}" if extra and not cond else ""))
    falhas += 0 if cond else 1


def ia(tok, msg, sessao="teste"):
    s, r = post("chat", {"mensagem": msg, "sessao": sessao}, tok)
    print(f"    > {msg}\n    < [{s}] {r.get('resposta') or r.get('erro')}")
    return (r.get("resposta") or "").lower()


sql("DELETE FROM nucleo.usuarios WHERE login LIKE 'teste_%'")
sql("UPDATE nucleo.config SET valor='false' WHERE chave='memoria_compartilhada'")
_, r = post("login", {"login": env["ADMIN_LOGIN"], "senha": env["ADMIN_SENHA"]})
adm = r["token"]
sql("UPDATE nucleo.usuarios SET compartilha = true WHERE login = '%s'" % env["ADMIN_LOGIN"])

print("\n== admin cria usuarios")
s, _ = post("admin_criar_usuario", {"nome": "Ana Teste", "login": "teste_ana", "senha": "senha123"}, adm); confere("cria Ana", s == 200)
s, _ = post("admin_criar_usuario", {"nome": "Beto Teste", "login": "teste_beto", "senha": "senha123"}, adm); confere("cria Beto", s == 200)
ana = post("login", {"login": "teste_ana", "senha": "senha123"})[1]["token"]
beto = post("login", {"login": "teste_beto", "senha": "senha123"})[1]["token"]
s, _ = post("admin_criar_usuario", {"login": "x", "senha": "senha123"}, ana); confere("Ana NAO pode criar usuario", s == 403)

print("\n== cada um guarda uma ideia")
ia(ana, "Guarda essa ideia minha: abrir uma cafeteria com tema de games.")
ia(beto, "Guarda essa ideia minha: criar um aplicativo de delivery de cafe por drone.")
confere("memoria da Ana gravada com dono certo", sql("SELECT count(*) FROM nucleo.conhecimento k JOIN nucleo.usuarios u ON u.id=k.usuario_id WHERE u.login='teste_ana'") >= "1")
confere("memoria do Beto gravada com dono certo", sql("SELECT count(*) FROM nucleo.conhecimento k JOIN nucleo.usuarios u ON u.id=k.usuario_id WHERE u.login='teste_beto'") >= "1")

print("\n== compartilhada DESLIGADA: Ana tenta ver ideia do Beto")
resp = ia(ana, "Quais ideias de todo mundo voce conhece sobre cafe? Use a memoria de todos.", "t2")
confere("Ana NAO ve o drone do Beto", "drone" not in resp, resp)

print("\n== admin pede ideias de todos")
resp = ia(adm, "Me da um resumo das ideias de todo mundo do time sobre cafe, dizendo de quem e cada uma.", "t3")
confere("admin ve ideia da Ana", "game" in resp or "jogo" in resp, resp)
confere("admin ve ideia do Beto", "drone" in resp, resp)

print("\n== admin liga a memoria compartilhada e fica de fora")
s, _ = post("admin_config", {"memoria_compartilhada": True}, adm); confere("liga compartilhada", s == 200)
ia(adm, "Guarda essa ideia minha, secreta: franquia de cafe no aeroporto.", "t4")
s, _ = post("participar", {"compartilha": False}, adm); confere("admin sai", s == 200)
resp = ia(ana, "Quais ideias do time sobre cafe estao na memoria compartilhada? Diga de quem e cada uma.", "t5")
confere("Ana agora ve o drone do Beto", "drone" in resp, resp)
confere("Ana NAO ve a ideia do admin (ele saiu)", "aeroporto" not in resp, resp)

print("\n== resumo de cada um so traz as proprias memorias")
_, ra = post("resumo", tok=ana)
confere("resumo da Ana sem drone", all("drone" not in m["conteudo"].lower() for m in ra["memorias"]))
confere("Ana nao recebe lista de usuarios", ra["usuarios"] is None)

print("\n== voz (texto -> fala -> texto)")
s, mp3 = post("falar", {"texto": "Oi, eu sou a Ana. Qual foi a ideia que eu te contei?"}, ana)
confere("gerou audio mp3", s == 200 and isinstance(mp3, bytes) and len(mp3) > 2000, f"status {s}")
if s == 200:
    s, r = post(None, tok=ana, url=URL + "-audio?sessao=t6", corpo=mp3, tipo="audio/mpeg")
    print(f"    transcricao: {r.get('transcricao')}\n    resposta: {r.get('resposta') or r.get('erro')}")
    confere("transcreveu e respondeu", s == 200 and bool(r.get("resposta")), str(r))
    confere("lembrou da ideia da propria Ana", "game" in (r.get("resposta") or "").lower() or "jogo" in (r.get("resposta") or "").lower(), r.get("resposta"))
s, _ = post(None, tok="falso", url=URL + "-audio", corpo=b"123", tipo="audio/webm"); confere("audio sem login e recusado", s == 401)

print("\n== limpeza")
sql("DELETE FROM nucleo_memoria_chat WHERE session_id LIKE 'u%:t%' OR session_id LIKE 'u%:teste'")
sql("DELETE FROM nucleo.conhecimento WHERE usuario_id IN (SELECT id FROM nucleo.usuarios WHERE login LIKE 'teste_%') OR conteudo ILIKE '%aeroporto%'")
sql("DELETE FROM nucleo.usuarios WHERE login LIKE 'teste_%'")
sql("UPDATE nucleo.config SET valor='false' WHERE chave='memoria_compartilhada'")
sql("UPDATE nucleo.usuarios SET compartilha = true WHERE login = '%s'" % env["ADMIN_LOGIN"])
print(f"\n{'TUDO OK' if not falhas else f'{falhas} FALHA(S)'}")
sys.exit(1 if falhas else 0)
