"""Cada IA com a propria inteligencia + audios transcritos (inclusive nas conversas que a IA so observa).

Uso: python scripts/testar_separacao.py   (numeros DDD 00 nao existem no WhatsApp; desfaz tudo no final)
Gera 2 audios curtos com a voz da OpenAI (custo de centavos).
"""
import base64
import json
import pathlib
import subprocess
import time
import urllib.error
import urllib.request

PROJ = pathlib.Path(__file__).resolve().parent.parent
env = dict(l.split("=", 1) for l in (PROJ / ".env").read_text(encoding="utf-8").splitlines() if "=" in l and not l.startswith("#"))
U = "http://localhost:5678/webhook"
DONO, CLI, AMIGO = "5500900000000", "5500912340000", "5500956780000"
falhas = 0


def post(caminho, corpo, tok=""):
    req = urllib.request.Request(f"{U}/{caminho}", json.dumps(corpo).encode(), {"Content-Type": "application/json", "Authorization": "Bearer " + tok})
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def api(acao, dados=None):
    return post("painel", {"acao": acao, "dados": dados or {}}, TOK)[1]


def sql(q):
    return subprocess.run(["docker", "compose", "exec", "-T", "postgres", "psql", "-U", env["POSTGRES_USER"], env["POSTGRES_DB"], "-tAc", q],
                          cwd=PROJ, capture_output=True, text=True, encoding="utf-8").stdout.strip()


def confere(nome, cond, extra=""):
    global falhas
    print(("  OK   " if cond else "  FALHA") + f" {nome}" + (f"  -> {str(extra)[:300]}" if not cond else ""))
    falhas += 0 if cond else 1


def voz(texto):
    req = urllib.request.Request("https://api.openai.com/v1/audio/speech", json.dumps({
        "model": "gpt-4o-mini-tts", "voice": "nova", "response_format": "mp3", "input": texto}).encode(),
        {"Content-Type": "application/json", "Authorization": "Bearer " + env["OPENAI_API_KEY"]})
    with urllib.request.urlopen(req, timeout=60) as r:
        return base64.b64encode(r.read()).decode()


def zap_audio(inst, numero, b64, de_mim=False, nome=""):
    apikey = env["WHATSAPP_WEBHOOK_SEGREDO"] + ("" if inst == "nucleo" else "-" + inst)
    post("whatsapp", {"event": "messages.upsert", "instance": inst, "apikey": apikey, "sender": f"{DONO}@s.whatsapp.net",
                      "data": {"key": {"remoteJid": f"{numero}@s.whatsapp.net", "fromMe": de_mim, "id": f"T{time.time_ns()}"},
                               "pushName": nome, "message": {"audioMessage": {"seconds": 3}, "base64": b64}}})


TOK = post("painel", {"acao": "login", "dados": {"login": env["ADMIN_LOGIN"], "senha": env["ADMIN_SENHA"]}})[1]["token"]
admin_id = int(sql(f"SELECT id FROM nucleo.usuarios WHERE login = '{env['ADMIN_LOGIN']}'"))
antes = {k: sql(f"SELECT valor::text FROM nucleo.config WHERE chave = '{k}'") for k in ["joao_observar", "gabriel_observar", "joao_modo", "gabriel_modo"]}
inicio = sql("SELECT now()")

try:
    print("== cada IA so enxerga o que e dela")
    sql(f"SELECT * FROM nucleo.lembrar({admin_id}, 'TESTE cor', 'TESTE: a cor favorita do dono e roxo-berinjela')")
    api("admin_base_salvar", {"area": "geral", "titulo": "TESTE plano", "conteudo": "TESTE: o plano Zeta custa R$ 77", "agente": "joao"})
    confere("memoria do Leo e do Leo", sql(f"SELECT agente FROM nucleo.conhecimento WHERE titulo = 'TESTE cor'") == "leo")
    confere("Leo acha a propria memoria", "berinjela" in sql(f"SELECT string_agg(conteudo, ' ') FROM nucleo.buscar_memoria({admin_id}, 'cor favorita')"))
    confere("Gabriel NAO ve a memoria do Leo", "berinjela" not in sql("SELECT coalesce(string_agg(conteudo, ' '), '') FROM nucleo.buscar_memoria_gabriel('cor favorita')")
            and "berinjela" not in sql("SELECT nucleo.memoria_gabriel(200)"))
    confere("ensinado na pagina do Joao fica so com o Joao (mesmo area geral)", sql("SELECT agente FROM nucleo.conhecimento WHERE titulo = 'TESTE plano'") == "joao")
    confere("Joao acha", "77" in sql("SELECT coalesce(string_agg(conteudo, ' '), '') FROM nucleo.buscar_base('comercial', 'plano Zeta')"))
    confere("Suporte NAO ve o que e do Joao", "77" not in sql("SELECT coalesce(string_agg(conteudo, ' '), '') FROM nucleo.buscar_base('suporte', 'plano Zeta')"))

    print("\n== passar para outra IA so quando voce pede")
    kid = int(sql("SELECT id FROM nucleo.conhecimento WHERE titulo = 'TESTE cor'"))
    api("admin_conhecimento_copiar", {"id": kid, "para": "gabriel"})
    confere("depois de copiar, o Gabriel sabe", "berinjela" in sql("SELECT coalesce(string_agg(conteudo, ' '), '') FROM nucleo.buscar_memoria_gabriel('cor favorita')"))
    confere("o original continua so com o Leo", sql(f"SELECT count(*) FROM nucleo.conhecimento WHERE titulo = 'TESTE cor' AND agente = 'leo'") == "1")

    print("\n== audios transcritos tambem quando a IA so observa")
    sql("UPDATE nucleo.config SET valor = '\"todos\"' WHERE chave IN ('joao_observar', 'gabriel_observar')")
    sql("UPDATE nucleo.config SET valor = '\"observando\"' WHERE chave IN ('joao_modo', 'gabriel_modo')")
    zap_audio("joao", CLI, voz("Oi, boa tarde! Queria saber o preço do plano mensal de vocês."), nome="Cliente Audio")
    zap_audio("gabriel", AMIGO, voz("Fala mano! Amanhã não rola, bora quinta que é suave."), de_mim=True)
    t1 = t2 = ""
    for _ in range(25):
        time.sleep(3)
        t1 = sql(f"SELECT mensagem FROM nucleo.conversas WHERE contato LIKE '{CLI}%' AND instancia = 'joao' AND criado_em >= '{inicio}' LIMIT 1")
        t2 = sql(f"SELECT mensagem FROM nucleo.conversas WHERE agente = 'gabriel-observa' AND contato LIKE '{AMIGO}%' AND criado_em >= '{inicio}' LIMIT 1")
        if t1 and t2:
            break
    print(f"    joao leu: {t1}\n    gabriel leu: {t2}")
    confere("audio do cliente (Joao so observando) virou texto", t1.startswith("🎤") and "plano" in t1.lower(), t1)
    confere("seu audio no numero do Gabriel virou texto", t2.startswith("🎤") and "quinta" in t2.lower(), t2)
    confere("nenhuma resposta enviada (so observando)", sql(f"SELECT count(*) FROM nucleo.atendimento_fila WHERE criado_em >= '{inicio}'") == "0")
finally:
    print("\n== limpeza")
    sql("DELETE FROM nucleo.conhecimento WHERE titulo IN ('TESTE cor', 'TESTE plano')")
    sql(f"DELETE FROM nucleo.conversas WHERE criado_em >= '{inicio}' AND (contato LIKE '{CLI}%' OR contato LIKE '{AMIGO}%')")
    sql(f"DELETE FROM nucleo.clientes WHERE whatsapp = '{CLI}'")
    sql(f"DELETE FROM nucleo.lote_mensagens WHERE chave LIKE '%{CLI}%' OR chave LIKE '%{AMIGO}%'")
    for k, v in antes.items():
        if v:
            sql(f"UPDATE nucleo.config SET valor = '{v}'::jsonb WHERE chave = '{k}'")

print(f"\n{'TUDO OK' if not falhas else f'{falhas} FALHA(S)'}")
