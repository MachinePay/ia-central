"""Gabriel no numero proprio (instancia 'gabriel'): le tudo desse numero para aprender, responde so liberados,
e o numero do Leo nao aciona mais o Gabriel.

Uso: python scripts/testar_gabriel_chip.py   (numeros DDD 00 nao existem no WhatsApp; desfaz tudo no final)
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
DONO, AMIGO, OUTRO = "5500900000000", "5500956780000", "5500999990000"
falhas = 0


def post(caminho, corpo, tok=""):
    req = urllib.request.Request(f"{U}/{caminho}", json.dumps(corpo).encode(), {"Content-Type": "application/json", "Authorization": "Bearer " + tok})
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def sql(q):
    return subprocess.run(["docker", "compose", "exec", "-T", "postgres", "psql", "-U", env["POSTGRES_USER"], env["POSTGRES_DB"], "-tAc", q],
                          cwd=PROJ, capture_output=True, text=True, encoding="utf-8").stdout.strip()


def confere(nome, cond, extra=""):
    global falhas
    print(("  OK   " if cond else "  FALHA") + f" {nome}" + (f"  -> {str(extra)[:300]}" if not cond else ""))
    falhas += 0 if cond else 1


def zap(inst, numero, texto, de_mim=False, nome=""):
    apikey = env["WHATSAPP_WEBHOOK_SEGREDO"] + ("" if inst == "nucleo" else "-" + inst)
    post("whatsapp", {"event": "messages.upsert", "instance": inst, "apikey": apikey, "sender": f"{DONO}@s.whatsapp.net",
                      "data": {"key": {"remoteJid": f"{numero}@s.whatsapp.net", "fromMe": de_mim, "id": f"T{time.time_ns()}"},
                               "pushName": nome, "message": {"conversation": texto}}})


TOK = post("painel", {"acao": "login", "dados": {"login": env["ADMIN_LOGIN"], "senha": env["ADMIN_SENHA"]}})[1]["token"]
antes = {k: sql(f"SELECT valor::text FROM nucleo.config WHERE chave = '{k}'") for k in ["gabriel_modo", "gabriel_observar"]}
inicio = sql("SELECT now()")

try:
    print("== configuracao")
    confere("instancia 'gabriel' e do Gabriel", sql("SELECT nucleo.papel_instancia('gabriel')") == "gabriel")
    confere("Gabriel le tudo do numero dele por padrao", sql("SELECT nucleo.cfg('gabriel_observar', '?')") == "todos")
    s, r = post("painel", {"acao": "admin_whatsapp", "dados": {"op": "status", "instancia": "gabriel"}}, TOK)
    confere("painel consulta o WhatsApp do Gabriel (nao o do Leo)", s == 200, (s, r))

    print("\n== aprende com o que voce escreve no numero dele")
    zap("gabriel", OUTRO, "fala mano, amanha nao rola, bora quinta?", de_mim=True)
    time.sleep(5)
    confere("sua mensagem guardada como aprendizado do Gabriel",
            sql(f"SELECT count(*) FROM nucleo.conversas WHERE agente = 'gabriel-observa' AND papel = 'humano' AND instancia = 'gabriel' AND contato LIKE '{OUTRO}%'") == "1")
    confere("entra na fila do aprendiz (chave g:)", sql(f"SELECT count(*) FROM nucleo.aprendiz_pendentes_todos(50) WHERE chave = 'g:{OUTRO}'") == "1")

    print("\n== responde so quem voce liberou")
    post("painel", {"acao": "admin_observacao_add", "dados": {"agente": "gabriel", "numero": AMIGO, "nome": "Amigo Teste", "regra": "incluir"}}, TOK)
    sql("UPDATE nucleo.config SET valor = '\"aprovacao\"' WHERE chave = 'gabriel_modo'")
    zap("gabriel", OUTRO, "e ai, vai no jogo?", nome="Outro")
    zap("gabriel", AMIGO, "opa, tudo certo? me empresta teu carro sabado?", nome="Amigo Teste")
    fila = ""
    for _ in range(40):
        time.sleep(3)
        fila = sql(f"SELECT rascunho FROM nucleo.atendimento_fila WHERE agente = 'gabriel' AND numero = '{AMIGO}' AND criado_em >= '{inicio}'")
        if fila:
            break
    print(f"    [gabriel] < {fila}")
    confere("liberado: Gabriel escreveu a resposta (esperando aprovacao)", bool(fila))
    confere("nao liberado: nao responde", sql(f"SELECT count(*) FROM nucleo.atendimento_fila WHERE numero = '{OUTRO}' AND criado_em >= '{inicio}'") == "0")

    print("\n== numero do Leo nao aciona o Gabriel")
    zap("nucleo", AMIGO, "oi, ta ai?", nome="Amigo Teste")
    time.sleep(20)
    confere("mensagem no numero do Leo nao vira resposta do Gabriel",
            sql(f"SELECT count(*) FROM nucleo.atendimento_fila WHERE agente = 'gabriel' AND numero = '{AMIGO}' AND criado_em >= '{inicio}'") == "1")

    print("\n== painel")
    s, saude = post("painel", {"acao": "admin_saude", "dados": {}}, TOK)
    g = next((a for a in saude.get("agentes", []) if a["agente"] == "gabriel"), {})
    confere("saude do Gabriel usa o numero dele e conta o que leu", g.get("instancia") == "gabriel" and g.get("lidas_24h", 0) >= 3, g)
finally:
    print("\n== limpeza")
    sql(f"DELETE FROM nucleo.atendimento_fila WHERE criado_em >= '{inicio}' AND numero IN ('{AMIGO}', '{OUTRO}')")
    sql(f"DELETE FROM nucleo.conversas WHERE criado_em >= '{inicio}' AND (contato LIKE '{AMIGO}%' OR contato LIKE '{OUTRO}%')")
    sql(f"DELETE FROM nucleo.observacao_lista WHERE numero IN ('{AMIGO}', '{OUTRO}')")
    sql(f"DELETE FROM nucleo.lote_mensagens WHERE chave LIKE '%{AMIGO}%' OR chave LIKE '%{OUTRO}%'")
    sql("DELETE FROM nucleo_memoria_chat WHERE session_id LIKE 'g:%'")
    for k, v in antes.items():
        if v:
            sql(f"UPDATE nucleo.config SET valor = '{v}'::jsonb WHERE chave = '{k}'")

print(f"\n{'TUDO OK' if not falhas else f'{falhas} FALHA(S)'}")
