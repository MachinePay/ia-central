"""Teste da atendente (suporte, comercial, sistemico) + fila de aprovacao + aprendizado.

Uso: python scripts/testar_atendente.py
Usa uma empresa ficticia, conversa pelo simulador, simula um cliente no WhatsApp (modo dedicado),
aprova a resposta e confere se a IA aprendeu. Desfaz tudo no final (base, config, clientes de teste).
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
falhas = 0


def post(caminho, corpo, tok=""):
    req = urllib.request.Request(f"{U}/{caminho}", json.dumps(corpo).encode(), {"Content-Type": "application/json", "Authorization": "Bearer " + tok})
    try:
        with urllib.request.urlopen(req, timeout=240) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def api(acao, dados=None):
    return post("painel", {"acao": acao, "dados": dados or {}}, TOK)


def sql(q):
    return subprocess.run(["docker", "compose", "exec", "-T", "postgres", "psql", "-U", env["POSTGRES_USER"], env["POSTGRES_DB"], "-tAc", q],
                          cwd=PROJ, capture_output=True, text=True, encoding="utf-8").stdout.strip()


def confere(nome, cond, extra=""):
    global falhas
    print(("  OK   " if cond else "  FALHA") + f" {nome}" + (f"  -> {str(extra)[:300]}" if not cond else ""))
    falhas += 0 if cond else 1


def cliente(msg, sessao):
    t = time.time()
    s, r = api("admin_atendimento_teste", {"mensagem": msg, "sessao": sessao})
    resp = r.get("resposta") or r.get("erro") or str(r)
    print(f"    cliente> {msg}\n    IA ({time.time()-t:.0f}s)> {resp}")
    return resp.lower()


TOK = post("painel", {"acao": "login", "dados": {"login": env["ADMIN_LOGIN"], "senha": env["ADMIN_SENHA"]}})[1]["token"]
cfg_antes = sql("SELECT valor::text FROM nucleo.config WHERE chave = 'atendimento_empresa'")
modo_antes = sql("SELECT valor #>> '{}' FROM nucleo.config WHERE chave = 'atendimento_modo'")
zap_antes = sql("SELECT valor #>> '{}' FROM nucleo.config WHERE chave = 'whatsapp_modo'")
inicio = sql("SELECT now()")

try:
    print("\n== preparando empresa ficticia e base")
    api("admin_atendimento_config", {"modo": "aprovacao", "empresa": {
        "nome": "TESTE Lavanderia Nuvem", "descricao": "App de lavanderia com coleta e entrega em casa",
        "horario": "segunda a sexta, 8h as 18h", "tom": "simpatico e objetivo"}})
    api("admin_base_salvar", {"area": "comercial", "titulo": "TESTE planos", "conteudo":
        "Plano Basico: R$ 49,90 por mes, 4 coletas. Plano Familia: R$ 89,90 por mes, 10 coletas. Sem fidelidade, pagamento por Pix ou cartao."})
    api("admin_base_salvar", {"area": "suporte", "titulo": "TESTE esqueci a senha", "conteudo":
        "Para recuperar a senha: no app toque em Entrar > Esqueci minha senha, informe o e-mail e siga o link enviado (veja o spam)."})
    sql("UPDATE nucleo.sistemas SET publico = true WHERE nome = 'n8n (proprio)'")

    print("\n== recepcao + comercial")
    r = cliente("Oi! Quanto custa o plano de voces?", "t1")
    confere("comercial usou a base (preco certo)", "49,90" in r or "49.90" in r, r)

    print("\n== suporte")
    r = cliente("Esqueci minha senha do app, como faco?", "t2")
    confere("suporte usou a base (passo a passo)", "esqueci" in r and "mail" in r, r)

    print("\n== sistemico")
    r = cliente("O sistema de voces esta fora do ar?", "t3")
    confere("sistemico consultou o status", any(p in r for p in ["funcionando", "normal", "instabilidade", "no ar", "operando"]), r)

    print("\n== pedido de humano vira chamado")
    n0 = int(sql("SELECT count(*) FROM nucleo.chamados") or 0)
    r = cliente("Quero falar com uma pessoa, minha roupa veio manchada!", "t4")
    confere("chamado aberto", int(sql("SELECT count(*) FROM nucleo.chamados") or 0) > n0, r)

    print("\n== fora da base: nao inventa")
    r = cliente("Voces lavam tapete persa? Quanto custa?", "t5")
    confere("nao inventou servico nem preco de tapete", "sim, lavamos" not in r and "lavamos tapete" not in r and "r$" not in r, r)

    assert not sql("SELECT 1 WHERE '5500977776666' ~ '^55[1-9]'"), "numero de teste precisa ser invalido"
    print("\n== cliente no WhatsApp (modo dedicado + aprovacao) -> fila")
    sql("UPDATE nucleo.config SET valor = to_jsonb('dedicado'::text) WHERE chave = 'whatsapp_modo'")
    ev = {"event": "messages.upsert", "apikey": env["WHATSAPP_WEBHOOK_SEGREDO"], "sender": "5500900000000@s.whatsapp.net",
          "data": {"key": {"remoteJid": "5500977776666@s.whatsapp.net", "fromMe": False, "id": f"T{time.time_ns()}"},
                   "pushName": "TESTE Marta", "message": {"conversation": "Voces atendem no sabado?"}}}
    post("whatsapp", ev)
    for _ in range(40):
        time.sleep(3)
        _, painel = api("admin_atendimento")
        fila = [f for f in painel["fila"] if f["pergunta"] == "Voces atendem no sabado?"]
        if fila:
            break
    confere("resposta foi para a fila de aprovacao (nao enviada)", bool(fila), painel.get("fila"))
    if fila:
        print(f"    rascunho da IA: {fila[0]['rascunho']}")
        s, ap = api("admin_fila_aprovar", {"id": fila[0]["id"], "area": "geral",
                                          "texto": "Aos sabados atendemos das 9h as 13h, so pelo WhatsApp. Coletas de sabado tem taxa de R$ 5."})
        print(f"    aprovar: [{s}] {ap}")
        confere("aprovacao registrada", s == 200 and ap.get("ok"), ap)

        print("\n== aprendizado: outro cliente pergunta parecido")
        r = cliente("Funciona sabado? Tem taxa?", "t6")
        confere("IA usou a resposta aprovada (9h as 13h / taxa R$ 5)", "13" in r or "5" in r, r)
finally:
    print("\n== limpeza")
    sql(f"DELETE FROM nucleo.conhecimento WHERE usuario_id IS NULL AND (titulo LIKE 'TESTE%' OR conteudo LIKE '%sabado%' OR criado_em >= '{inicio}')")
    sql(f"DELETE FROM nucleo.clientes WHERE whatsapp LIKE 'teste%' OR whatsapp = '5500977776666' OR criado_em >= '{inicio}'")
    sql(f"DELETE FROM nucleo.conversas WHERE criado_em >= '{inicio}' AND (contato LIKE '5500977776666%')")
    sql("DELETE FROM nucleo_memoria_chat WHERE session_id LIKE 'c%:%'")
    sql("UPDATE nucleo.sistemas SET publico = false WHERE nome = 'n8n (proprio)'")
    if cfg_antes:
        sql(f"UPDATE nucleo.config SET valor = '{cfg_antes}'::jsonb WHERE chave = 'atendimento_empresa'")
    sql(f"UPDATE nucleo.config SET valor = to_jsonb('{modo_antes or 'aprovacao'}'::text) WHERE chave = 'atendimento_modo'")
    sql(f"UPDATE nucleo.config SET valor = to_jsonb('{zap_antes or 'pessoal'}'::text) WHERE chave = 'whatsapp_modo'")

print(f"\n{'TUDO OK' if not falhas else f'{falhas} FALHA(S)'}")
