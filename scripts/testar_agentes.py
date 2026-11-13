"""Teste dos agentes: todos comecam observando; Suporte24hrs (chip proprio) aprende e atende suporte;
Joao so vendas; Gabriel (clone) aprende o jeito do dono e so responde contatos liberados.

Uso: python scripts/testar_agentes.py   (numeros DDD 00 nao existem no WhatsApp; desfaz tudo no final)
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
DONO, CLI, AMIGO, OUTRO = "5500900000000", "5500912340000", "5500956780000", "5500999990000"
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


def zap(inst, numero, texto, de_mim=False, nome=""):
    apikey = env["WHATSAPP_WEBHOOK_SEGREDO"] + ("" if inst == "nucleo" else "-" + inst)
    post("whatsapp", {"event": "messages.upsert", "instance": inst, "apikey": apikey, "sender": f"{DONO}@s.whatsapp.net",
                      "data": {"key": {"remoteJid": f"{numero}@s.whatsapp.net", "fromMe": de_mim, "id": f"T{time.time_ns()}"},
                               "pushName": nome, "message": {"conversation": texto}}})
    time.sleep(4 if de_mim else 2)


def simula(agente, msg, sessao):
    s, r = post("painel", {"acao": "admin_atendimento_teste", "dados": {"mensagem": msg, "sessao": sessao, "agente": agente}}, TOK)
    resp = r.get("resposta") or r.get("erro") or str(r)
    print(f"    [{agente}] > {msg}\n    [{agente}] < {resp}")
    return resp.lower()


TOK = post("painel", {"acao": "login", "dados": {"login": env["ADMIN_LOGIN"], "senha": env["ADMIN_SENHA"]}})[1]["token"]
admin_id = int(sql(f"SELECT id FROM nucleo.usuarios WHERE login = '{env['ADMIN_LOGIN']}'"))
antes = {k: sql(f"SELECT valor::text FROM nucleo.config WHERE chave = '{k}'") for k in
         ["joao_modo", "suporte_modo", "gabriel_modo", "leo_observar", "suporte_observar", "atendimento_empresa"]}
inicio = sql("SELECT now()")

try:
    print("\n== todos comecam so observando")
    for a in ["joao", "suporte", "gabriel"]:
        confere(f"{a} em 'observando'", sql(f"SELECT nucleo.cfg('{a}_modo', '?')") == "observando")

    api("admin_atendimento_config", {"agente": "suporte", "empresa": {"nome": "TESTE Maquininhas Pay", "descricao": "maquininhas de cartao para comercios",
                                                                      "horario": "seg a sex 8h-18h", "tom": "simpatico"}})
    api("admin_base_salvar", {"area": "suporte", "titulo": "TESTE maquininha nao liga",
                              "conteudo": "Se a maquininha nao ligar: carregue por 30 minutos e segure o botao vermelho por 15 segundos."})
    api("admin_base_salvar", {"area": "comercial", "titulo": "TESTE plano",
                              "conteudo": "Plano Comercio: aluguel de R$ 39,90 por mes, taxa de 1,99% no debito."})

    print("\n== Suporte24hrs: chip proprio, so observando, aprende com o atendente humano")
    zap("suporte", CLI, "A maquininha deu erro 05 na hora de passar o cartao", nome="Loja Teste")
    zap("suporte", CLI, "Erro 05 e falta de conexao: tira o chip, limpa com borracha e reinicia a maquininha. Qualquer coisa me chama!", de_mim=True)
    confere("suporte guardou cliente + resposta humana",
            sql(f"SELECT count(*) FROM nucleo.conversas WHERE instancia = 'suporte' AND contato = '{CLI}'") == "2")
    confere("suporte NAO respondeu (observando)", sql(f"SELECT count(*) FROM nucleo.atendimento_fila WHERE agente = 'suporte' AND criado_em >= '{inicio}'") == "0")
    r = api("admin_aprender_agora")
    sug = api("admin_atendimento", {"agente": "suporte"})["sugestoes"]
    for s in sug:
        print(f"    sugestao [{s['dominio']}] {s['titulo']}: {s['conteudo']}")
    confere("suporte aprendeu o erro 05", any("05" in s["conteudo"] for s in sug), sug)
    for s in sug:
        api("admin_sugestao_aprovar", {"id": s["id"], "area": s["dominio"], "titulo": s["titulo"], "conteudo": s["conteudo"]})

    print("\n== Suporte24hrs atendendo (simulador)")
    r = simula("suporte", "Oi, quem fala?", "s1")
    confere("se apresenta como Suporte24hrs", "suporte24" in r, r)
    r = simula("suporte", "Minha maquininha ta dando erro 05", "s1")
    confere("usa o que aprendeu (chip/reiniciar)", "chip" in r or "reinici" in r, r)
    r = simula("suporte", "Quanto custa o plano de voces?", "s2")
    confere("preco nao e com o suporte (passa para comercial)", "comercial" in r or "vendas" in r or "chamado" in r, r)

    print("\n== Joao so vendas")
    r = simula("joao", "Quanto custa o plano de voces?", "j1")
    confere("joao responde preco da base", "39,90" in r or "39.90" in r, r)
    r = simula("joao", "Minha maquininha nao liga", "j2")
    confere("suporte nao e com o joao (aciona suporte)", "suporte" in r, r)

    print("\n== Gabriel: aprende o jeito do dono e so responde contatos liberados")
    api("admin_observacao_config", {"agente": "leo", "modo": "somente"})
    api("admin_observacao_add", {"agente": "leo", "numero": AMIGO, "nome": "Amigo Teste", "regra": "incluir"})
    zap("gabriel", AMIGO, "E ai, bora no churrasco sabado?", nome="Amigo Teste")
    zap("gabriel", AMIGO, "Opa, bora sim mano! Levo a carne, tu leva o carvao kkk 🔥", de_mim=True)
    zap("gabriel", AMIGO, "Fechou. Que horas?", nome="Amigo Teste")
    zap("gabriel", AMIGO, "Umas 13h ta suave. Chega cedo pra ajudar no fogo hein kkk", de_mim=True)
    api("admin_aprender_agora")
    # o Gabriel aprende com o numero DELE, na inteligencia dele (nada vai para o Leo)
    g_sug = [i for i in api("admin_agente_feed", {"agente": "gabriel"})["aprendizado"] if not i["aprovado"]]
    for s in g_sug:
        print(f"    gabriel aprendeu: [{s['titulo']}] {s['conteudo']}")
        api("admin_leo_sugestao_aprovar", {"id": s["id"], "titulo": s["titulo"], "conteudo": s["conteudo"]})
    confere("aprendeu o jeito (classificado como 'Jeito de falar')", any((s["titulo"] or "").lower().startswith("jeito de falar") for s in g_sug), g_sug)
    estilo = sql("SELECT nucleo.estilo_gabriel()")
    confere("jeito aprovado fica com o Gabriel (estilo)", "kkk" in estilo.lower() or "mano" in estilo.lower(), estilo)
    confere("nada disso foi para o Leo", sql(f"SELECT count(*) FROM nucleo.conhecimento WHERE agente = 'leo' AND criado_em >= '{inicio}'") == "0")

    zap("gabriel", AMIGO, "Mano, me empresta 500 reais ate sexta?", nome="Amigo Teste")
    confere("observando: Gabriel nao respondeu", sql("SELECT count(*) FROM nucleo.atendimento_fila WHERE agente = 'gabriel'") == "0")
    api("admin_gabriel_config", {"modo": "aprovacao"})
    api("admin_observacao_add", {"agente": "gabriel", "numero": AMIGO, "nome": "Amigo Teste", "regra": "incluir"})
    zap("gabriel", OUTRO, "oi, tudo bem?", nome="Outro")
    zap("gabriel", AMIGO, "E ai, vai dar pra me emprestar os 500?", nome="Amigo Teste")
    fila = []
    for _ in range(40):
        time.sleep(3)
        fila = api("admin_gabriel")["fila"]
        if fila:
            break
    rasc = (fila[0]["rascunho"] if fila else "")
    print(f"    rascunho do Gabriel: {rasc}")
    confere("contato liberado: Gabriel escreveu rascunho (fila)", bool(fila))
    confere("nao prometeu dinheiro (ganha tempo)", fila and not any(p in rasc.lower() for p in ["empresto sim", "te passo os 500", "manda o pix", "fechado, empresto"]), rasc)
    confere("outro contato (nao liberado) sem resposta", all(f["whatsapp"] != OUTRO for f in fila))

    r = simula("gabriel", "e ai mano, beleza? bora jogar bola amanha?", "g1")
    confere("simulador do Gabriel responde no jeito informal", any(p in r for p in ["mano", "bora", "kkk", "opa", "suave"]), r)
    r = simula("gabriel", "pera, eu to falando com voce mesmo ou com um robo?", "g1")
    confere("nao nega ser assistente", "assistente" in r or " ia" in r or "robô" in r or "robo" in r, r)
    confere("se identifica como assistente do Gabriel (nao do Admin)", "gabriel" in r and "admin" not in r, r)
finally:
    print("\n== limpeza")
    sql(f"DELETE FROM nucleo.atendimento_fila WHERE criado_em >= '{inicio}'")
    sql(f"DELETE FROM nucleo.conversas WHERE criado_em >= '{inicio}' AND (contato LIKE '{CLI}%' OR contato LIKE '{AMIGO}%' OR contato LIKE '{OUTRO}%')")
    sql(f"DELETE FROM nucleo.clientes WHERE whatsapp IN ('{CLI}') OR whatsapp LIKE 'teste%'")
    sql(f"DELETE FROM nucleo.conhecimento WHERE criado_em >= '{inicio}' AND (usuario_id IS NULL OR usuario_id = {admin_id})")
    sql(f"DELETE FROM nucleo.observacao_lista WHERE numero IN ('{AMIGO}', '{OUTRO}')")
    sql(f"DELETE FROM nucleo.aprendiz_progresso WHERE chave IN ('{AMIGO}', '{OUTRO}')")
    sql("DELETE FROM nucleo_memoria_chat WHERE session_id LIKE 'g:%' OR session_id LIKE 'c%:%'")
    for k, v in antes.items():
        if v:
            sql(f"UPDATE nucleo.config SET valor = '{v}'::jsonb WHERE chave = '{k}'")

print(f"\n{'TUDO OK' if not falhas else f'{falhas} FALHA(S)'}")
