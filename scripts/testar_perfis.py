"""Perfil de cada contato: a IA percebe quem e a pessoa (nova, amigo, intima...) e ajusta o jeito de falar.

Uso: python scripts/testar_perfis.py   (numeros DDD 00 nao existem no WhatsApp; desfaz tudo no final)
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
G, J = "5500900000012", "5500900000011"                     # "numeros" do Gabriel e do Joao no teste
NAMORADA, AMIGO, NOVO = "5500977770001", "5500977770002", "5500977770003"
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


def zap(inst, eu, outro, texto, de_mim=False, nome=""):
    apikey = env["WHATSAPP_WEBHOOK_SEGREDO"] + ("" if inst == "nucleo" else "-" + inst)
    post("whatsapp", {"event": "messages.upsert", "instance": inst, "apikey": apikey, "sender": f"{eu}@s.whatsapp.net",
                      "data": {"key": {"remoteJid": f"{outro}@s.whatsapp.net", "fromMe": de_mim, "id": f"T{time.time_ns()}"},
                               "pushName": nome, "message": {"conversation": texto}}})
    time.sleep(3.5 if de_mim else 1.5)


TOK = post("painel", {"acao": "login", "dados": {"login": env["ADMIN_LOGIN"], "senha": env["ADMIN_SENHA"]}})[1]["token"]
antes = {k: sql(f"SELECT valor::text FROM nucleo.config WHERE chave = '{k}'") for k in ["gabriel_modo", "gabriel_observar", "joao_observar"]}
inicio = sql("SELECT now()")

try:
    sql("UPDATE nucleo.config SET valor = '\"todos\"' WHERE chave IN ('gabriel_observar', 'joao_observar')")
    sql("UPDATE nucleo.config SET valor = '\"observando\"' WHERE chave = 'gabriel_modo'")
    print("== conversas no numero do Gabriel")
    zap("gabriel", G, NAMORADA, "Amor, que horas vc chega hoje?", nome="Ana")
    zap("gabriel", G, NAMORADA, "Oi meu amor ❤️ chego umas 19h, quer que eu leve alguma coisa?", de_mim=True)
    zap("gabriel", G, NAMORADA, "Traz pao e aquele chocolate que eu gosto 😘 te amo", nome="Ana")
    zap("gabriel", G, NAMORADA, "Levo sim minha linda, te amo tambem 😘", de_mim=True)
    zap("gabriel", G, AMIGO, "E ai mano, bora futebol quinta?", nome="Rafael")
    zap("gabriel", G, AMIGO, "Bora parca! 20h na quadra de sempre kkkk", de_mim=True)
    zap("joao", J, NOVO, "Boa tarde, gostaria de informacoes sobre os planos", nome="Marcia")
    time.sleep(4)
    api("admin_aprender_agora")
    p = sql(f"SELECT numero || '=' || relacao || '/' || genero || ' | tom: ' || coalesce(tom, '') FROM nucleo.perfis_contato WHERE numero IN ('{NAMORADA}', '{AMIGO}') ORDER BY numero")
    print("    perfis:\n      " + p.replace("\n", "\n      "))
    confere("namorada percebida como relacao intima (mulher)", f"{NAMORADA}=namorada_conjuge/mulher" in p, p)
    confere("amigo percebido como amigo", f"{AMIGO}=amigo" in p, p)
    t = sql(f"SELECT nucleo.perfil_texto('joao', '{NOVO}')")
    confere("cliente que escreveu pela primeira vez = pessoa nova", "pessoa nova" in t, t)

    print("\n== Gabriel responde a namorada com cuidado (contato liberado, com aprovacao)")
    api("admin_observacao_add", {"agente": "gabriel", "numero": NAMORADA, "nome": "Ana", "regra": "incluir"})
    sql("UPDATE nucleo.config SET valor = '\"aprovacao\"' WHERE chave = 'gabriel_modo'")
    zap("gabriel", G, NAMORADA, "Amor, me empresta 300 reais ate sexta? e vamos viajar mes que vem?", nome="Ana")
    rasc = ""
    for _ in range(40):
        time.sleep(3)
        rasc = sql(f"SELECT rascunho FROM nucleo.atendimento_fila WHERE agente = 'gabriel' AND numero = '{NAMORADA}' AND criado_em >= '{inicio}'")
        if rasc:
            break
    print(f"    gabriel -> namorada: {rasc}")
    confere("respondeu com carinho", any(w in rasc.lower() for w in ["amor", "linda", "❤", "😘", "vida", "gata", "bb"]), rasc)
    confere("nao prometeu dinheiro nem viagem", not any(w in rasc.lower() for w in ["te empresto", "empresto sim", "mando o pix", "vamos sim", "fechado a viagem"]), rasc)

    print("\n== voce corrige no painel e vale mais que a IA")
    api("admin_perfil_salvar", {"agente": "gabriel", "numero": AMIGO, "relacao": "trabalho"})
    sql(f"SELECT nucleo.perfil_salvar('gabriel', 'g:{AMIGO}', '{{\"relacao\": \"amigo\", \"genero\": \"homem\"}}')")
    confere("correcao manual nao e trocada pelo aprendiz", sql(f"SELECT relacao FROM nucleo.perfis_contato WHERE agente = 'gabriel' AND numero = '{AMIGO}'") == "trabalho")
    f = api("admin_agente_feed", {"agente": "gabriel"})
    conv = next((c for c in f.get("conversas", []) if c["numero"] == NAMORADA), {})
    confere("painel mostra o perfil na conversa", (conv.get("perfil") or {}).get("relacao") == "namorada_conjuge", conv.get("perfil"))
finally:
    print("\n== limpeza")
    nums = f"('{NAMORADA}', '{AMIGO}', '{NOVO}')"
    sql(f"DELETE FROM nucleo.perfis_contato WHERE numero IN {nums}")
    sql(f"DELETE FROM nucleo.atendimento_fila WHERE criado_em >= '{inicio}'")
    sql(f"DELETE FROM nucleo.conversas WHERE criado_em >= '{inicio}' AND (split_part(contato, ' ', 1) IN {nums} OR agente LIKE '%-dono')")
    sql(f"DELETE FROM nucleo.clientes WHERE whatsapp IN {nums}")
    sql(f"DELETE FROM nucleo.observacao_lista WHERE numero IN {nums}")
    sql(f"DELETE FROM nucleo.conhecimento WHERE criado_em >= '{inicio}'")
    sql(f"DELETE FROM nucleo.aprendiz_progresso WHERE chave LIKE 'g:5500977770%' OR chave LIKE 'dono:%'")
    sql(f"DELETE FROM nucleo.lote_mensagens WHERE criado_em >= '{inicio}'")
    sql("DELETE FROM nucleo_memoria_chat WHERE session_id LIKE 'g:5500977770%'")
    for k, v in antes.items():
        if v:
            sql(f"UPDATE nucleo.config SET valor = '{v}'::jsonb WHERE chave = '{k}'")

print(f"\n{'TUDO OK' if not falhas else f'{falhas} FALHA(S)'}")
