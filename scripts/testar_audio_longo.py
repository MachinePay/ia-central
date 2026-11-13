"""Audio longo + texto junto: a IA espera transcrever, le tudo como texto e responde UMA vez, em texto.

Uso: python scripts/testar_audio_longo.py   (numero DDD 00; gera ~4 min de audio com a voz da OpenAI, centavos)
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
EU = "5500900000013"
falhas = 0

TEXTO = ("Oi Leo, deixa eu te contar como foi a reuniao de hoje com o pessoal da loja do centro, porque tem bastante coisa. "
         "Primeiro, eles querem trocar as quatro maquininhas antigas por modelos novos com wi-fi, porque o chip vive perdendo sinal "
         "no fundo da loja. Combinamos de levar duas maquininhas de teste na semana que vem, na terca de manha. "
         "Segundo, o dono, o seu Carlos, reclamou da taxa do credito parcelado. Hoje ele paga quatro virgula noventa e nove "
         "e o concorrente ofereceu quatro virgula vinte. Eu disse que ia ver com o financeiro se a gente consegue cobrir, "
         "mas nao prometi nada. Ele disse que se a gente chegar em quatro e trinta ele fecha contrato de mais um ano. "
         "Terceiro, eles querem abrir uma segunda loja no shopping em marco e ja querem deixar tudo combinado com a gente, "
         "inclusive o link de pagamento para vender pelo Instagram. Pediram uma proposta por escrito ate sexta-feira. "
         "Tambem falaram que o atendimento do suporte demorou para responder no ultimo sabado, quando a maquininha travou "
         "no meio do movimento, e que isso quase fez eles perderem venda. Eu pedi desculpas e falei que agora a gente tem "
         "o suporte vinte e quatro horas. Por fim, a gerente, a Juliana, pediu um treinamento rapido para as duas funcionarias "
         "novas, de uns trinta minutos, para aprender a fazer estorno e fechar o caixa na maquininha. Acho que da para fazer "
         "junto com a entrega das maquininhas de teste na terca. Resumindo, eu preciso de tres coisas: falar com o financeiro "
         "sobre a taxa, mandar a proposta da segunda loja ate sexta, e organizar o teste com treinamento na terca de manha. "
         "Me ajuda a nao esquecer de nada disso, por favor. ") * 2


def sql(q):
    return subprocess.run(["docker", "compose", "exec", "-T", "postgres", "psql", "-U", env["POSTGRES_USER"], env["POSTGRES_DB"], "-tAc", q],
                          cwd=PROJ, capture_output=True, text=True, encoding="utf-8").stdout.strip()


def confere(nome, cond, extra=""):
    global falhas
    print(("  OK   " if cond else "  FALHA") + f" {nome}" + (f"  -> {str(extra)[:400]}" if not cond else ""))
    falhas += 0 if cond else 1


def webhook(msg):
    req = urllib.request.Request("http://localhost:5678/webhook/whatsapp", json.dumps({
        "event": "messages.upsert", "instance": "nucleo", "apikey": env["WHATSAPP_WEBHOOK_SEGREDO"], "sender": f"{EU}@s.whatsapp.net",
        "data": {"key": {"remoteJid": f"{EU}@s.whatsapp.net", "fromMe": True, "id": f"T{time.time_ns()}"}, "pushName": "", "message": msg}}).encode(),
        {"Content-Type": "application/json"})
    try:
        return urllib.request.urlopen(req, timeout=120).status
    except urllib.error.HTTPError as e:
        return e.code


req = urllib.request.Request("https://api.openai.com/v1/audio/speech", json.dumps({
    "model": "gpt-4o-mini-tts", "voice": "nova", "response_format": "opus", "input": TEXTO[:4000]}).encode(),
    {"Content-Type": "application/json", "Authorization": "Bearer " + env["OPENAI_API_KEY"]})
audio = urllib.request.urlopen(req, timeout=180).read()
print(f"audio gerado: {len(audio) / 1024:.0f} KB")
inicio = sql("SELECT now()")
try:
    st = webhook({"audioMessage": {"seconds": 240}, "base64": base64.b64encode(audio).decode()})
    time.sleep(1)
    webhook({"conversation": "resume esse audio em 3 topicos e me diz o que eu preciso fazer"})
    confere("webhook aceitou o audio longo", st == 200, st)
    resp = ""
    for _ in range(60):
        time.sleep(5)
        n = sql(f"SELECT count(*) FROM nucleo.conversas WHERE papel = 'ia' AND usuario_id = 1 AND criado_em >= '{inicio}'")
        if n not in ("", "0"):
            time.sleep(25)   # da tempo de aparecer uma segunda resposta, se houvesse
            break
    rs = sql(f"SELECT mensagem FROM nucleo.conversas WHERE papel = 'ia' AND usuario_id = 1 AND criado_em >= '{inicio}' ORDER BY id")
    lido = sql(f"SELECT string_agg(mensagem, ' || ') FROM nucleo.conversas WHERE agente = 'ia-pessoal' AND papel = 'usuario' AND contato = '{EU}' AND criado_em >= '{inicio}'")
    print(f"    Leo leu: {lido}")
    print(f"    Leo respondeu:\n{rs}")
    confere("audio longo virou texto", "🎤" in lido and "maquininha" in lido.lower(), lido)
    confere("respondeu UMA vez (esperou o audio para responder junto com o texto)", rs.count("\n\n") < 40 and
            sql(f"SELECT count(*) FROM nucleo.conversas WHERE papel = 'ia' AND usuario_id = 1 AND criado_em >= '{inicio}'") == "1",
            sql(f"SELECT count(*) FROM nucleo.conversas WHERE papel = 'ia' AND usuario_id = 1 AND criado_em >= '{inicio}'"))
    confere("analisou o conteudo (taxa, proposta, terca)", all(w in rs.lower() for w in ["taxa", "proposta"]) and ("terç" in rs.lower() or "terc" in rs.lower()), rs)
    # (no ambiente local nao ha WhatsApp conectado: "nao consegui entregar" e esperado)
    ev = sql(f"SELECT coalesce(string_agg(titulo, ' | '), '') FROM nucleo.eventos WHERE criado_em >= '{inicio}' AND titulo NOT LIKE 'Nao consegui entregar%'")
    confere("sem erro de transcricao", ev == "", ev)
finally:
    sql(f"DELETE FROM nucleo.conversas WHERE criado_em >= '{inicio}' AND (contato LIKE '{EU}%' OR usuario_id = 1)")
    sql(f"DELETE FROM nucleo.eventos WHERE criado_em >= '{inicio}'")
    sql(f"DELETE FROM nucleo.lote_mensagens WHERE criado_em >= '{inicio}'")
    sql("DELETE FROM nucleo.audio_pendente")

print(f"\n{'TUDO OK' if not falhas else f'{falhas} FALHA(S)'}")
