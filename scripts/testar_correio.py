"""E-mail e agenda das IAs: chaves do app por IA, login OAuth (ate o retorno), dominio proprio (IMAP/SMTP),
leitura so do que e novo, aprendizado, propostas e execucao SO depois de aprovar.

Usa um servidor de e-mail de teste (GreenMail) num conteiner temporario, ligado na rede do compose.
Uso: python scripts/testar_correio.py      (gasta 1 ou 2 chamadas do gpt-5-mini; desfaz tudo no final)
"""
import imaplib
import json
import pathlib
import smtplib
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from email.message import EmailMessage

PROJ = pathlib.Path(__file__).resolve().parent.parent
env = dict(l.split("=", 1) for l in (PROJ / ".env").read_text(encoding="utf-8").splitlines() if "=" in l and not l.startswith("#"))
AG = "leo"
CAIXA, AMIGO, SENHA = "leo@teste.local", "amigo@teste.local", "senha123"
falhas = 0


def sql(q):
    return subprocess.run(["docker", "compose", "exec", "-T", "postgres", "psql", "-U", env["POSTGRES_USER"], env["POSTGRES_DB"], "-tA"],
                          input=q, cwd=PROJ, capture_output=True, text=True, encoding="utf-8").stdout.strip()


def post(caminho, corpo, tok=""):
    req = urllib.request.Request(f"http://localhost:5678/webhook/{caminho}", json.dumps(corpo).encode(),
                                 {"Content-Type": "application/json", "Authorization": "Bearer " + tok})
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return {"http": e.code, **json.loads(e.read() or b"{}")}
        except ValueError:
            return {"http": e.code}


class SemSeguir(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def volta_oauth(prov, query):
    try:
        urllib.request.build_opener(SemSeguir).open(f"http://localhost:5678/webhook/oauth/{prov}?{query}", timeout=60)
        return ""
    except urllib.error.HTTPError as e:
        return e.headers.get("Location", "")


def api(acao, dados=None):
    return post("painel", {"acao": acao, "dados": dados or {}}, TOK)


def confere(nome, cond, extra=""):
    global falhas
    print(("  OK   " if cond else "  FALHA") + f" {nome}" + (f"  -> {str(extra)[:400]}" if not cond else ""))
    falhas += 0 if cond else 1


def caixa(usuario, pasta="INBOX"):
    m = imaplib.IMAP4("localhost", 3143)
    m.login(usuario, SENHA)
    typ, d = m.select(pasta, readonly=True)
    n = int(d[0]) if typ == "OK" else -1
    m.logout()
    return n


def enviar(de, para, assunto, texto, extra=None):
    msg = EmailMessage()
    msg["From"], msg["To"], msg["Subject"] = de, para, assunto
    for k, v in (extra or {}).items():
        msg[k] = v
    msg.set_content(texto)
    with smtplib.SMTP("localhost", 3025) as s:
        s.send_message(msg)


# servidor de e-mail de teste
subiu = False
if "greenmail-teste" not in subprocess.run(["docker", "ps", "--format", "{{.Names}}"], capture_output=True, text=True).stdout:
    subprocess.run(["docker", "rm", "-f", "greenmail-teste"], capture_output=True)
    subprocess.run(["docker", "run", "-d", "--name", "greenmail-teste", "--network", "ia-central_default", "--network-alias", "greenmail",
                    "-p", "3025:3025", "-p", "3143:3143", "-e",
                    f"GREENMAIL_OPTS=-Dgreenmail.setup.test.smtp -Dgreenmail.setup.test.imap -Dgreenmail.hostname=0.0.0.0 "
                    f"-Dgreenmail.users=leo:{SENHA}@teste.local,amigo:{SENHA}@teste.local -Dgreenmail.users.login=email -Dgreenmail.verbose=false",
                    "greenmail/standalone:2.1.2"], check=True, capture_output=True)
    subiu = True
    time.sleep(8)

TOK = post("painel", {"acao": "login", "dados": {"login": env["ADMIN_LOGIN"], "senha": env["ADMIN_SENHA"]}})["token"]
inicio = sql("SELECT now();")
app_antes = sql(f"SELECT count(*) FROM nucleo.correio_apps WHERE agente = '{AG}' AND provedor = 'google';")
try:
    print("== chaves do app Google DESTA IA (criptografadas)")
    if app_antes == "0":
        r = api("admin_correio_app_salvar", {"agente": AG, "provedor": "google", "client_id": "teste-id.apps.googleusercontent.com", "segredo": "segredo-falso-123"})
        confere("painel mostra o app salvo", (r.get("apps", {}).get("google") or {}).get("client_id") == "teste-id.apps.googleusercontent.com", r)
        confere("segredo nao fica legivel no banco",
                sql(f"SELECT position('segredo-falso' in encode(segredo, 'escape')) FROM nucleo.correio_apps WHERE agente = '{AG}' AND provedor = 'google';") == "0")
    confere("outra IA nao tem o app do Leo", sql("SELECT count(*) FROM nucleo.correio_apps WHERE agente = 'joao' AND client_id LIKE 'teste-id%';") == "0")
    r = api("admin_correio_conectar", {"agente": AG, "provedor": "google", "redirect": "http://localhost:5678/webhook/oauth/google",
                                       "volta": "http://localhost:5173/"})
    url = r.get("url", "")
    confere("conectar devolve o login do Google com escopos de e-mail e agenda",
            url.startswith("https://accounts.google.com/") and "gmail.readonly" in url and "calendar.events" in url and "state=" in url, r)
    estado = url.split("state=")[1].split("&")[0] if "state=" in url else ""
    r = api("admin_correio_conectar", {"agente": AG, "provedor": "google", "redirect": "https://site-estranho.com/x", "volta": "http://localhost:5173/"})
    confere("endereco de retorno estranho e recusado", r.get("http") == 400, r)

    print("\n== volta do login (OAuth)")
    loc = volta_oauth("google", "state=invalido&code=x")
    confere("state invalido: volta com erro", "correio_erro=" in loc, loc)
    loc = volta_oauth("google", f"state={estado}&code=codigo-falso")
    confere("codigo falso: Google recusa e o painel recebe o erro", loc.startswith("http://localhost:5173/?correio_erro="), loc)
    loc = volta_oauth("google", f"state={estado}&code=codigo-falso")
    confere("state so vale uma vez", "expirado" in urllib.parse.unquote(loc).lower(), loc)

    print("\n== dominio proprio (IMAP/SMTP)")
    base = {"agente": AG, "email": CAIXA, "imap_host": "greenmail", "imap_porta": "3143", "smtp_host": "greenmail", "smtp_porta": "3025"}
    r = api("admin_correio_imap_salvar", {**base, "senha": "errada"})
    confere("senha errada: nao conecta e explica", r.get("ok") is False and "senha" in (r.get("erro") or "").lower(), r)
    r = api("admin_correio_imap_salvar", {**base, "senha": SENHA, "nome": "Leo Teste"})
    confere("senha certa: conectado", r.get("ok") is True, r)
    conta = next((c for c in (r.get("painel") or {}).get("contas", []) if c["email"] == CAIXA), {})
    confere("conta ok, sem agenda (sem CalDAV)", conta.get("estado") == "ok" and conta.get("tem_agenda") is False, conta)
    confere("senha nao fica legivel no banco",
            sql(f"SELECT position('{SENHA}' in encode(segredo, 'escape')) FROM nucleo.correio_contas WHERE id = {conta.get('id', 0)};") == "0")

    print("\n== le so o que e novo, aprende e propoe")
    api("admin_correio_ler", {"agente": AG})   # primeira leitura: marca o ponto de partida
    enviar(f"Marina Souza <{AMIGO}>", CAIXA, "Orcamento do evento de dezembro",
           "Oi Leo, tudo bem?\nVoce consegue me mandar o orcamento do evento de dezembro ate sexta? "
           "E podemos fazer uma call na quinta as 15h para alinhar?\nObrigada,\nMarina (gerente de compras da Loja Azul)")
    enviar(f"Ofertas <ofertas@loja.local>", CAIXA, "50% OFF so hoje", "Promocao imperdivel", {"List-Unsubscribe": "<mailto:sair@loja.local>"})
    time.sleep(2)
    nao_lidas_antes = caixa(CAIXA)
    r = api("admin_correio_ler", {"agente": AG})
    confere("leu os 2 e-mails novos", r.get("ok") and r.get("lidos", 0) >= 2, r)
    itens = sql(f"SELECT tipo || '|' || assunto || '|' || aprendido FROM nucleo.correio_itens WHERE conta_id = {conta.get('id', 0)} ORDER BY id;")
    print("    " + itens.replace("\n", "\n    "))
    confere("propaganda guardada mas sem gastar IA", "50% OFF so hoje|t" in itens)
    confere("e-mail da Marina aprendido", "Orcamento do evento de dezembro|t" in itens)
    apr = sql(f"SELECT titulo || ': ' || conteudo FROM nucleo.conhecimento WHERE origem = 'observacao_email' AND agente = '{AG}' AND criado_em >= '{inicio}';")
    print("    aprendeu: " + (apr.replace("\n", "\n              ") or "(nada)"))
    confere("aprendeu algo so para o Leo", apr != "" and sql(
        f"SELECT count(*) FROM nucleo.conhecimento WHERE origem = 'observacao_email' AND agente <> '{AG}' AND criado_em >= '{inicio}';") == "0")
    confere("nao mexeu na caixa (continua igual)", caixa(CAIXA) == nao_lidas_antes)
    r = api("admin_correio_ler", {"agente": AG})
    confere("lendo de novo: nada novo (nao rele)", r.get("ok") and r.get("lidos") == 0, r)

    painel = api("admin_correio", {"agente": AG})
    props = painel.get("propostas", [])
    for p in props:
        print(f"    proposta {p['tipo']}: {p.get('motivo')} | {json.dumps(p['dados'], ensure_ascii=False)[:200]}")
    pe = next((p for p in props if p["tipo"] == "email"), None)
    confere("propos uma resposta para a Marina (esperando aprovacao)", pe is not None and pe["status"] == "pendente", props)
    confere("sem agenda conectada: nao propos evento", not any(p["tipo"] == "evento" for p in props), props)
    confere("nada foi enviado antes de aprovar", caixa(AMIGO) == 0)

    print("\n== so executa depois de aprovar, na conta certa")
    if pe:
        r = api("admin_correio_aprovar", {"id": pe["id"], "modo": "rascunho", "dados": {"corpo": pe["dados"]["corpo"] + "\n(editado no painel)"}})
        confere("aprovado como rascunho", r.get("ok") is True, r)
        confere("rascunho apareceu na caixa da conta", caixa(CAIXA, "Drafts") >= 1)
        confere("rascunho nao foi enviado", caixa(AMIGO) == 0)
        r = api("admin_correio_aprovar", {"id": pe["id"], "modo": "enviar"})
        confere("proposta ja executada nao roda de novo", r.get("http") == 404, r)
    # uma resposta para enviar de verdade
    pid = sql(f"""INSERT INTO nucleo.correio_propostas (agente, conta_id, tipo, motivo, dados) VALUES ('{AG}', {conta.get('id', 0)}, 'email', 'teste',
        '{{"para": "{AMIGO}", "assunto": "Re: Orcamento", "corpo": "Oi Marina, mando ate sexta. Abraco, Leo"}}') RETURNING id;""").splitlines()[0]
    r = api("admin_correio_aprovar", {"id": int(pid), "modo": "enviar"})
    confere("aprovado e enviado", r.get("ok") is True, r)
    time.sleep(1)
    confere("Marina recebeu", caixa(AMIGO) == 1)
    confere("resposta aprovada ensina so o Leo", sql(
        f"SELECT count(*) FROM nucleo.conhecimento WHERE titulo = 'Resposta aprovada (e-mail)' AND agente = '{AG}' AND criado_em >= '{inicio}';") == "1")
    pid = sql(f"""INSERT INTO nucleo.correio_propostas (agente, conta_id, tipo, motivo, dados) VALUES ('{AG}', {conta.get('id', 0)}, 'evento', 'teste',
        '{{"titulo": "Call Marina", "inicio": "2026-12-03T15:00", "fim": "2026-12-03T15:30"}}') RETURNING id;""").splitlines()[0]
    r = api("admin_correio_aprovar", {"id": int(pid), "modo": "criar"})
    confere("evento numa conta sem agenda: falha explicada", r.get("ok") is False and "agenda" in (r.get("erro") or "").lower(), r)
    confere("proposta fica como falhou (da para corrigir)", sql(f"SELECT status FROM nucleo.correio_propostas WHERE id = {pid};") == "falhou")
    r = api("admin_correio_rejeitar", {"id": int(pid)})
    confere("descartar tira da fila", not any(p["id"] == int(pid) for p in r.get("propostas", [])), r.get("propostas"))

    print("\n== desconectar")
    r = api("admin_correio_desconectar", {"id": conta.get("id", 0)})
    confere("conta saiu e o que leu foi apagado", not r.get("contas") and sql(f"SELECT count(*) FROM nucleo.correio_itens WHERE conta_id = {conta.get('id', 0)};") == "0", r)
finally:
    sql(f"DELETE FROM nucleo.correio_contas WHERE email LIKE '%@teste.local';"
        f" DELETE FROM nucleo.conhecimento WHERE criado_em >= '{inicio}' AND (origem = 'observacao_email' OR titulo = 'Resposta aprovada (e-mail)');"
        f" DELETE FROM nucleo.eventos WHERE criado_em >= '{inicio}' AND (titulo LIKE '%e-mail%' OR titulo LIKE '%E-mail%' OR titulo LIKE '%proposta%');"
        f" DELETE FROM nucleo.correio_oauth WHERE criado_em >= '{inicio}';")
    if app_antes == "0":
        sql(f"DELETE FROM nucleo.correio_apps WHERE agente = '{AG}' AND client_id LIKE 'teste-id%';")
    if subiu:
        subprocess.run(["docker", "rm", "-f", "greenmail-teste"], capture_output=True)
print(f"\n{'TUDO OK' if not falhas else f'{falhas} FALHA(S)'}")
