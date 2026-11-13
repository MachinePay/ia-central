"""Teste do canal WhatsApp sem celular: simula a Evolution API chamando o webhook do n8n.

Uso: python scripts/testar_whatsapp.py
Modo dedicado: texto, @lid, audio, seguranca.
Modo pessoal: conversa "Voce" do dono, sem loop, conversas pessoais ignoradas, gatilho /ia.
O envio real falha se o WhatsApp nao estiver conectado (esperado): o teste olha o que a IA decidiu responder.
Restaura o modo e apaga os usuarios de teste no final.
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
N8N = "http://localhost:5678/webhook"
NUM = "5500900001234"       # usuario de teste (ficticio)
DONO_IA = "5500922223333"   # numero ficticio "conectado" (o celular onde a IA roda)
falhas = 0


def post(url, corpo, tok=None):
    req = urllib.request.Request(url, data=json.dumps(corpo).encode(), method="POST",
                                 headers={"Content-Type": "application/json", "Authorization": f"Bearer {tok or ''}"})
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            b = r.read()
            return r.status, (json.loads(b) if r.headers.get_content_type() == "application/json" else b)
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def sql(q):
    return subprocess.run(["docker", "compose", "exec", "-T", "postgres", "psql", "-U", env["POSTGRES_USER"], env["POSTGRES_DB"], "-tAc", q],
                          cwd=PROJ, capture_output=True, text=True, encoding="utf-8").stdout.strip()


def confere(nome, cond, extra=""):
    global falhas
    print(("  OK   " if cond else "  FALHA") + f" {nome}" + (f"  -> {extra}" if extra and not cond else ""))
    falhas += 0 if cond else 1


def evento(numero, mensagem, segredo=env.get("WHATSAPP_WEBHOOK_SEGREDO"), lid=False, de_mim=False):
    key = {"remoteJid": f"{numero}@s.whatsapp.net", "fromMe": de_mim, "id": f"TESTE{time.time_ns()}"}
    if lid:
        key = {**key, "remoteJid": "123456789@lid", "senderPn": f"{numero}@s.whatsapp.net"}
    return {"event": "messages.upsert", "instance": env.get("EVOLUTION_INSTANCIA", "nucleo"), "apikey": segredo,
            "sender": f"{DONO_IA}@s.whatsapp.net",
            "data": {"key": key, "pushName": "Teste Zap", "message": mensagem, "messageType": "conversation"}}


def respostas(numero):
    return int(sql(f"SELECT count(*) FROM nucleo.conversas WHERE canal='whatsapp' AND papel='ia' AND contato LIKE '%{numero[-8:]}%'") or 0)


def total_ia():
    return int(sql("SELECT count(*) FROM nucleo.conversas WHERE canal='whatsapp' AND papel='ia'") or 0)


def esperar_resposta(numero, antes, limite=90):
    for _ in range(limite // 3):
        time.sleep(3)
        if respostas(numero) > antes:
            return sql(f"SELECT mensagem FROM nucleo.conversas WHERE canal='whatsapp' AND papel='ia' AND contato LIKE '%{numero[-8:]}%' ORDER BY id DESC LIMIT 1")
    return None


def modo(m):
    sql(f"UPDATE nucleo.config SET valor = to_jsonb('{m}'::text) WHERE chave = 'whatsapp_modo'")


modo_antes = sql("SELECT valor #>> '{}' FROM nucleo.config WHERE chave = 'whatsapp_modo'") or "pessoal"
sql("DELETE FROM nucleo.usuarios WHERE login IN ('teste_zap', 'teste_dono')")
uid = sql("SELECT nucleo.salvar_usuario('Zap Teste', 'teste_zap', 'senha123')")
sql(f"UPDATE nucleo.usuarios SET whatsapp = '{NUM}' WHERE id = {uid}")
sql(f"SELECT nucleo.lembrar({uid}, 'cor favorita', 'A cor favorita do Zap Teste e verde-limao')")

try:
    print("\n######## MODO DEDICADO (chip so da IA)")
    modo("dedicado")

    print("\n== texto de numero cadastrado (sem o 9, como o WhatsApp as vezes manda)")
    s, _ = post(f"{N8N}/whatsapp", evento(NUM[:4] + NUM[5:], {"conversation": "Oi! Qual e a minha cor favorita?"}))
    confere("webhook aceitou (200)", s == 200)
    r = esperar_resposta(NUM, 0)
    print(f"    resposta da IA: {r}")
    confere("IA do usuario certo respondeu", r is not None and "verde" in r.lower(), str(r))

    print("\n== mensagem com endereco @lid (novo formato do WhatsApp)")
    post(f"{N8N}/whatsapp", evento(NUM, {"extendedTextMessage": {"text": "Responda so: recebido"}}, lid=True))
    confere("respondeu tambem com @lid", esperar_resposta(NUM, 1) is not None)

    print("\n== audio (gera fala com a OpenAI e manda como se fosse audio do WhatsApp)")
    tok = post(f"{N8N}/painel", {"acao": "login", "dados": {"login": "teste_zap", "senha": "senha123"}})[1]["token"]
    s, mp3 = post(f"{N8N}/painel", {"acao": "falar", "dados": {"texto": "Me diz em uma frase qual é a minha cor favorita."}}, tok)
    if s == 200:
        post(f"{N8N}/whatsapp", evento(NUM, {"audioMessage": {"mimetype": "audio/ogg; codecs=opus", "seconds": 3},
                                             "base64": base64.b64encode(mp3).decode()}))
        r = esperar_resposta(NUM, 2)
        print(f"    resposta da IA: {r}")
        confere("audio transcrito e respondido", r is not None and "verde" in r.lower(), str(r))

    print("\n== seguranca")
    n0 = sql("SELECT count(*) FROM nucleo.conversas WHERE canal='whatsapp'")
    post(f"{N8N}/whatsapp", evento(NUM, {"conversation": "mensagem forjada"}, segredo="segredo-errado"))
    time.sleep(4)
    confere("mensagem sem o segredo e descartada", sql("SELECT count(*) FROM nucleo.conversas WHERE canal='whatsapp'") == n0)
    post(f"{N8N}/whatsapp", evento("5500988887777", {"conversation": "quero saber o preco"}))
    time.sleep(5)
    confere("dedicado: desconhecido registrado e sem resposta",
            sql("SELECT count(*) FROM nucleo.conversas WHERE contato LIKE '5500988887777%' AND papel='usuario'") == "1"
            and sql("SELECT count(*) FROM nucleo.conversas WHERE contato LIKE '5500988887777%' AND papel='ia'") == "0")

    print("\n######## MODO PESSOAL (IA no celular do dono)")
    modo("pessoal")
    dono_id = sql("SELECT nucleo.salvar_usuario('Dono Teste', 'teste_dono', 'senha123', 'admin')")
    sql(f"UPDATE nucleo.usuarios SET whatsapp = '{DONO_IA}' WHERE id = {dono_id}")
    sql(f"SELECT nucleo.lembrar({dono_id}, 'time', 'O time do coracao do Dono Teste e o Palmeiras')")

    print("\n== dono escreve na conversa 'Voce'")
    post(f"{N8N}/whatsapp", evento(DONO_IA, {"conversation": "Qual e o meu time do coracao?"}, de_mim=True))
    r = esperar_resposta(DONO_IA, 0)
    print(f"    resposta da IA: {r}")
    confere("IA respondeu o dono na conversa Voce", r is not None and "palmeiras" in r.lower(), str(r))

    print("\n== a resposta da IA volta pelo webhook (fromMe, com o robo): nao pode responder de novo")
    n = total_ia()
    post(f"{N8N}/whatsapp", evento(DONO_IA, {"conversation": "🤖 Seu time e o Palmeiras"}, de_mim=True))
    time.sleep(8)
    confere("sem loop", total_ia() == n)

    print("\n== dono conversando com amigo / familia mandando mensagem")
    total = sql("SELECT count(*) FROM nucleo.conversas")
    post(f"{N8N}/whatsapp", evento("5500944445555", {"conversation": "bora almocar amanha?"}, de_mim=True))
    post(f"{N8N}/whatsapp", evento("5500966667777", {"conversation": "oi filho, me liga"}))
    time.sleep(8)
    confere("conversas pessoais ignoradas e nada guardado", sql("SELECT count(*) FROM nucleo.conversas") == total)

    print("\n== outro usuario cadastrado: sem /ia nada; com /ia a IA DELE responde")
    n = total_ia()
    post(f"{N8N}/whatsapp", evento(NUM, {"conversation": "e ai, tudo certo pro jogo?"}))
    time.sleep(8)
    confere("sem /ia: IA nao responde", total_ia() == n)
    antes = respostas(NUM)
    post(f"{N8N}/whatsapp", evento(NUM, {"conversation": "/ia qual e a minha cor favorita?"}))
    r = esperar_resposta(NUM, antes)
    print(f"    resposta da IA: {r}")
    confere("com /ia: responde com a memoria dele (nao a do dono)",
            r is not None and "verde" in r.lower() and "palmeiras" not in r.lower(), str(r))

    print("\n== painel: status / modo (admin)")
    adm = post(f"{N8N}/painel", {"acao": "login", "dados": {"login": env["ADMIN_LOGIN"], "senha": env["ADMIN_SENHA"]}})[1]["token"]
    s, st = post(f"{N8N}/painel", {"acao": "admin_whatsapp", "dados": {"op": "status"}}, adm)
    print(f"    status: [{s}] estado={st.get('estado')} config={st.get('config')}")
    confere("status responde com o modo", s == 200 and st.get("config", {}).get("modo") == "pessoal", str(st)[:200])
    s, _ = post(f"{N8N}/painel", {"acao": "admin_whatsapp", "dados": {"op": "status"}}, tok)
    confere("usuario comum nao mexe no WhatsApp", s == 403)
finally:
    print("\n== limpeza")
    for login in ("teste_zap", "teste_dono"):
        i = sql(f"SELECT id FROM nucleo.usuarios WHERE login = '{login}'")
        if i:
            sql(f"DELETE FROM nucleo_memoria_chat WHERE session_id = 'u{i}:whatsapp'")
    sql(f"DELETE FROM nucleo.conversas WHERE canal='whatsapp' AND (contato LIKE '%{NUM[-8:]}%' OR contato LIKE '%{DONO_IA[-8:]}%' "
        "OR contato LIKE '5500988887777%')")
    sql("DELETE FROM nucleo.usuarios WHERE login IN ('teste_zap', 'teste_dono')")
    modo(modo_antes)
    print(f"    modo restaurado: {modo_antes}")

print(f"\n{'TUDO OK' if not falhas else f'{falhas} FALHA(S)'}")
