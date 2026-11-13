"""IAs aprendem sozinhas + conversa "Voce" em cada numero (a IA daquele numero responde e aprende com o dono).

Uso: python scripts/testar_dono.py   (numeros DDD 00 nao existem no WhatsApp; desfaz tudo no final)
"""
import json
import pathlib
import subprocess
import time
import urllib.error
import urllib.request

PROJ = pathlib.Path(__file__).resolve().parent.parent
env = dict(l.split("=", 1) for l in (PROJ / ".env").read_text(encoding="utf-8").splitlines() if "=" in l and not l.startswith("#"))
U = "http://localhost:5678/webhook"
CLI = "5500912340000"
NUM = {"joao": "5500900000011", "gabriel": "5500900000012", "nucleo": "5500900000013"}   # "numeros" das IAs no teste
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


def zap(inst, de, para, texto, de_mim=False, nome=""):
    apikey = env["WHATSAPP_WEBHOOK_SEGREDO"] + ("" if inst == "nucleo" else "-" + inst)
    post("whatsapp", {"event": "messages.upsert", "instance": inst, "apikey": apikey, "sender": f"{de}@s.whatsapp.net",
                      "data": {"key": {"remoteJid": f"{para}@s.whatsapp.net", "fromMe": de_mim, "id": f"T{time.time_ns()}"},
                               "pushName": nome, "message": {"conversation": texto}}})


def espera(q, tentativas=30):
    r = ""
    for _ in range(tentativas):
        time.sleep(3)
        r = sql(q)
        if r and r != "0":
            break
    return r


TOK = post("painel", {"acao": "login", "dados": {"login": env["ADMIN_LOGIN"], "senha": env["ADMIN_SENHA"]}})[1]["token"]
antes = {k: sql(f"SELECT valor::text FROM nucleo.config WHERE chave = '{k}'") for k in ["joao_observar", "joao_modo", "gabriel_modo"]}
inicio = sql("SELECT now()")

try:
    sql("UPDATE nucleo.config SET valor = '\"todos\"' WHERE chave = 'joao_observar'")
    sql("UPDATE nucleo.config SET valor = '\"observando\"' WHERE chave IN ('joao_modo', 'gabriel_modo')")

    print("== aprende sozinho (sem precisar aceitar)")
    zap("joao", NUM["joao"], CLI, "Oi, voces entregam no sabado?", nome="Cliente Teste")
    time.sleep(2)
    zap("joao", NUM["joao"], CLI, "Entregamos sim! Sabado das 8h ao meio-dia, frete gratis acima de R$ 200.", de_mim=True)
    time.sleep(5)
    api("admin_aprender_agora")
    k = sql(f"SELECT count(*) FILTER (WHERE aprovado), count(*) FROM nucleo.conhecimento WHERE agente = 'joao' AND origem = 'observacao' AND criado_em >= '{inicio}'")
    print(f"    joao aprendeu (valendo, total): {k}")
    v, t = (k.split("|") + ["0", "0"])[:2]
    confere("Joao aprendeu e ja vale (nada para aceitar)", t != "0" and v == t, k)

    print("\n== conversa 'Voce' no numero do Joao: ele responde e aprende")
    zap("joao", NUM["joao"], NUM["joao"], "Joao, a partir de hoje o plano Omega custa R$ 123 por mes. Sempre fale isso quando perguntarem.", de_mim=True)
    resp = espera(f"SELECT mensagem FROM nucleo.conversas WHERE agente = 'joao-dono' AND papel = 'ia' AND criado_em >= '{inicio}' LIMIT 1")
    print(f"    joao -> voce: {resp}")
    confere("Joao respondeu voce (mesmo em 'so observando')", bool(resp), resp)
    confere("nada foi para a fila de aprovacao", sql(f"SELECT count(*) FROM nucleo.atendimento_fila WHERE criado_em >= '{inicio}'") == "0")
    api("admin_aprender_agora")
    k = sql(f"SELECT string_agg(conteudo, ' | ') FROM nucleo.conhecimento WHERE agente = 'joao' AND origem = 'ensinado_pelo_dono' AND criado_em >= '{inicio}'")
    print(f"    joao aprendeu com voce: {k}")
    confere("Joao aprendeu o que voce ensinou (Omega R$ 123)", "123" in k, k)
    s, r = post("painel", {"acao": "admin_atendimento_teste", "dados": {"mensagem": "quanto custa o plano Omega?", "sessao": "dono1", "agente": "joao"}}, TOK)
    resp = (r.get("resposta") or r.get("erro") or "")
    print(f"    cliente pergunta -> joao: {resp}")
    confere("Joao usa com cliente o que voce ensinou", "123" in resp, resp)

    print("\n== conversa 'Voce' no numero do Gabriel")
    zap("gabriel", NUM["gabriel"], NUM["gabriel"], "Gabriel, quando alguem pedir dinheiro emprestado fala que ta apertado esse mes, sem enrolar muito.", de_mim=True)
    resp = espera(f"SELECT mensagem FROM nucleo.conversas WHERE agente = 'gabriel-dono' AND papel = 'ia' AND criado_em >= '{inicio}' LIMIT 1")
    print(f"    gabriel -> voce: {resp}")
    confere("Gabriel respondeu voce", bool(resp), resp)
    api("admin_aprender_agora")
    k = sql(f"SELECT string_agg(conteudo, ' | ') FROM nucleo.conhecimento WHERE agente = 'gabriel' AND origem = 'ensinado_pelo_dono' AND criado_em >= '{inicio}'")
    print(f"    gabriel aprendeu com voce: {k}")
    confere("Gabriel aprendeu (so ele)", "apertad" in k.lower() or "emprest" in k.lower(), k)
    vazou = sql(f"SELECT coalesce(string_agg(conteudo, ' | '), '') FROM nucleo.conhecimento WHERE agente IN ('leo', 'suporte') AND criado_em >= '{inicio}'"
                "  AND (conteudo ILIKE '%omega%' OR conteudo ILIKE '%emprest%' OR conteudo ILIKE '%sabado%')")
    confere("nada do que foi ensinado ao Joao/Gabriel foi para o Leo ou o Suporte", vazou == "", vazou)

    print("\n== conversa 'Voce' no numero do Leo (numero que nao e o do seu perfil)")
    zap("nucleo", NUM["nucleo"], NUM["nucleo"], "Leo, me lembra que eu prefiro reunioes de manha.", de_mim=True)
    resp = espera(f"SELECT count(*) FROM nucleo.conversas WHERE agente = 'ia-pessoal' AND papel = 'usuario' AND contato = '{NUM['nucleo']}' AND criado_em >= '{inicio}'")
    confere("Leo trata como voce (responde, nao so observa)", resp not in ("", "0"), resp)
finally:
    print("\n== limpeza")
    sql(f"DELETE FROM nucleo.conhecimento WHERE criado_em >= '{inicio}'")
    sql(f"DELETE FROM nucleo.conversas WHERE criado_em >= '{inicio}' AND (contato LIKE '{CLI}%' OR contato LIKE '55009000000%')")
    sql(f"DELETE FROM nucleo.conversas WHERE criado_em >= '{inicio}' AND agente LIKE '%-dono'")
    sql(f"DELETE FROM nucleo.clientes WHERE whatsapp = '{CLI}'")
    sql("DELETE FROM nucleo.aprendiz_progresso WHERE agente = 'dono'")
    sql(f"DELETE FROM nucleo.lote_mensagens WHERE criado_em >= '{inicio}'")
    sql("DELETE FROM nucleo_memoria_chat WHERE session_id LIKE 'dono:%' OR session_id LIKE '%dono1%'")
    sql(f"DELETE FROM nucleo.eventos WHERE criado_em >= '{inicio}'")
    for k, v in antes.items():
        if v:
            sql(f"UPDATE nucleo.config SET valor = '{v}'::jsonb WHERE chave = '{k}'")

print(f"\n{'TUDO OK' if not falhas else f'{falhas} FALHA(S)'}")
