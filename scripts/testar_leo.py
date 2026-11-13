"""Teste do Leo 2.0 no numero pessoal: filtro de leitura (so escolhidos / todos menos) + aprendizado
do jeito de falar e de resolver + uso desse jeito nas respostas.

Uso: python scripts/testar_leo.py   (numeros com DDD 00: nao existem no WhatsApp; desfaz tudo no final)
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
DONO, SOCIO, MAE, FORNECEDOR = "5500900000000", "5500911112222", "5500933334444", "5500955556666"
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


def zap(numero, texto, de_mim=False, nome=""):
    post("whatsapp", {"event": "messages.upsert", "instance": "nucleo", "apikey": env["WHATSAPP_WEBHOOK_SEGREDO"],
                      "sender": f"{DONO}@s.whatsapp.net",
                      "data": {"key": {"remoteJid": f"{numero}@s.whatsapp.net", "fromMe": de_mim, "id": f"T{time.time_ns()}"},
                               "pushName": nome, "message": {"conversation": texto}}})
    time.sleep(4 if de_mim else 2)


def lidas(numero):
    return int(sql(f"SELECT count(*) FROM nucleo.conversas WHERE agente = 'leo-observa' AND contato LIKE '{numero}%'") or 0)


TOK = post("painel", {"acao": "login", "dados": {"login": env["ADMIN_LOGIN"], "senha": env["ADMIN_SENHA"]}})[1]["token"]
admin_id = int(sql(f"SELECT id FROM nucleo.usuarios WHERE login = '{env['ADMIN_LOGIN']}'"))
modo_antes = sql("SELECT valor #>> '{}' FROM nucleo.config WHERE chave = 'leo_observar'") or "somente"
inicio = sql("SELECT now()")

try:
    print("\n== filtro 'so escolhidos': so o socio")
    api("admin_observacao_config", {"agente": "leo", "modo": "somente"})
    api("admin_observacao_add", {"agente": "leo", "numero": SOCIO, "nome": "Socio Teste", "regra": "incluir"})
    zap(MAE, "filho, vem almocar domingo?", nome="Mae")
    zap(MAE, "vou sim mae, levo a sobremesa", de_mim=True)
    zap(SOCIO, "Fala! O cliente da padaria reclamou que a maquina travou de novo", nome="Socio")
    zap(SOCIO, "Fala mano! Tranquilo, manda o tecnico amanha cedo e da 10% de desconto na mensalidade pra segurar ele. "
               "Cliente reclamou, a gente resolve rapido e sem enrolar 👊", de_mim=True)
    zap(SOCIO, "Beleza. E a reuniao com o banco?", nome="Socio")
    zap(SOCIO, "Bora quinta 10h. Leva o contrato e a planilha de custos, sem isso nem adianta ir kkk", de_mim=True)
    confere("mae (fora da lista) NAO foi lida", lidas(MAE) == 0)
    confere("socio + suas respostas lidos (4)", lidas(SOCIO) == 4, lidas(SOCIO))

    print("\n== filtro 'todos menos': exclui a mae")
    api("admin_observacao_config", {"agente": "leo", "modo": "exceto"})
    api("admin_observacao_add", {"agente": "leo", "numero": MAE, "nome": "Mae", "regra": "excluir"})
    zap(MAE, "nao esquece o guarda-chuva", nome="Mae")
    zap(FORNECEDOR, "Boa tarde, o pedido de bobinas atrasou 2 dias", nome="Fornecedor")
    confere("mae excluida continua sem ser lida", lidas(MAE) == 0)
    confere("fornecedor (qualquer outro) foi lido", lidas(FORNECEDOR) == 1)

    print("\n== Leo aprende")
    r = api("admin_aprender_agora")
    print(f"    aprender agora: {r}")
    sug = api("admin_observacao")["leo_sugestoes"]
    for s in sug:
        print(f"    [{s['titulo']}] {s['conteudo']}")
    tudo = " ".join((s["titulo"] or "") + " " + s["conteudo"] for s in sug).lower()
    confere("aprendeu o jeito de falar", "jeito de falar" in tudo, tudo)
    confere("aprendeu como resolve (desconto/tecnico rapido)", "desconto" in tudo or "tecnico" in tudo or "técnico" in tudo, tudo)
    confere("nada da conversa com a mae", "almoc" not in tudo and "sobremesa" not in tudo, tudo)
    for s in sug:
        api("admin_leo_sugestao_aprovar", {"id": s["id"], "titulo": s["titulo"], "conteudo": s["conteudo"]})
    estilo = sql(f"SELECT nucleo.estilo_dono({admin_id})")
    confere("estilo aprovado chega ao Leo", len(estilo) > 20, estilo)

    print("\n== Leo usa o que aprendeu")
    s, r = post("painel", {"acao": "chat", "dados": {"mensagem": "Um cliente reclamou que a maquina travou. Como eu costumo resolver isso? Responde no meu jeito.", "sessao": "teste-leo"}}, TOK)
    resp = (r.get("resposta") or "")
    print(f"    < {resp}")
    confere("resposta usa o jeito/solucao aprendidos", any(p in resp.lower() for p in ["desconto", "técnico", "tecnico", "10%"]), resp)
finally:
    print("\n== limpeza")
    sql(f"DELETE FROM nucleo.conversas WHERE agente = 'leo-observa' AND criado_em >= '{inicio}'")
    sql(f"DELETE FROM nucleo.conhecimento WHERE usuario_id = {admin_id} AND criado_em >= '{inicio}'")
    sql(f"DELETE FROM nucleo.observacao_lista WHERE numero IN ('{SOCIO}', '{MAE}', '{FORNECEDOR}')")
    sql(f"DELETE FROM nucleo.aprendiz_progresso WHERE agente = 'leo' AND chave IN ('{SOCIO}', '{MAE}', '{FORNECEDOR}')")
    sql("DELETE FROM nucleo_memoria_chat WHERE session_id LIKE '%:teste-leo'")
    sql(f"UPDATE nucleo.config SET valor = to_jsonb('{modo_antes}'::text) WHERE chave = 'leo_observar'")

print(f"\n{'TUDO OK' if not falhas else f'{falhas} FALHA(S)'}")
