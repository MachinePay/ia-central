"""Gera os JSONs dos workflows da IA Central em workflows/.

Rodar:  python scripts/montar_workflows.py
Editar prompts/ferramentas aqui e gerar de novo e' mais seguro que mexer no JSON na mao.
"""
import json
import pathlib

SAIDA = pathlib.Path(__file__).resolve().parent.parent / "workflows"

PG = {"postgres": {"id": "pgNucleo01", "name": "Postgres Nucleo"}}
ANTHROPIC = {"anthropicApi": {"id": "anthropic01", "name": "Anthropic"}}
OPENAI = {"openAiApi": {"id": "openai01", "name": "OpenAI"}}

# Os dois provedores ficam ligados: PRINCIPAL responde; se falhar (fora do ar, limite,
# chave invalida), o agente usa o RESERVA automaticamente. Troque e rode o script de novo.
PRINCIPAL = "openai"        # "openai" ou "anthropic"
RESERVA = "anthropic"       # o outro provedor, ou None para desligar a reserva


def _chaves_no_env():
    env = SAIDA.parent / ".env"
    vals = {}
    if env.exists():
        for linha in env.read_text(encoding="utf-8").splitlines():
            if "=" in linha and not linha.lstrip().startswith("#"):
                k, v = linha.split("=", 1)
                vals[k.strip()] = v.strip()
    return {"openai": bool(vals.get("OPENAI_API_KEY")), "anthropic": bool(vals.get("ANTHROPIC_API_KEY"))}


# Provedor sem chave no .env nao entra (o n8n quebra o agente se o modelo reserva nao tem chave).
_CHAVES = _chaves_no_env()
if RESERVA and not _CHAVES[RESERVA]:
    print(f"aviso: sem chave de {RESERVA} no .env -> reserva desligada (rode de novo depois de preencher)")
    RESERVA = None
MODELOS = {
    #            cerebro (IA pessoal)      especialistas (mais barato/rapido)
    "openai":    {"orquestrador": "gpt-5", "especialista": "gpt-5-mini", "atendente": "gpt-5-mini"},
    "anthropic": {"orquestrador": "claude-sonnet-5-5", "especialista": "claude-haiku-5-5", "atendente": "claude-haiku-5-5"},
}
NOME_PROVEDOR = {"openai": "OpenAI", "anthropic": "Claude"}

_contador = 0


def node(nome, tipo, versao, pos, params, **extra):
    global _contador
    _contador += 1
    n = {
        "id": f"c0000000-0000-4000-8000-{_contador:012d}",
        "name": nome,
        "type": tipo,
        "typeVersion": versao,
        "position": pos,
        "parameters": params,
    }
    n.update(extra)
    return n


def modelos_do_agente(agente, papel, x, y):
    """Cria o no do modelo principal (+ reserva) e devolve (nodes, ligacoes)."""
    nodes, ligacoes = [], []
    for indice, prov in enumerate([PRINCIPAL, RESERVA]):
        if prov is None:
            continue
        tipo = "principal" if indice == 0 else "reserva"
        nome = f"{NOME_PROVEDOR[prov]} ({papel}, {tipo})"
        nodes.append(modelo_ia(nome, prov, MODELOS[prov][papel], [x + indice * 160, y]))
        ligacoes.append((nome, agente, indice))
    return nodes, ligacoes


def opcoes_agente():
    return {"needsFallback": RESERVA is not None}


def modelo_ia(nome, provedor, modelo, pos):
    if provedor == "openai":
        # gpt-5 e' modelo de raciocinio: nao aceita temperature; esforco baixo = mais rapido/barato
        return node(nome, "@n8n/n8n-nodes-langchain.lmChatOpenAi", 1.3, pos, {
            "model": {"__rl": True, "mode": "id", "value": modelo},
            "responsesApiEnabled": True,
            "builtInTools": {},
            "options": {"reasoningEffort": "low"},
        }, credentials=OPENAI)
    return node(nome, "@n8n/n8n-nodes-langchain.lmChatAnthropic", 1.6, pos, {
        "model": {"__rl": True, "mode": "id", "value": modelo},
        "options": {"maxTokensToSample": 4096, "temperature": 0.3},
    }, credentials=ANTHROPIC)


def ferramenta_sql(nome_no, nome_ferramenta, descricao, sql, params_ia, pos):
    """Postgres como ferramenta. params_ia = lista de expressoes $fromAI (vira array, aceita virgulas)."""
    opcoes = {}
    if params_ia:
        opcoes["queryReplacement"] = "={{ [" + ", ".join(params_ia) + "] }}"
    return node(nome_no, "n8n-nodes-base.postgresTool", 2.6, pos, {
        "descriptionType": "manual",
        "toolDescription": f"{nome_ferramenta}: {descricao}",
        "operation": "executeQuery",
        "query": sql,
        "options": opcoes,
    }, credentials=PG)


def ia(chave, descricao, tipo="string"):
    d = descricao.replace("'", "\\'")
    return f"$fromAI('{chave}', '{d}', '{tipo}')"


def campo(nome, tipo="string"):
    return {"id": nome, "displayName": nome, "required": False, "defaultMatch": False,
            "display": True, "canBeUsedToMatch": True, "type": tipo, "removed": False}


def mapear(valores):
    return {
        "mappingMode": "defineBelow",
        "value": valores,
        "matchingColumns": [],
        "schema": [campo(k) for k in valores],
        "attemptToConvertTypes": True,
        "convertFieldsToString": False,
    }


def gatilho_subworkflow(campos, pos=(0, 0)):
    return node("Quando chamado", "n8n-nodes-base.executeWorkflowTrigger", 1.1, list(pos), {
        "inputSource": "workflowInputs",
        "workflowInputs": {"values": [{"name": c, "type": "string"} for c in campos]},
    })


def ligar(*pares):
    con = {}
    for origem, destino in pares:
        con.setdefault(origem, {"main": [[]]})["main"][0].append(
            {"node": destino, "type": "main", "index": 0})
    return con


def ligar_ia(con, origem, destino, tipo, indice_destino=0):
    con.setdefault(origem, {}).setdefault(tipo, [[]])[0].append(
        {"node": destino, "type": tipo, "index": indice_destino})


def workflow(wid, nome, nodes, connections, ativo=True):
    return {
        "id": wid, "name": nome, "active": ativo, "nodes": nodes, "connections": connections,
        "settings": {"executionOrder": "v1", "callerPolicy": "workflowsFromSameOwner"},
        "pinData": {},
    }


# ---------------------------------------------------------------------------
# Quem esta falando: todo sub-workflow recebe usuario_id do gatilho (nunca da IA)
# ---------------------------------------------------------------------------
UID = "$('Quando chamado').first().json.usuario_id"


def sql_usuario(params_ia):
    """Parametros de ferramenta SQL: $1 = usuario_id (confiavel), depois os da IA."""
    return [UID] + params_ia


# ---------------------------------------------------------------------------
# Trechos JS reutilizados nos nos Code (WhatsApp via Evolution API, Telegram)
# ---------------------------------------------------------------------------
JS_ENVIOS = r"""
const comHttp = u => (u && !/^https?:\/\//.test(u) ? 'http://' + u : u || '');   // Render manda host:porta
const EVO = comHttp($env.EVOLUTION_URL), INST = $env.EVOLUTION_INSTANCIA || 'nucleo';   // numero do Leo
const INST_JOAO = $env.EVOLUTION_INSTANCIA_JOAO || 'joao';                                  // chip do Joao
const evo = (method, caminho, body) => this.helpers.httpRequest({
  method, url: `${EVO}${caminho}`, headers: { apikey: $env.EVOLUTION_API_KEY }, body, json: true, timeout: 30000 });
// markdown -> formatacao do WhatsApp (*negrito*), sem cabecalhos
const paraWhatsapp = t => String(t || '').replace(/\*\*(.+?)\*\*/g, '*$1*').replace(/^#{1,6}\s*/gm, '');
async function whatsappConectado(inst = INST) {
  try { const r = await evo('GET', `/instance/connectionState/${inst}`); return (r.instance || r).state === 'open'; }
  catch { return false; }
}
async function enviarWhatsapp(numero, texto, marcar = true, inst = INST) {
  let t = paraWhatsapp(texto);
  if (marcar && !t.startsWith('🤖')) t = '🤖 ' + t;   // marca da IA: nunca responde a si mesma
  return evo('POST', `/message/sendText/${inst}`, { number: String(numero).replace(/\D/g, ''), text: t });
}
// nunca marcar conversas como lidas nem atender chamadas (importante no numero pessoal)
const CONFIG_INSTANCIA = { rejectCall: false, msgCall: '', groupsIgnore: true, alwaysOnline: false,
  readMessages: false, readStatus: false, syncFullHistory: false };
async function enviarTelegram(chatId, texto) {
  return this.helpers.httpRequest({ method: 'POST', json: true,
    url: `https://api.telegram.org/bot${$env.TELEGRAM_BOT_TOKEN}/sendMessage`, body: { chat_id: chatId, text: texto } });
}
"""


# ---------------------------------------------------------------------------
# 1) FERRAMENTA: ENVIAR MENSAGEM (reutilizavel por qualquer IA/workflow)
#    WhatsApp se a pessoa tiver numero e o WhatsApp estiver conectado; senao Telegram.
# ---------------------------------------------------------------------------
def ferramenta_enviar_mensagem():
    nodes = [
        gatilho_subworkflow(["usuario_id", "contato", "mensagem"]),
        node("Achar destino", "n8n-nodes-base.postgres", 2.6, [220, 0], {
            "operation": "executeQuery",
            # contato vazio = o proprio usuario; senao procura nos contatos dele (admin: em todos) e nos usuarios
            "query": (
                "SELECT nome, telegram_chat_id, whatsapp FROM (\n"
                "  SELECT u.nome, u.telegram_chat_id, u.whatsapp, 0 AS ordem FROM nucleo.usuarios u\n"
                "   WHERE coalesce($2,'') = '' AND u.id = $1::int\n"
                "  UNION ALL\n"
                "  SELECT c.nome, c.telegram_chat_id, c.whatsapp, length(c.nome) FROM nucleo.contatos c\n"
                "   WHERE coalesce($2,'') <> '' AND c.ativo AND c.nome ILIKE '%' || $2 || '%'\n"
                "     AND (c.usuario_id = $1::int OR EXISTS (SELECT 1 FROM nucleo.usuarios a WHERE a.id = $1::int AND a.papel = 'admin'))\n"
                "  UNION ALL\n"
                "  SELECT u.nome, u.telegram_chat_id, u.whatsapp, 1000 + length(u.nome) FROM nucleo.usuarios u\n"
                "   WHERE coalesce($2,'') <> '' AND u.ativo AND u.nome ILIKE '%' || $2 || '%'\n"
                ") d ORDER BY ordem LIMIT 1"
            ),
            "options": {"queryReplacement": "={{ [$json.usuario_id, $json.contato || ''] }}"},
        }, credentials=PG, alwaysOutputData=True),
        node("Enviar", "n8n-nodes-base.code", 2, [440, 0], {
            "mode": "runOnceForAllItems",
            "jsCode": JS_ENVIOS + r"""
const pedido = $('Quando chamado').first().json;
const c = $input.first().json;
let resultado;
if (!c.nome) resultado = `Contato "${pedido.contato}" nao encontrado.`;
else {
  const erros = [];
  if (c.whatsapp && await whatsappConectado()) {
    try { await enviarWhatsapp(c.whatsapp, pedido.mensagem); resultado = `Mensagem enviada para ${c.nome} pelo WhatsApp.`; }
    catch (e) { erros.push('WhatsApp: ' + e.message); }
  }
  if (!resultado && c.telegram_chat_id && $env.TELEGRAM_BOT_TOKEN) {
    try { await enviarTelegram.call(this, c.telegram_chat_id, pedido.mensagem); resultado = `Mensagem enviada para ${c.nome} pelo Telegram.`; }
    catch (e) { erros.push('Telegram: ' + e.message); }
  }
  if (!resultado) resultado = erros.length ? `Falha ao enviar para ${c.nome}: ${erros.join(' | ')}`
    : `${c.nome} nao tem WhatsApp conectado nem Telegram cadastrado.`;
}
return [{ json: { resultado } }];""",
        }),
    ]
    con = ligar(("Quando chamado", "Achar destino"), ("Achar destino", "Enviar"))
    return workflow("ferrEnviarMsg01", "Ferramenta: Enviar mensagem", nodes, con)


# ---------------------------------------------------------------------------
# 2) ESPECIALISTA: SISTEMAS (todos veem; so admin cadastra/pausa)
# ---------------------------------------------------------------------------
PROMPT_SISTEMAS = """Voce e o especialista em monitoramento de sistemas da IA Central.
Responda em portugues, curto e direto, com os dados reais das ferramentas (nunca invente).
O monitor checa cada sistema a cada 2 minutos e avisa quando cai ou volta.
- Para saber o estado atual use listar_sistemas.
- Para historico de quedas use historico_incidentes.
- Para monitorar algo novo use cadastrar_sistema (precisa de nome e URL completa com http/https).
- Para pausar/retomar use ativar_desativar_sistema.
- Para saber AGORA se um site esta no ar (mesmo sem estar cadastrado) use checar_agora: traz status e tempo.
- Sistemas com origem render/vercel vem das contas Render e Vercel: "(deploy)" e o estado do ultimo deploy,
  o outro e o site em si. Ao falar deles, diga a plataforma.
- Cadastrar e pausar sao so para o admin; se a ferramenta recusar, explique isso.
- Responda SO o que foi perguntado, com os campos que existem (estado, ultimo check, detalhe, quedas).
  Existe o tempo da ultima resposta (ultimo_tempo_ms). Nao existem p95, uptime % ou janelas de manutencao.
Horarios do banco estao em UTC; converta para horario de Brasilia (UTC-3) ao responder."""


def especialista_sistemas():
    nodes = [
        gatilho_subworkflow(["usuario_id", "pedido"]),
        node("Especialista Sistemas", "@n8n/n8n-nodes-langchain.agent", 3.1, [260, 0], {
            "promptType": "define",
            "text": "={{ $json.pedido }}",
            **opcoes_agente(),
            "options": {"systemMessage": PROMPT_SISTEMAS, "maxIterations": 8,
                        "enableStreaming": False},
        }),
        ferramenta_sql(
            "listar_sistemas", "listar_sistemas",
            "lista todos os sistemas monitorados com estado atual (ok/falha), falhas seguidas, ultimo detalhe e desde quando esta fora.",
            "SELECT nome, origem, tipo, url, ativo, estado, falhas_seguidas, ultimo_detalhe, ultimo_tempo_ms,\n"
            "       ultimo_check, caiu_em, painel_url\nFROM nucleo.sistemas ORDER BY (estado='falha') DESC, origem, nome",
            [], [260, 240]),
        ferramenta_sql(
            "historico_incidentes", "historico_incidentes",
            "historico de quedas (incidentes) mais recentes, com inicio, fim e duracao.",
            "SELECT s.nome, i.inicio, i.fim, coalesce(i.fim, now()) - i.inicio AS duracao, i.detalhe\n"
            "FROM nucleo.incidentes i JOIN nucleo.sistemas s ON s.id = i.sistema_id\n"
            "ORDER BY i.inicio DESC LIMIT $1",
            [ia("limite", "quantos incidentes trazer, ex 10", "number")], [420, 240]),
        ferramenta_sql(
            "cadastrar_sistema", "cadastrar_sistema",
            "(so admin) passa a monitorar uma URL nova. Se o nome ja existir, atualiza a URL.",
            "WITH ok AS (SELECT nucleo.exigir_admin($1::int))\n"
            "INSERT INTO nucleo.sistemas (nome, url, grupo, texto_esperado)\n"
            "SELECT $2, $3, coalesce(nullif($4,''),'geral'), nullif($5,'') FROM ok\n"
            "ON CONFLICT (nome) DO UPDATE SET url = EXCLUDED.url, grupo = EXCLUDED.grupo,\n"
            "  texto_esperado = EXCLUDED.texto_esperado, ativo = true\n"
            "RETURNING nome, url, grupo, texto_esperado",
            sql_usuario([ia("nome", "nome curto do sistema"),
                         ia("url", "URL completa, ex https://site.com/health"),
                         ia("grupo", "grupo de alerta; vazio = geral"),
                         ia("texto_esperado", "texto que a resposta deve conter; vazio = so checa status 200")]),
            [580, 240]),
        ferramenta_sql(
            "ativar_desativar_sistema", "ativar_desativar_sistema",
            "(so admin) pausa (ativo=false) ou retoma (ativo=true) o monitoramento de um sistema pelo nome.",
            "WITH ok AS (SELECT nucleo.exigir_admin($1::int))\n"
            "UPDATE nucleo.sistemas SET ativo = $3::boolean FROM ok WHERE nome ILIKE '%' || $2 || '%'\n"
            "RETURNING nome, ativo",
            sql_usuario([ia("nome", "nome (ou parte) do sistema"),
                         ia("ativo", "true para ativar, false para pausar", "boolean")]),
            [740, 240]),
    ]
    modelos, lig_modelos = modelos_do_agente("Especialista Sistemas", "especialista", -60, 240)
    nodes += modelos
    con = ligar(("Quando chamado", "Especialista Sistemas"))
    for origem, destino, idx in lig_modelos:
        ligar_ia(con, origem, destino, "ai_languageModel", idx)
    nodes.append(node("checar_agora", "@n8n/n8n-nodes-langchain.toolWorkflow", 2.2, [900, 240], {
        "description": "Checa AGORA se uma URL esta no ar: status HTTP, tempo de resposta e titulo da pagina. "
                       "Nao precisa estar cadastrada.",
        "source": "database",
        "workflowId": {"__rl": True, "mode": "id", "value": "ferrChecarAgora1", "cachedResultName": "Ferramenta: Checar agora"},
        "workflowInputs": mapear({"url": "={{ " + ia("url", "endereco do site, ex https://site.com") + " }}"}),
    }))
    for t in ["listar_sistemas", "historico_incidentes", "cadastrar_sistema", "ativar_desativar_sistema", "checar_agora"]:
        ligar_ia(con, t, "Especialista Sistemas", "ai_tool")
    return workflow("espSistemas01", "Especialista: Sistemas", nodes, con)


# ---------------------------------------------------------------------------
# 3) CEREBRO (a IA de cada usuario). Chamado pelo chat do n8n, pelo painel e pelo audio.
# ---------------------------------------------------------------------------
PROMPT_CEREBRO = """Voce e o Leo 2.0, a IA master da IA Central: o chefe que coordena tudo e todos os especialistas.
Agora voce esta falando com {{ $('Quando chamado').first().json.nome }}. Seja um braco direito de confianca que resolve as coisas.
Sua equipe, cada um no seu proprio numero: Joao (vendedor), Suporte24hrs (suporte) e Gabriel (o clone do dono, que
responde so os contatos liberados, como o dono). Todos trabalham para voce e comecam so observando e aprendendo.
Papel desta pessoa: {{ $('Quando chamado').first().json.papel }}. Canal: {{ $('Quando chamado').first().json.canal }}.
Agora: {{ $now.setZone('America/Sao_Paulo').toFormat("cccc, dd/MM/yyyy HH:mm", { locale: 'pt-BR' }) }} (horario de Brasilia).

Como trabalhar:
- Fale em portugues, direto e sem enrolacao. Use os dados das ferramentas; nunca invente.
- Voce coordena especialistas. Delegue a eles o que for da area deles:
  * especialista_sistemas: tudo sobre sites/APIs/servidores monitorados (status, quedas, cadastrar, pausar).
  * Equipe (so para admin): atendimento_resumo (como estao Joao, Suporte24hrs e Gabriel: mensagens, aprovacoes
    pendentes, o que aprenderam, chamados, leads), atendimento_modo (muda o modo de um agente: desligado |
    observando | aprovacao | automatico) e liberar_cliente (deixa Joao ou Suporte24hrs responder um cliente).
    Mudar modo ou liberar cliente: confirme com o admin antes, a menos que ele ja tenha pedido exatamente isso.
    Repasse o pedido como a pessoa fez, sem inventar exigencias extras.
- Memoria de longo prazo (de cada pessoa, separada): quando a pessoa contar algo que vale lembrar
  (preferencias, dados, decisoes, ideias; senhas NAO), salve com lembrar. Antes de dizer que nao sabe,
  procure com buscar_memoria.
  * escopo "minha": so as memorias desta pessoa (padrao).
  * escopo "compartilhada": inclui as de quem participa da memoria compartilhada (se estiver ligada).
  * escopo "todos": use quando pedirem ideias/visao "de todo mundo", "do time", "de todos". Para o admin
    traz tudo de todos; para os outros so o que e compartilhado. O banco aplica a regra; nao prometa mais.
  * Ao usar memoria de outras pessoas, diga de quem veio cada ideia (campo "de").
- Lembretes: use criar_lembrete com data/hora ISO 8601 com fuso -03:00. Se o horario for vago, pergunte.
- Para avisar alguem (ou a propria pessoa) agora, use enviar_mensagem (vai pelo WhatsApp se a pessoa tiver numero, senao Telegram).
  Confirme o texto antes de mandar para outra pessoa, a menos que ja tenham dito exatamente o que mandar.
- Contatos: listar_contatos / cadastrar_contato. Telegram/WhatsApp da propria pessoa: salvar_meu_contato.
- So ofereca o que suas ferramentas fazem de verdade. Nao prometa recursos que nao existem
  (ex.: latencia, checagem de varios locais, PDF). Se nenhuma ferramenta resolve, diga o que falta.
- Respostas curtas. Quando fizer sentido, sugira no maximo UMA proxima acao.
- Mensagem que comeca com "🎤" e um AUDIO ja transcrito: trate como texto normal (mesmo se for longo) e responda em texto.
  Se pedirem para resumir/analisar um audio, analise o conteudo transcrito com cuidado.
- No WhatsApp a pessoa pode ter mandado varias mensagens seguidas (uma por linha): leia TODAS e responda tudo
  de uma vez, numa resposta so, como uma pessoa faria.
- Se o canal comecar com "whatsapp": escreva como no WhatsApp, curto, *negrito* com um asterisco, sem tabelas
  nem titulos. Se for "whatsapp (audio...)", a resposta vai virar audio: frases faladas, sem simbolos.
- Se o canal for "voz": a resposta sera falada em voz alta. Frases curtas e naturais, sem markdown,
  sem listas com simbolos, sem emojis, sem links."""


ESTILO_LEO = """

Jeito de falar e de resolver problemas do dono (aprendido lendo as conversas dele; quando falar com ELE ou
escrever em nome dele, imite esse jeito):
{{ $('Estilo').first().json.estilo || '(ainda aprendendo)' }}"""


def cerebro():
    nodes = [
        gatilho_subworkflow(["usuario_id", "nome", "papel", "chatInput", "sessionId", "canal"]),
        node("Estilo", "n8n-nodes-base.postgres", 2.6, [150, -160], {
            "operation": "executeQuery",
            "query": "SELECT nucleo.estilo_dono($1::int) AS estilo",
            "options": {"queryReplacement": "={{ [$json.usuario_id] }}"},
        }, credentials=PG, alwaysOutputData=True),
        node("IA", "@n8n/n8n-nodes-langchain.agent", 3.1, [300, 0], {
            "promptType": "define",
            "text": "={{ $('Quando chamado').first().json.chatInput }}",
            **opcoes_agente(),
            "options": {"systemMessage": "=" + PROMPT_CEREBRO + ESTILO_LEO, "maxIterations": 12,
                        "enableStreaming": False},
        }),
        node("Memoria da conversa", "@n8n/n8n-nodes-langchain.memoryPostgresChat", 1.4, [160, 260], {
            "sessionIdType": "customKey",
            "sessionKey": "={{ $('Quando chamado').first().json.sessionId }}",
            "tableName": "nucleo_memoria_chat",
            "contextWindowLength": 20,
        }, credentials=PG),
        node("especialista_sistemas", "@n8n/n8n-nodes-langchain.toolWorkflow", 2.2, [320, 260], {
            "description": "Especialista em sistemas monitorados: status atual, historico de quedas, "
                           "cadastrar/pausar monitoramento. Mande o pedido completo em linguagem natural.",
            "source": "database",
            "workflowId": {"__rl": True, "mode": "id", "value": "espSistemas01",
                           "cachedResultName": "Especialista: Sistemas"},
            "workflowInputs": mapear({
                "usuario_id": "={{ " + UID + " }}",
                "pedido": "={{ " + ia("pedido", "o que precisa do especialista, com todos os detalhes") + " }}",
            }),
        }),
        node("enviar_mensagem", "@n8n/n8n-nodes-langchain.toolWorkflow", 2.2, [480, 260], {
            "description": "Envia uma mensagem agora (WhatsApp ou Telegram). contato = nome de um contato ou de outro "
                           "usuario; vazio = envia para a propria pessoa.",
            "source": "database",
            "workflowId": {"__rl": True, "mode": "id", "value": "ferrEnviarMsg01",
                           "cachedResultName": "Ferramenta: Enviar mensagem"},
            "workflowInputs": mapear({
                "usuario_id": "={{ " + UID + " }}",
                "contato": "={{ " + ia("contato", "nome do contato; vazio para a propria pessoa") + " }}",
                "mensagem": "={{ " + ia("mensagem", "texto exato a enviar") + " }}",
            }),
        }),
        ferramenta_sql(
            "lembrar", "lembrar",
            "salva na memoria de longo prazo desta pessoa um fato, preferencia ou ideia.",
            "SELECT * FROM nucleo.lembrar($1::int, $2, $3)",
            sql_usuario([ia("titulo", "titulo curto do fato"),
                         ia("conteudo", "o fato completo, autoexplicativo")]),
            [640, 260]),
        ferramenta_sql(
            "buscar_memoria", "buscar_memoria",
            "procura na memoria de longo prazo. Traz primeiro o que combina com as palavras "
            "(relevante=true) e depois os fatos mais recentes; campo 'de' diz de quem e. "
            "Leia tudo antes de dizer que nao sabe.",
            "SELECT de, titulo, conteudo, criado_em, relevante FROM nucleo.buscar_memoria($1::int, $2, $3)",
            sql_usuario([ia("busca", "palavras-chave simples separadas por espaco, ex: relatorio formato"),
                         ia("escopo", "minha | compartilhada | todos")]),
            [800, 260]),
        ferramenta_sql(
            "criar_lembrete", "criar_lembrete",
            "agenda um lembrete que sera enviado pelo Telegram na hora marcada.",
            "INSERT INTO nucleo.lembretes (usuario_id, texto, quando, contato)\n"
            "VALUES ($1::int, $2, $3::timestamptz, nullif($4,''))\n"
            "RETURNING id, texto, to_char(quando AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI') AS quando_brasilia, contato",
            sql_usuario([ia("texto", "o que lembrar"),
                         ia("quando", "data/hora ISO 8601 com fuso, ex 2026-11-13T09:00:00-03:00"),
                         ia("contato", "nome de quem recebe; vazio = a propria pessoa")]),
            [960, 260]),
        ferramenta_sql(
            "listar_lembretes", "listar_lembretes",
            "lista os lembretes desta pessoa ainda nao enviados.",
            "SELECT id, texto, to_char(quando AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI') AS quando_brasilia,\n"
            "       coalesce(contato, 'eu') AS para\nFROM nucleo.lembretes\n"
            "WHERE usuario_id = $1::int AND enviado_em IS NULL ORDER BY quando",
            sql_usuario([]), [1120, 260]),
        ferramenta_sql(
            "listar_contatos", "listar_contatos",
            "lista os contatos desta pessoa e por quais canais podem ser avisados.",
            "SELECT nome, telegram_chat_id IS NOT NULL AS tem_telegram, whatsapp, email, ativo\n"
            "FROM nucleo.contatos WHERE usuario_id = $1::int ORDER BY nome",
            sql_usuario([]), [1280, 260]),
        ferramenta_sql(
            "cadastrar_contato", "cadastrar_contato",
            "cadastra uma pessoa nos contatos desta pessoa, para receber mensagens e lembretes.",
            "INSERT INTO nucleo.contatos (usuario_id, nome, telegram_chat_id, whatsapp)\n"
            "VALUES ($1::int, $2, nullif($3,''), nullif($4,''))\nRETURNING id, nome",
            sql_usuario([ia("nome", "nome da pessoa"),
                         ia("telegram_chat_id", "chat_id do Telegram; vazio se nao tiver"),
                         ia("whatsapp", "numero com DDI, ex 5511999999999; vazio se nao tiver")]),
            [1440, 260]),
        ferramenta_sql(
            "salvar_meu_contato", "salvar_meu_contato",
            "salva o chat_id do Telegram e/ou WhatsApp da PROPRIA pessoa (para receber lembretes e avisos).",
            "UPDATE nucleo.usuarios SET telegram_chat_id = coalesce(nullif($2,''), telegram_chat_id),\n"
            "       whatsapp = coalesce(nullif($3,''), whatsapp)\nWHERE id = $1::int\n"
            "RETURNING nome, telegram_chat_id IS NOT NULL AS tem_telegram, whatsapp",
            sql_usuario([ia("telegram_chat_id", "chat_id do Telegram; vazio para nao mudar"),
                         ia("whatsapp", "numero com DDI; vazio para nao mudar")]),
            [1600, 260]),
        ferramenta_sql(
            "atendimento_resumo", "atendimento_resumo",
            "(so admin) panorama do atendimento do Joao: modo atual, clientes novos, mensagens, respostas suas e do Joao, "
            "chamados abertos, leads recentes, o que foi aprendido e o que espera aprovacao.",
            "SELECT nucleo.atendimento_resumo($1::int, $2::int) AS resumo",
            sql_usuario([ia("dias", "periodo em dias, ex 7", "number")]), [1760, 260]),
        ferramenta_sql(
            "atendimento_modo", "atendimento_modo",
            "(so admin) muda o modo de um agente (joao | suporte | gabriel): desligado | observando | aprovacao | automatico.",
            "WITH ok AS (SELECT nucleo.exigir_admin($1::int))\n"
            "INSERT INTO nucleo.config (chave, valor) SELECT $3 || '_modo', to_jsonb($2::text) FROM ok\n"
            "WHERE $2 IN ('desligado','observando','aprovacao','automatico') AND $3 IN ('joao','suporte','gabriel')\n"
            "ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor RETURNING chave, valor #>> '{}' AS modo",
            sql_usuario([ia("modo", "desligado | observando | aprovacao | automatico"), ia("agente", "joao | suporte | gabriel")]),
            [1920, 260]),
        ferramenta_sql(
            "liberar_cliente", "liberar_cliente",
            "(so admin) liga (true) ou desliga (false) o Joao ou o Suporte24hrs respondendo um cliente, pelo nome ou numero.",
            "WITH ok AS (SELECT nucleo.exigir_admin($1::int))\n"
            "UPDATE nucleo.clientes SET ia_responde = CASE WHEN $4 = 'suporte' THEN ia_responde ELSE $3::boolean END,\n"
            "  suporte_responde = CASE WHEN $4 = 'suporte' THEN $3::boolean ELSE suporte_responde END FROM ok\n"
            "WHERE whatsapp NOT LIKE 'teste%' AND (nome ILIKE '%' || $2 || '%' OR whatsapp LIKE '%' || regexp_replace($2, '[^0-9]', '', 'g') || '%')\n"
            "  AND length($2) >= 3\nRETURNING nome, whatsapp, ia_responde AS joao_responde, suporte_responde",
            sql_usuario([ia("cliente", "nome ou numero do cliente"), ia("ativa", "true para responder, false para parar", "boolean"),
                         ia("agente", "joao | suporte")]),
            [2080, 260]),
    ]
    modelos, lig_modelos = modelos_do_agente("IA", "orquestrador", -160, 260)
    nodes += modelos
    con = ligar(("Quando chamado", "Estilo"), ("Estilo", "IA"))
    for origem, destino, idx in lig_modelos:
        ligar_ia(con, origem, destino, "ai_languageModel", idx)
    ligar_ia(con, "Memoria da conversa", "IA", "ai_memory")
    for t in ["especialista_sistemas", "enviar_mensagem", "lembrar", "buscar_memoria", "criar_lembrete",
              "listar_lembretes", "listar_contatos", "cadastrar_contato", "salvar_meu_contato",
              "atendimento_resumo", "atendimento_modo", "liberar_cliente"]:
        ligar_ia(con, t, "IA", "ai_tool")
    return workflow("iaCerebro00001", "Cerebro IA (por usuario)", nodes, con)


def chamar_cerebro(nome, pos, valores):
    return node(nome, "n8n-nodes-base.executeWorkflow", 1.4, pos, {
        "source": "database",
        "workflowId": {"__rl": True, "mode": "id", "value": "iaCerebro00001",
                       "cachedResultName": "Cerebro IA (por usuario)"},
        "workflowInputs": mapear(valores),
        "mode": "once",
        "options": {},
    }, onError="continueRegularOutput")


# ---------------------------------------------------------------------------
# 4) IA PESSOAL no chat do n8n (fala como o admin)
# ---------------------------------------------------------------------------
def ia_pessoal():
    nodes = [
        node("Chat", "@n8n/n8n-nodes-langchain.chatTrigger", 1.5, [0, 0], {
            "availableInChat": True,
            "agentName": "Leo 2.0",
            "agentDescription": "A IA master: sistemas, atendimento do Joao, lembretes, memoria e mensagens.",
            "options": {"responseMode": "lastNode"},
        }, webhookId="9b1f6c2e-1a00-4000-8000-000000000001"),
        node("Admin", "n8n-nodes-base.postgres", 2.6, [220, 0], {
            "operation": "executeQuery",
            "query": "SELECT id, nome, papel FROM nucleo.usuarios WHERE papel = 'admin' AND ativo ORDER BY id LIMIT 1",
            "options": {},
        }, credentials=PG),
        chamar_cerebro("Cerebro", [440, 0], {
            "usuario_id": "={{ $json.id }}",
            "nome": "={{ $json.nome }}",
            "papel": "={{ $json.papel }}",
            "chatInput": "={{ $('Chat').first().json.chatInput }}",
            "sessionId": "=u{{ $json.id }}:n8n-{{ $('Chat').first().json.sessionId }}",
            "canal": "chat do n8n",
        }),
    ]
    con = ligar(("Chat", "Admin"), ("Admin", "Cerebro"))
    return workflow("iaPessoal00001", "IA Pessoal (chat n8n)", nodes, con)


# ---------------------------------------------------------------------------
# 5) API DO PAINEL  POST /webhook/painel   {acao, dados}  + header Authorization: Bearer <token>
# ---------------------------------------------------------------------------
TOKEN = "($json.headers.authorization || '').replace(/^Bearer\\s+/i, '')"


def responder(nome, pos, corpo, status="200", **extra):
    return node(nome, "n8n-nodes-base.respondToWebhook", 1.5, pos, {
        "respondWith": "json",
        "responseBody": corpo,
        "options": {"responseCode": int(status) if str(status).isdigit() else status, "enableStreaming": False},
    }, **extra)


def anotar_falha(nome, pos, origem, agente_expr):
    """Se a IA nao respondeu, registra o evento com o motivo legivel; sempre devolve 1 linha com o motivo."""
    j = f"$('{origem}').first().json"
    erro = (f"({j}.output ? '' : ((typeof {j}.error === 'string' ? {j}.error : ({j}.error && ({j}.error.message "
            f"|| JSON.stringify({j}.error)))) || 'a IA nao devolveu resposta'))")
    return node(nome, "n8n-nodes-base.postgres", 2.6, pos, {
        "operation": "executeQuery",
        "query": "SELECT nucleo.motivo_erro(nullif($1, '')) AS motivo,\n"
                 "  CASE WHEN $1 <> '' THEN nucleo.registrar_evento($2, 'erro', nucleo.motivo_erro($1), $1, '{\"canal\": \"painel\"}') END AS evento",
        "options": {"queryReplacement": "={{ [" + erro + ", " + agente_expr + " || 'leo'] }}"},
    }, credentials=PG, alwaysOutputData=True)


def api_painel():
    nodes = [
        node("Webhook", "n8n-nodes-base.webhook", 2.1, [0, 0], {
            "httpMethod": "POST",
            "path": "painel",
            "responseMode": "responseNode",
            "options": {"allowedOrigins": "*"},
        }, webhookId="9b1f6c2e-1a00-4000-8000-000000000002"),
        node("Regras (banco)", "n8n-nodes-base.postgres", 2.6, [220, 0], {
            "operation": "executeQuery",
            "query": "SELECT nucleo.api($1, $2, $3::jsonb) AS r",
            "options": {"queryReplacement":
                        "={{ [" + TOKEN + ", $json.body.acao || '', JSON.stringify($json.body.dados || {})] }}"},
        }, credentials=PG),
        node("Rota", "n8n-nodes-base.switch", 3.2, [440, 0], {
            "mode": "expression",
            "numberOutputs": 8,
            "output": "={{ $json.r.saida }}",
        }),
        node("WhatsApp (Evolution)", "n8n-nodes-base.code", 2, [700, 420], {
            "mode": "runOnceForAllItems",
            "jsCode": JS_ENVIOS + JS_WHATSAPP_ADMIN,
        }, onError="continueRegularOutput"),
        responder("Resposta WhatsApp", [920, 420],
                  "={{ JSON.stringify($json.error ? { erro: 'WhatsApp: ' + ($json.error.message || $json.error) } : $json) }}",
                  "={{ $json.error ? 502 : 200 }}"),
        node("Rodar monitor", "n8n-nodes-base.executeWorkflow", 1.4, [700, 600], {
            "source": "database",
            "workflowId": {"__rl": True, "mode": "id", "value": "monitorSistemas01", "cachedResultName": "Monitor de Sistemas"},
            "workflowInputs": mapear({"origem": "painel"}),
            "mode": "once", "options": {"waitForSubWorkflow": True},
        }, onError="continueRegularOutput"),
        responder("Verificado", [920, 600], "={{ JSON.stringify({ ok: !$json.error }) }}", "200"),
        node("Enviar aprovada", "n8n-nodes-base.code", 2, [700, 800], {
            "mode": "runOnceForAllItems",
            "jsCode": JS_ENVIOS + r"""
const c = $input.first().json.r.corpo;
if (String(c.numero || '').startsWith('teste')) return [{ json: { ok: true, enviado: false, motivo: 'cliente de teste' } }];
const preferida = c.instancia || INST_JOAO;
// Gabriel so fala pelo numero dele (nunca pelo numero do Leo)
const inst = (await whatsappConectado(preferida)) ? preferida : ((await whatsappConectado(INST)) && !['nucleo', 'gabriel'].includes(preferida) ? INST : null);
if (!inst) return [{ json: { ok: true, enviado: false, motivo: 'WhatsApp desconectado' } }];
const env = await enviarWhatsapp(c.numero, c.texto, false, inst);
return [{ json: { ok: true, enviado: true, ids: (env && env.key && env.key.id) || '' } }];""",
        }, onError="continueRegularOutput"),
        node("Guardar ids aprovada", "n8n-nodes-base.postgres", 2.6, [810, 800], {
            "operation": "executeQuery",
            "query": "INSERT INTO nucleo.whatsapp_enviadas (id) SELECT unnest(string_to_array(nullif($1, ''), ','))\n"
                     "ON CONFLICT DO NOTHING RETURNING id",
            "options": {"queryReplacement": "={{ [$json.ids || ''] }}"},
        }, credentials=PG, onError="continueRegularOutput", alwaysOutputData=True),
        node("Rodar aprendiz", "n8n-nodes-base.executeWorkflow", 1.4, [700, 1200], {
            "source": "database",
            "workflowId": {"__rl": True, "mode": "id", "value": "aprendiz000001", "cachedResultName": "Aprendiz (observa e aprende)"},
            "workflowInputs": mapear({"origem": "painel"}),
            "mode": "once", "options": {"waitForSubWorkflow": True},
        }, onError="continueRegularOutput", alwaysOutputData=True),
        responder("Aprendido", [920, 1200], "={{ JSON.stringify({ ok: !$json.error, sugestoes: $json.sugestoes || 0 }) }}", "200"),
        responder("Aprovada", [920, 800], "={{ JSON.stringify($('Enviar aprovada').first().json.error ? { ok: true, enviado: false, motivo: String($('Enviar aprovada').first().json.error.message || $('Enviar aprovada').first().json.error) } : { ok: true, enviado: !!$('Enviar aprovada').first().json.enviado, motivo: $('Enviar aprovada').first().json.motivo } ) }}", "200"),
        chamar_atendente("Simular atendente", [700, 1000], {
            "agente": "={{ $json.r.corpo.agente }}",
            "cliente_id": "={{ $json.r.corpo.cliente_id || '' }}",
            "nome": "={{ $json.r.corpo.nome }}",
            "chatInput": "={{ $json.r.corpo.chatInput }}",
            "sessionId": "={{ $json.r.corpo.sessionId }}",
            "numero": "={{ $json.r.corpo.numero || '' }}",
        }),
        anotar_falha("Anotar falha simulada", [810, 1000], "Simular atendente", "$('Regras (banco)').first().json.r.corpo.agente"),
        responder("Resposta simulada", [1030, 1000],
                  "={{ JSON.stringify($('Simular atendente').first().json.output ? { resposta: $('Simular atendente').first().json.output } "
                  ": { erro: 'Falhou: ' + $json.motivo, motivo: $json.motivo }) }}",
                  "={{ $('Simular atendente').first().json.output ? 200 : 502 }}"),
        responder("Responder", [700, -200], "={{ JSON.stringify($json.r.corpo) }}", "={{ $json.r.status }}"),
        chamar_cerebro("Cerebro", [700, 0], {
            "usuario_id": "={{ $json.r.corpo.usuario_id }}",
            "nome": "={{ $json.r.corpo.nome }}",
            "papel": "={{ $json.r.corpo.papel }}",
            "chatInput": "={{ $json.r.corpo.chatInput }}",
            "sessionId": "={{ $json.r.corpo.sessionId }}",
            "canal": "={{ $json.r.corpo.canal }}",
        }),
        anotar_falha("Anotar falha", [810, 0], "Cerebro", "'leo'"),
        responder("Resposta da IA", [1030, 0],
                  "={{ JSON.stringify($('Cerebro').first().json.output ? { resposta: $('Cerebro').first().json.output } "
                  ": { erro: 'Falhou: ' + $json.motivo, motivo: $json.motivo }) }}",
                  "={{ $('Cerebro').first().json.output ? 200 : 502 }}"),
        node("Voz (OpenAI)", "n8n-nodes-base.httpRequest", 4.2, [700, 200], {
            "method": "POST",
            "url": "https://api.openai.com/v1/audio/speech",
            "authentication": "predefinedCredentialType",
            "nodeCredentialType": "openAiApi",
            "sendBody": True,
            "specifyBody": "json",
            "jsonBody": "={{ JSON.stringify({ model: 'gpt-4o-mini-tts', voice: 'nova', response_format: 'mp3', "
                        "input: $json.r.corpo.texto, instructions: 'Fale em portugues do Brasil, tom confiante, "
                        "caloroso e levemente futurista, ritmo natural.' }) }}",
            "options": {"response": {"response": {"responseFormat": "file"}}},
        }, credentials={"openAiApi": {"id": "openai01", "name": "OpenAI"}}, onError="continueErrorOutput"),
        node("Audio", "n8n-nodes-base.respondToWebhook", 1.5, [920, 160], {
            "respondWith": "binary",
            "responseDataSource": "automatically",
            "options": {"responseHeaders": {"entries": [{"name": "Content-Type", "value": "audio/mpeg"}]}},
        }),
        responder("Voz falhou", [920, 320], "={{ JSON.stringify({ erro: 'Voz indisponivel' }) }}", "502"),
    ]
    con = ligar(("Webhook", "Regras (banco)"), ("Regras (banco)", "Rota"), ("Cerebro", "Anotar falha"), ("Anotar falha", "Resposta da IA"),
                ("WhatsApp (Evolution)", "Resposta WhatsApp"))
    con["Rota"] = {"main": [
        [{"node": "Responder", "type": "main", "index": 0}],
        [{"node": "Cerebro", "type": "main", "index": 0}],
        [{"node": "Voz (OpenAI)", "type": "main", "index": 0}],
        [{"node": "WhatsApp (Evolution)", "type": "main", "index": 0}],
        [{"node": "Rodar monitor", "type": "main", "index": 0}],
        [{"node": "Enviar aprovada", "type": "main", "index": 0}],
        [{"node": "Simular atendente", "type": "main", "index": 0}],
        [{"node": "Rodar aprendiz", "type": "main", "index": 0}],
    ]}
    con["Enviar aprovada"] = {"main": [[{"node": "Guardar ids aprovada", "type": "main", "index": 0}]]}
    con["Guardar ids aprovada"] = {"main": [[{"node": "Aprovada", "type": "main", "index": 0}]]}
    con["Rodar aprendiz"] = {"main": [[{"node": "Aprendido", "type": "main", "index": 0}]]}
    con["Simular atendente"] = {"main": [[{"node": "Anotar falha simulada", "type": "main", "index": 0}]]}
    con["Anotar falha simulada"] = {"main": [[{"node": "Resposta simulada", "type": "main", "index": 0}]]}
    con["Rodar monitor"] = {"main": [[{"node": "Verificado", "type": "main", "index": 0}]]}
    con["Voz (OpenAI)"] = {"main": [
        [{"node": "Audio", "type": "main", "index": 0}],
        [{"node": "Voz falhou", "type": "main", "index": 0}],
    ]}
    return workflow("apiPainel00001", "API do Painel", nodes, con)


JS_WHATSAPP_ADMIN = r"""
// status / conectar (QR ou codigo de pareamento) / desconectar
const corpo = $input.first().json.r.corpo;
const I = corpo.instancia || INST;
const TOKEN = I === INST ? $env.WHATSAPP_WEBHOOK_SEGREDO : `${$env.WHATSAPP_WEBHOOK_SEGREDO}-${I}`;
const urlWebhook = comHttp($env.WHATSAPP_WEBHOOK_BASE || 'n8n:5678') + '/webhook/whatsapp';
const eventos = ['MESSAGES_UPSERT', 'CONNECTION_UPDATE'];
const cfgWebhook = { enabled: true, url: urlWebhook, byEvents: false, base64: true, events: eventos };
async function estado() {
  try { const x = await evo('GET', `/instance/connectionState/${I}`); return (x.instance || x).state || 'close'; }
  catch (e) { return /404|not exist/i.test(String(e.message) + JSON.stringify(e.description || '')) ? 'inexistente' : 'erro'; }
}
const saida = {};
const espera = ms => new Promise(r => setTimeout(r, ms));
async function pedirQr(num) {
  for (let i = 0; i < 3; i++) {   // logo apos criar, a Evolution as vezes ainda nao tem o QR pronto
    const q = await evo('GET', `/instance/connect/${I}` + (num ? `?number=${num}` : ''));
    if (q && (q.base64 || q.pairingCode)) return q;
    await espera(2000);
  }
  return {};
}
if (corpo.op === 'conectar') {
  // "Conectar"/"Novo QR": sessao que nao esta aberta (QR vencido, limite de QRs, conexao pela metade)
  // e apagada e criada de novo -> QR novo de verdade, sempre.
  const criar = async () => {   // logo depois de apagar, a Evolution ainda esta limpando: tenta algumas vezes
    for (let i = 0; i < 4; i++) {
      try {
        await evo('POST', '/instance/create', { instanceName: I, token: TOKEN,
          integration: 'WHATSAPP-BAILEYS', qrcode: true, ...CONFIG_INSTANCIA, webhook: cfgWebhook });
        await espera(1500);
        return;
      } catch (e) { if (i === 3) throw e; await espera(3000); }
    }
  };
  const num = String(corpo.numero || '').replace(/\D/g, '');
  let st = await estado();
  if (st === 'erro') throw new Error('Evolution (WhatsApp) fora do ar ou reiniciando. Tente de novo em 1 minuto.');
  if (st !== 'open' && st !== 'inexistente') {   // zera a sessao (QR vencido / limite de QRs) sem apagar
    try { await evo('DELETE', `/instance/logout/${I}`); } catch (e) { /* ja estava zerado */ }
    await espera(1500);
    st = await estado();
  }
  if (st === 'inexistente') await criar();
  await evo('POST', `/webhook/set/${I}`, { webhook: cfgWebhook });
  await evo('POST', `/settings/set/${I}`, CONFIG_INSTANCIA);
  if ((await estado()) !== 'open') {
    let q = await pedirQr(num);
    if (!q.base64 && !q.pairingCode) {   // sessao travada de vez: apaga e cria do zero
      try { await evo('DELETE', `/instance/logout/${I}`); } catch (e) { /* ok */ }
      try { await evo('DELETE', `/instance/delete/${I}`); } catch (e) { /* ok */ }
      await espera(3000);
      await criar();
      await evo('POST', `/webhook/set/${I}`, { webhook: cfgWebhook });
      q = await pedirQr(num);
    }
    saida.qr = q.base64 || null;
    saida.codigo = q.pairingCode || null;
    if (!saida.qr && !saida.codigo) saida.aviso = 'O WhatsApp nao devolveu o QR agora. Clique em "Novo QR code" de novo.';
  }
} else if (corpo.op === 'qr') {
  // enquanto espera a leitura: so pega o QR atual (o WhatsApp troca o QR sozinho a cada ~20s), sem zerar nada
  if ((await estado()) === 'connecting') {
    try { const q = await evo('GET', `/instance/connect/${I}`); saida.qr = q.base64 || null; } catch (e) { /* tenta de novo */ }
  }
} else if (corpo.op === 'desconectar') {
  try { await evo('DELETE', `/instance/logout/${I}`); } catch (e) { /* ja desconectado */ }
}
saida.estado = await estado();
if (saida.estado !== 'inexistente' && saida.estado !== 'erro') {
  try { await evo('POST', `/settings/set/${I}`, CONFIG_INSTANCIA); } catch (e) { /* tenta na proxima */ }
}
saida.config = corpo.config || {};
if (saida.estado === 'open') {
  try {
    const lista = await evo('GET', `/instance/fetchInstances?instanceName=${I}`);
    const i = Array.isArray(lista) ? lista[0] : lista;
    saida.numero = String(i.ownerJid || i.owner || '').split('@')[0];
    saida.perfil = i.profileName || null;
  } catch (e) { /* sem detalhes */ }
}
saida.instancia = I;
saida.desconhecidos = corpo.desconhecidos || [];
return [{ json: saida }];
"""


# ---------------------------------------------------------------------------
# 5b) CANAL WHATSAPP  POST /webhook/whatsapp  (a Evolution API chama aqui a cada mensagem)
#     numero cadastrado em nucleo.usuarios.whatsapp -> conversa com a IA daquela pessoa
# ---------------------------------------------------------------------------
JS_LER_MENSAGEM = r"""
const b = $input.first().json.body || {};
// so aceita o que veio da nossa instancia (token secreto configurado ao conectar)
// (Leo usa o segredo; o Joao usa segredo-joao)
if (!$env.WHATSAPP_WEBHOOK_SEGREDO || !String(b.apikey || '').startsWith($env.WHATSAPP_WEBHOOK_SEGREDO)) return [];
if (String(b.event || '').toLowerCase().replace(/_/g, '.') !== 'messages.upsert') return [];
const d = Array.isArray(b.data) ? b.data[0] : b.data;
if (!d || !d.key) return [];
const deMim = !!d.key.fromMe;
let jid = d.key.remoteJid || '';
if (jid.endsWith('@lid')) jid = d.key.remoteJidAlt || d.key.senderPn || d.key.participantAlt || '';
if (!jid.endsWith('@s.whatsapp.net')) return [];          // grupos, status, canais: ignora
const dono = String(b.sender || '').split('@')[0].split(':')[0];
const conversaPropria = deMim && !!dono && jid.split('@')[0] === dono;   // conversa "Voce"
// mensagens do dono para outras pessoas tambem seguem: o banco decide (cliente observado = aprendizado;
// qualquer outra conversa pessoal e ignorada sem guardar nada)
if (deMim) await new Promise(r => setTimeout(r, 2500));    // da tempo de registrar o que a IA enviou
const m = d.message || {};
const texto = m.conversation || (m.extendedTextMessage && m.extendedTextMessage.text)
  || (m.imageMessage && m.imageMessage.caption) || (m.videoMessage && m.videoMessage.caption) || '';
let audio = m.audioMessage ? (m.base64 || d.base64 || null) : null;
let erroAudio = '';
if (m.audioMessage && !audio) {
  // webhook sem o arquivo (comum no audio que VOCE manda): a Evolution baixa direto do WhatsApp.
  // Manda a mensagem INTEIRA (com a chave de midia): so o id nao basta, a Evolution nao guarda mensagens.
  for (const corpo of [{ message: { key: d.key, message: m }, convertToMp4: false }, { message: { key: d.key }, convertToMp4: false }]) {
    try {
      const r = await evo('POST', `/chat/getBase64FromMediaMessage/${b.instance || INST}`, corpo);
      audio = (r && (r.base64 || r.media)) || null;
      if (audio) break;
    } catch (e) { erroAudio = String(e.message || e).slice(0, 200); }
  }
}
if (!texto && !audio && !m.audioMessage) return [];
return [{ json: {
  numero: jid.split('@')[0], nome: d.pushName || '', texto,
  tipo: m.audioMessage ? 'audio' : 'texto', audio_b64: audio,
  de_mim: deMim, conversa_propria: conversaPropria, msg_id: d.key.id || null, erro_audio: erroAudio,
  instancia: b.instance || $env.EVOLUTION_INSTANCIA || 'nucleo', dono,
} }];
"""

JS_PREPARAR = r"""
const msg = $('Mensagem').first().json;
const quem = $('Quem e').first().json.r;
const texto = msg.tipo === 'audio' ? (msg.transcricao || '') : (quem.texto || msg.texto);
return [{ json: { ...quem, chatInput: texto || '[A pessoa mandou um AUDIO que nao consegui ouvir. Diga com naturalidade que o audio nao chegou direito e peca para mandar de novo ou escrever.]' } }];
"""

JS_RESPONDER_WHATSAPP = r"""
const msg = $('Ler mensagem').first().json;
const quem = $('Lote pronto').first().json;
const ent = $input.first().json;
const falha = ent.output ? '' : ((typeof ent.error === 'string' ? ent.error : (ent.error && (ent.error.message || JSON.stringify(ent.error)))) || 'a IA nao devolveu resposta');
const resposta = ent.output || 'Tive um problema para responder agora. Tenta de novo em instantes?';
let enviado = 'texto';
const ids = [];
if (false && msg.tipo === 'audio' && $env.OPENAI_API_KEY) {   // audio vira texto e a resposta e texto (pedido do dono)
  try {
    const mp3 = await this.helpers.httpRequest({ method: 'POST', url: 'https://api.openai.com/v1/audio/speech',
      headers: { Authorization: `Bearer ${$env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: 'nova', response_format: 'mp3', input: resposta,
        instructions: 'Fale em portugues do Brasil, tom natural e amigavel, como num audio de WhatsApp.' }),
      encoding: 'arraybuffer', timeout: 60000 });
    const r = await evo('POST', `/message/sendWhatsAppAudio/${msg.instancia}`, { number: msg.numero, audio: Buffer.from(mp3).toString('base64') });
    if (r && r.key && r.key.id) ids.push(r.key.id);
    enviado = 'audio';
  } catch (e) { enviado = 'texto (audio falhou: ' + e.message + ')'; }
}
let erro = null;
if (!enviado.startsWith('audio')) {
  try { const r = await enviarWhatsapp(msg.numero, resposta, true, msg.instancia); if (r && r.key && r.key.id) ids.push(r.key.id); }
  catch (e) { erro = e.message; }
}
return [{ json: { usuario_id: quem.usuario_id, numero: msg.numero, resposta, enviado, erro, falha, ids: ids.join(',') } }];
"""


JS_ENTREGAR_ATENDIMENTO = r"""
// automatico: manda para o cliente | aprovacao: guarda na fila e avisa os admins
const r = $input.first().json.r;
const fila = r.texto || 'Desculpe, tive um problema agora. Ja ja te respondo.';
const NOMES = { joao: 'João', suporte: 'Suporte24hrs', gabriel: 'Gabriel (seu clone)' };
if (r.falhou) {
  const ok = await whatsappConectado();
  for (const n of r.avisar || []) {
    try { if (ok) await enviarWhatsapp(n, `⚠ ${NOMES[r.agente] || r.agente} falhou e nao respondeu ${$('Lote pronto').first().json.nome || 'um contato'}.\nMotivo: ${r.motivo}\nDetalhes no painel > Erros.`); } catch (e) {}
  }
  return [{ json: { enviado: false, falhou: true, motivo: r.motivo, ids: '' } }];
}
if (r.enviar) {
  const env = await enviarWhatsapp(r.numero, fila, !!r.dono, r.instancia || $('Ler mensagem').first().json.instancia);
  return [{ json: { enviado: true, fila_id: r.fila_id, ids: (env && env.key && env.key.id) || '' } }];
}
const conectado = await whatsappConectado();
for (const n of r.avisar || []) {
  try { if (conectado) await enviarWhatsapp(n, `📥 ${NOMES[r.agente] || r.agente}: resposta esperando sua aprovacao no painel.`); } catch (e) {}
}
return [{ json: { enviado: false, fila_id: r.fila_id, aguardando_aprovacao: true, ids: '' } }];
"""


def canal_whatsapp():
    nodes = [
        node("Webhook", "n8n-nodes-base.webhook", 2.1, [0, 0], {
            "httpMethod": "POST", "path": "whatsapp", "responseMode": "onReceived", "options": {},
        }, webhookId="9b1f6c2e-1a00-4000-8000-000000000004"),
        node("Ler mensagem", "n8n-nodes-base.code", 2, [220, 0], {
            "mode": "runOnceForAllItems", "jsCode": JS_ENVIOS + JS_LER_MENSAGEM,
        }),
        # audio: so transcreve se alguma IA vai ler essa conversa (nao manda audio pessoal para a OpenAI a toa)
        node("Vai ler?", "n8n-nodes-base.postgres", 2.6, [330, 200], {
            "operation": "executeQuery",
            "query": "SELECT nucleo.whatsapp_vai_ler($1, $2, $3::boolean, $4::boolean) AS ler",
            "options": {"queryReplacement": "={{ [$json.instancia, $json.numero, $json.de_mim, $json.conversa_propria] }}"},
        }, credentials=PG, alwaysOutputData=True),
        node("Ouvir?", "n8n-nodes-base.switch", 3.2, [440, 200], {
            "mode": "expression", "numberOutputs": 2,
            "output": "={{ $('Ler mensagem').first().json.tipo === 'audio' && $json.ler && $('Ler mensagem').first().json.audio_b64 ? 1 : 0 }}",
        }),
        node("Mensagem", "n8n-nodes-base.code", 2, [1100, 0], {
            "mode": "runOnceForAllItems",
            "jsCode": "// junta o texto final: no audio, a transcricao vira o texto (e o que as IAs leem e aprendem)\n"
                      "const m = $('Ler mensagem').first().json;\n"
                      "let t = {};\n"
                      "for (const n of ['Transcrever (OpenAI)', 'Transcrever (reserva)']) {\n"
                      "  try { const j = $(n).first().json; if (typeof j.text === 'string' && j.text.trim()) { t = j; break; } if (j.error && !t.error) t = j; } catch (e) { /* nao rodou */ }\n"
                      "}\n"
                      "let transcricao = '', falha = '';\n"
                      "if (m.tipo === 'audio') {\n"
                      "  if (typeof t.text === 'string') transcricao = t.text.trim();\n"
                      "  else if (t.error) falha = typeof t.error === 'string' ? t.error : (t.error.message || JSON.stringify(t.error));\n"
                      "  else if (!m.audio_b64) falha = 'nao consegui baixar o audio do WhatsApp' + (m.erro_audio ? ': ' + m.erro_audio : '');\n"
                      "}\n"
                      "const texto = m.tipo === 'audio' ? (transcricao ? '🎤 ' + transcricao : '') : m.texto;\n"
                      "return [{ json: { ...m, audio_b64: undefined, texto, transcricao, falha_audio: falha } }];",
        }),
        node("Quem e", "n8n-nodes-base.postgres", 2.6, [1320, 0], {
            "operation": "executeQuery",
            "query": "SELECT nucleo.whatsapp_entrada($1, $2, $3, $4, $5::boolean, $6::boolean, $7, $8, $9) AS r,\n"
                     "  CASE WHEN $10 <> '' THEN nucleo.registrar_evento(nucleo.papel_instancia($8), 'aviso',\n"
                     "    'Nao consegui transcrever um audio: ' || nucleo.motivo_erro($10), $10, jsonb_build_object('numero', $1)) END AS evento",
            "options": {"queryReplacement": "={{ [$json.numero, $json.nome, $json.texto, $json.tipo, "
                                            "$json.de_mim, $json.conversa_propria, $json.msg_id, $json.instancia, $json.dono, $json.falha_audio || ''] }}"},
        }, credentials=PG),
        node("Rota", "n8n-nodes-base.switch", 3.2, [1440, 0], {
            "mode": "expression", "numberOutputs": 2,
            # 0 = so leu / nao e com ninguem (para aqui) | 1 = alguma IA responde
            "output": "={{ $json.r.saida === 0 ? 0 : 1 }}",
        }),
        # enquanto transcreve, o lote espera (se a pessoa mandar texto junto, responde tudo de uma vez)
        node("Transcrevendo", "n8n-nodes-base.postgres", 2.6, [500, 300], {
            "operation": "executeQuery",
            "query": "SELECT nucleo.audio_marcar($1) AS marca",
            "options": {"queryReplacement": "={{ [$('Ler mensagem').first().json.instancia + ':' + $('Ler mensagem').first().json.numero] }}"},
        }, credentials=PG, onError="continueRegularOutput"),
        node("Dados do audio", "n8n-nodes-base.code", 2, [600, 300], {
            "mode": "runOnceForAllItems",
            # descobre o formato pelos primeiros bytes (OGG do WhatsApp, MP3, M4A...)
            "jsCode": (
                "const b64 = $('Ler mensagem').first().json.audio_b64;\n"
                "const h = Buffer.from(b64.slice(0, 16), 'base64');\n"
                "const ini = h.toString('latin1');\n"
                "let ext = 'ogg', mime = 'audio/ogg';\n"
                "if (ini.startsWith('ID3') || (h[0] === 0xff && (h[1] & 0xe0) === 0xe0)) { ext = 'mp3'; mime = 'audio/mpeg'; }\n"
                "else if (ini.slice(4, 8) === 'ftyp') { ext = 'm4a'; mime = 'audio/mp4'; }\n"
                "else if (ini.startsWith('RIFF')) { ext = 'wav'; mime = 'audio/wav'; }\n"
                "else if (h[0] === 0x1a && h[1] === 0x45) { ext = 'webm'; mime = 'audio/webm'; }\n"
                "return [{ json: { audio_b64: b64, ext, mime } }];"
            ),
        }),
        node("Audio em arquivo", "n8n-nodes-base.convertToFile", 1.2, [700, 300], {
            "operation": "toBinary",
            "sourceProperty": "audio_b64",
            "binaryPropertyName": "data",
            "options": {"encoding": "base64", "fileName": "={{ 'fala.' + $json.ext }}", "mimeType": "={{ $json.mime }}"},
        }),
        node("Transcrever (OpenAI)", "n8n-nodes-base.httpRequest", 4.2, [880, 300], {
            "method": "POST",
            "url": "https://api.openai.com/v1/audio/transcriptions",
            "authentication": "predefinedCredentialType",
            "nodeCredentialType": "openAiApi",
            "sendBody": True,
            "contentType": "multipart-form-data",
            "bodyParameters": {"parameters": [
                {"parameterType": "formBinaryData", "name": "file", "inputDataFieldName": "data"},
                {"name": "model", "value": "gpt-4o-mini-transcribe"},
                {"name": "language", "value": "pt"},
            ]},
            "options": {"timeout": 600000},
        }, credentials={"openAiApi": {"id": "openai01", "name": "OpenAI"}}, onError="continueErrorOutput"),
        # se o modelo principal recusar (audio muito longo, instabilidade), tenta o whisper
        node("Transcrever (reserva)", "n8n-nodes-base.httpRequest", 4.2, [880, 460], {
            "method": "POST",
            "url": "https://api.openai.com/v1/audio/transcriptions",
            "authentication": "predefinedCredentialType",
            "nodeCredentialType": "openAiApi",
            "sendBody": True,
            "contentType": "multipart-form-data",
            "bodyParameters": {"parameters": [
                {"parameterType": "formBinaryData", "name": "file", "inputDataFieldName": "data"},
                {"name": "model", "value": "whisper-1"},
                {"name": "language", "value": "pt"},
            ]},
            "options": {"timeout": 600000},
        }, credentials={"openAiApi": {"id": "openai01", "name": "OpenAI"}}, onError="continueRegularOutput"),
        node("Transcrito", "n8n-nodes-base.postgres", 2.6, [1000, 300], {
            "operation": "executeQuery",
            "query": "SELECT nucleo.audio_desmarcar(nullif($1, '')::bigint) AS ok",
            "options": {"queryReplacement": "={{ [String(($('Transcrevendo').first().json || {}).marca || '')] }}"},
        }, credentials=PG, alwaysOutputData=True, onError="continueRegularOutput"),
        node("Preparar", "n8n-nodes-base.code", 2, [1540, 140], {
            "mode": "runOnceForAllItems", "jsCode": JS_ENVIOS + JS_PREPARAR,
        }),
        node("Guardar no lote", "n8n-nodes-base.postgres", 2.6, [1600, -140], {
            "operation": "executeQuery",
            "query": "SELECT * FROM nucleo.lote_adicionar($1, $2)",
            "options": {"queryReplacement": "={{ [$('Ler mensagem').first().json.instancia + ':' + $('Ler mensagem').first().json.numero + ':' + ($('Preparar').first().json.agente || 'leo'), $json.chatInput] }}"},
        }, credentials=PG),
        node("Esperar a pessoa terminar", "n8n-nodes-base.code", 2, [1700, -140], {
            "mode": "runOnceForAllItems",
            "jsCode": "// espera alguns segundos: se chegar outra mensagem, a execucao dela responde por todas\n"
                      "await new Promise(r => setTimeout(r, (+$input.first().json.espera || 12) * 1000));\n"
                      "return $input.all();",
        }),
        node("Fechar lote", "n8n-nodes-base.postgres", 2.6, [1800, -140], {
            "operation": "executeQuery",
            "query": "SELECT * FROM nucleo.lote_fechar($1, $2::bigint)",
            "options": {"queryReplacement": "={{ [$('Ler mensagem').first().json.instancia + ':' + $('Ler mensagem').first().json.numero + ':' + ($('Preparar').first().json.agente || 'leo'), String($json.id)] }}"},
        }, credentials=PG, alwaysOutputData=True),
        node("Lote pronto", "n8n-nodes-base.code", 2, [1900, -140], {
            "mode": "runOnceForAllItems",
            "jsCode": JS_ENVIOS + r"""
// so a ultima mensagem da sequencia segue; ela leva o texto de TODAS
const lote = $input.all().map(i => i.json).find(j => j.texto);
if (!lote) return [];
const msg = $('Ler mensagem').first().json;
try { await evo('POST', `/chat/sendPresence/${msg.instancia}`, { number: msg.numero, presence: msg.tipo === 'audio' ? 'recording' : 'composing', delay: 1500 }); } catch (e) {}
const prep = $('Preparar').first().json;
// conversa "Voce" no numero da IA: quem fala e o dono (chefe), nao um cliente
const DONO = prep.agente === 'gabriel'
  ? '[Conversa particular com o proprio dono (a pessoa que voce imita). Ele pode te ensinar como fala e age, te corrigir ou te testar. Responda direto a ele, natural.]\n'
  : '[Mensagem do seu CHEFE (o dono da empresa) pela conversa interna do seu WhatsApp. Ele NAO e cliente: pode te ensinar (precos, regras, jeito de responder), te corrigir ou te testar. Responda como um funcionario responde ao chefe. Nao abra chamado nem registre lead nesta conversa.]\n';
return [{ json: { ...prep, chatInput: (prep.dono ? DONO : '') + lote.texto, mensagens_juntas: lote.quantidade } }];""",
        }),
        node("Quem responde", "n8n-nodes-base.switch", 3.2, [1650, 0], {
            "mode": "expression", "numberOutputs": 2,
            "output": "={{ $json.saida === 2 ? 1 : 0 }}",   # 0 = IA do usuario | 1 = atendente (cliente)
        }),
        # quem e essa pessoa para a IA (nova, cliente antigo, amigo, intima...) -> ajusta tom e cuidados
        node("Perfil do contato", "n8n-nodes-base.postgres", 2.6, [1700, 400], {
            "operation": "executeQuery",
            "query": "SELECT CASE WHEN $3 = 'dono' THEN '' ELSE nucleo.perfil_texto($1, $2) END AS perfil",
            "options": {"queryReplacement": "={{ [$('Lote pronto').first().json.agente, String($('Lote pronto').first().json.numero || ''), $('Lote pronto').first().json.dono ? 'dono' : ''] }}"},
        }, credentials=PG, alwaysOutputData=True, onError="continueRegularOutput"),
        chamar_atendente("Atendente", [1860, 260], {
            "agente": "={{ $('Lote pronto').first().json.agente }}",
            "cliente_id": "={{ $('Lote pronto').first().json.cliente_id || '' }}",
            "nome": "={{ $('Lote pronto').first().json.nome }}",
            "chatInput": "={{ ($json.perfil || '') + $('Lote pronto').first().json.chatInput }}",
            "sessionId": "={{ $('Lote pronto').first().json.sessionId }}",
            "numero": "={{ $('Lote pronto').first().json.numero || '' }}",
        }),
        node("Registrar atendimento", "n8n-nodes-base.postgres", 2.6, [1980, 260], {
            "operation": "executeQuery",
            # sem resposta da IA: registra a falha com o motivo e avisa o admin (nada vai para o cliente)
            "query": "SELECT CASE WHEN $3 = '' THEN nucleo.agente_falhou($4, $7, nullif($5, ''), $2)\n"
                     "  WHEN $8 = 'dono' THEN nucleo.agente_responder_dono($4, $5, $3)\n"
                     "  ELSE nucleo.agente_registrar(nullif($1, '')::int, $2, $3, $4, nullif($5, ''), nullif($6, '')) END AS r",
            "options": {"queryReplacement": "={{ [String($('Lote pronto').first().json.cliente_id || ''), $('Lote pronto').first().json.chatInput, "
                                            "$json.output || '', "
                                            "$('Lote pronto').first().json.agente, String($('Lote pronto').first().json.numero || ''), "
                                            "$('Lote pronto').first().json.nome || '', (typeof $json.error === 'string' ? $json.error : ($json.error && ($json.error.message || JSON.stringify($json.error)))) || 'a IA nao devolveu resposta', ($('Lote pronto').first().json.dono ? 'dono' : '')] }}"},
        }, credentials=PG),
        node("Entregar atendimento", "n8n-nodes-base.code", 2, [2200, 260], {
            "mode": "runOnceForAllItems",
            "jsCode": JS_ENVIOS + JS_ENTREGAR_ATENDIMENTO,
        }),
        node("Guardar ids", "n8n-nodes-base.postgres", 2.6, [2420, 260], {
            "operation": "executeQuery",
            "query": "INSERT INTO nucleo.whatsapp_enviadas (id) SELECT unnest(string_to_array(nullif($1, ''), ',')) ON CONFLICT DO NOTHING",
            "options": {"queryReplacement": "={{ [$json.ids || ''] }}"},
        }, credentials=PG, onError="continueRegularOutput"),
        chamar_cerebro("Cerebro", [1760, 0], {
            "usuario_id": "={{ $json.usuario_id }}",
            "nome": "={{ $json.nome }}",
            "papel": "={{ $json.papel }}",
            "chatInput": "={{ $json.chatInput }}",
            "sessionId": "={{ $json.sessionId }}",
            "canal": "={{ $json.canal }}",
        }),
        node("Responder no WhatsApp", "n8n-nodes-base.code", 2, [1980, 0], {
            "mode": "runOnceForAllItems", "jsCode": JS_ENVIOS + JS_RESPONDER_WHATSAPP,
        }),
        node("Registrar resposta", "n8n-nodes-base.postgres", 2.6, [2200, 0], {
            "operation": "executeQuery",
            "query": "SELECT nucleo.whatsapp_saida($1::int, $2, $3, string_to_array(nullif($4, ''), ',')),\n"
                     "  CASE WHEN $5 <> '' THEN nucleo.registrar_evento('leo', 'erro', nucleo.motivo_erro($5), $5, jsonb_build_object('numero', $2, 'canal', 'whatsapp')) END AS evento,\n"
                     "  CASE WHEN $6 <> '' THEN nucleo.registrar_evento('leo', 'aviso', 'Nao consegui entregar no WhatsApp: ' || nucleo.motivo_erro($6), $6, jsonb_build_object('numero', $2)) END AS aviso",
            "options": {"queryReplacement": "={{ [$json.usuario_id, $json.numero, $json.resposta, $json.ids, $json.falha || '', $json.erro || ''] }}"},
        }, credentials=PG),
    ]
    con = ligar(("Webhook", "Ler mensagem"), ("Ler mensagem", "Vai ler?"), ("Vai ler?", "Ouvir?"),
                ("Dados do audio", "Audio em arquivo"), ("Audio em arquivo", "Transcrever (OpenAI)"),
                ("Mensagem", "Quem e"), ("Quem e", "Rota"),
                ("Transcrevendo", "Dados do audio"), ("Transcrever (reserva)", "Transcrito"), ("Transcrito", "Mensagem"),
                ("Preparar", "Guardar no lote"),
                ("Guardar no lote", "Esperar a pessoa terminar"), ("Esperar a pessoa terminar", "Fechar lote"),
                ("Fechar lote", "Lote pronto"), ("Lote pronto", "Quem responde"),
                ("Atendente", "Registrar atendimento"), ("Registrar atendimento", "Entregar atendimento"),
                ("Entregar atendimento", "Guardar ids"),
                ("Cerebro", "Responder no WhatsApp"), ("Responder no WhatsApp", "Registrar resposta"))
    con["Quem responde"] = {"main": [
        [{"node": "Cerebro", "type": "main", "index": 0}],
        [{"node": "Perfil do contato", "type": "main", "index": 0}],
    ]}
    con["Perfil do contato"] = {"main": [[{"node": "Atendente", "type": "main", "index": 0}]]}
    con["Rota"] = {"main": [
        [],
        [{"node": "Preparar", "type": "main", "index": 0}],
    ]}
    con["Ouvir?"] = {"main": [
        [{"node": "Mensagem", "type": "main", "index": 0}],
        [{"node": "Transcrevendo", "type": "main", "index": 0}],
    ]}
    con["Transcrever (OpenAI)"] = {"main": [
        [{"node": "Transcrito", "type": "main", "index": 0}],
        [{"node": "Transcrever (reserva)", "type": "main", "index": 0}],
    ]}
    return workflow("canalWhatsapp01", "Canal WhatsApp", nodes, con)


# ---------------------------------------------------------------------------
# 6) API DE AUDIO  POST /webhook/painel-audio?sessao=x   corpo = audio cru (webm/mp4/ogg)
# ---------------------------------------------------------------------------
def api_audio():
    nodes = [
        node("Webhook", "n8n-nodes-base.webhook", 2.1, [0, 0], {
            "httpMethod": "POST",
            "path": "painel-audio",
            "responseMode": "responseNode",
            "options": {"allowedOrigins": "*", "rawBody": True},
        }, webhookId="9b1f6c2e-1a00-4000-8000-000000000003"),
        node("Regras (banco)", "n8n-nodes-base.postgres", 2.6, [220, 0], {
            "operation": "executeQuery",
            "query": "SELECT nucleo.api($1, 'audio', $2::jsonb) AS r",
            "options": {"queryReplacement":
                        "={{ [" + TOKEN + ", JSON.stringify({ sessao: $json.query.sessao || 'painel' })] }}"},
        }, credentials=PG),
        node("Rota", "n8n-nodes-base.switch", 3.2, [440, 0], {
            "mode": "expression",
            "numberOutputs": 2,
            "output": "={{ $json.r.saida === 1 ? 1 : 0 }}",
        }),
        responder("Negado", [660, -160], "={{ JSON.stringify($json.r.corpo) }}", "={{ $json.r.status }}"),
        node("Preparar audio", "n8n-nodes-base.code", 2, [660, 0], {
            "mode": "runOnceForAllItems",
            "jsCode": (
                "// devolve o audio do webhook com nome/extensao que a OpenAI reconhece\n"
                "const recebido = $('Webhook').first().binary || {};\n"
                "const bin = { ...(recebido.data || recebido.audio || Object.values(recebido)[0]) };\n"
                "if (!bin.mimeType) throw new Error('Nenhum audio recebido');\n"
                "const mime = (bin.mimeType || 'audio/webm').split(';')[0];\n"
                "const ext = { 'audio/webm': 'webm', 'audio/mp4': 'mp4', 'audio/x-m4a': 'm4a', 'audio/mpeg': 'mp3',\n"
                "  'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/aac': 'm4a' }[mime] || 'webm';\n"
                "bin.fileName = 'fala.' + ext; bin.fileExtension = ext; bin.mimeType = mime;\n"
                "return [{ json: $input.first().json, binary: { audio: bin } }];"
            ),
        }),
        node("Transcrever (OpenAI)", "n8n-nodes-base.httpRequest", 4.2, [880, 0], {
            "method": "POST",
            "url": "https://api.openai.com/v1/audio/transcriptions",
            "authentication": "predefinedCredentialType",
            "nodeCredentialType": "openAiApi",
            "sendBody": True,
            "contentType": "multipart-form-data",
            "bodyParameters": {"parameters": [
                {"parameterType": "formBinaryData", "name": "file", "inputDataFieldName": "audio"},
                {"name": "model", "value": "gpt-4o-mini-transcribe"},
                {"name": "language", "value": "pt"},
            ]},
            "options": {},
        }, credentials={"openAiApi": {"id": "openai01", "name": "OpenAI"}}, onError="continueErrorOutput"),
        chamar_cerebro("Cerebro", [1100, 0], {
            "usuario_id": "={{ $('Regras (banco)').first().json.r.corpo.usuario_id }}",
            "nome": "={{ $('Regras (banco)').first().json.r.corpo.nome }}",
            "papel": "={{ $('Regras (banco)').first().json.r.corpo.papel }}",
            "chatInput": "={{ $json.text }}",
            "sessionId": "={{ $('Regras (banco)').first().json.r.corpo.sessionId }}",
            "canal": "voz",
        }),
        responder("Resposta", [1320, 0],
                  "={{ JSON.stringify($json.output ? { transcricao: $('Transcrever (OpenAI)').first().json.text, resposta: $json.output } "
                  ": { erro: 'A IA falhou', transcricao: $('Transcrever (OpenAI)').first().json.text }) }}",
                  "={{ $json.output ? 200 : 502 }}"),
        responder("Nao entendi", [1100, 200],
                  "={{ JSON.stringify({ erro: 'Nao consegui transcrever o audio' }) }}", "502"),
    ]
    con = ligar(("Webhook", "Regras (banco)"), ("Regras (banco)", "Rota"),
                ("Preparar audio", "Transcrever (OpenAI)"), ("Cerebro", "Resposta"))
    con["Rota"] = {"main": [
        [{"node": "Negado", "type": "main", "index": 0}],
        [{"node": "Preparar audio", "type": "main", "index": 0}],
    ]}
    con["Transcrever (OpenAI)"] = {"main": [
        [{"node": "Cerebro", "type": "main", "index": 0}],
        [{"node": "Nao entendi", "type": "main", "index": 0}],
    ]}
    return workflow("apiPainelAudio1", "API do Painel (audio)", nodes, con)


# ---------------------------------------------------------------------------
# 7) LEMBRETES (dispara os lembretes vencidos a cada minuto)
# ---------------------------------------------------------------------------
def lembretes():
    nodes = [
        node("A cada minuto", "n8n-nodes-base.scheduleTrigger", 1.2, [0, 0], {
            "rule": {"interval": [{"field": "minutes", "minutesInterval": 1}]}}),
        node("Testar agora", "n8n-nodes-base.manualTrigger", 1, [0, 200], {}),
        node("Pegar vencidos", "n8n-nodes-base.postgres", 2.6, [220, 0], {
            "operation": "executeQuery",
            "query": "UPDATE nucleo.lembretes SET enviado_em = now()\n"
                     "WHERE enviado_em IS NULL AND quando <= now()\n"
                     "RETURNING id, usuario_id, texto, coalesce(contato, '') AS contato",
            "options": {},
        }, credentials=PG),
        node("So lembretes", "n8n-nodes-base.code", 2, [440, 0], {
            "mode": "runOnceForAllItems",
            "jsCode": "return $input.all().filter(i => i.json.id);",
        }),
        node("Enviar", "n8n-nodes-base.executeWorkflow", 1.4, [660, 0], {
            "source": "database",
            "workflowId": {"__rl": True, "mode": "id", "value": "ferrEnviarMsg01",
                           "cachedResultName": "Ferramenta: Enviar mensagem"},
            "workflowInputs": mapear({
                "usuario_id": "={{ $json.usuario_id }}",
                "contato": "={{ $json.contato }}",
                "mensagem": "=⏰ Lembrete: {{ $json.texto }}",
            }),
            "mode": "each",
            "options": {},
        }, onError="continueRegularOutput"),
    ]
    con = ligar(("A cada minuto", "Pegar vencidos"), ("Testar agora", "Pegar vencidos"),
                ("Pegar vencidos", "So lembretes"), ("So lembretes", "Enviar"))
    return workflow("lembretes00001", "Lembretes", nodes, con)


# ---------------------------------------------------------------------------
# 0) MONITOR v2 (a cada 1 min): Render + Vercel pela API, todas as URLs em paralelo com tempo
#    de resposta, regras fixas no banco (registrar_checks) e avisos por WhatsApp/Telegram.
# ---------------------------------------------------------------------------
JS_PLATAFORMAS = r"""
// Lista o que existe nas contas Render/Vercel (se as chaves estiverem no .env) e diz se esta ok.
const itens = [];
const pedir = (url, token) => this.helpers.httpRequest({ method: 'GET', url, json: true, timeout: 20000,
  headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
const erroConta = (origem, e) => itens.push({ origem, externo_id: `${origem}:conta`, nome: `${origem === 'render' ? 'Render' : 'Vercel'} (acesso a conta)`,
  ok: false, detalhe: 'API recusou ou nao respondeu: ' + (e.message || e).toString().slice(0, 200),
  painel_url: origem === 'render' ? 'https://dashboard.render.com' : 'https://vercel.com/dashboard' });
const contaOk = (origem) => itens.push({ origem, externo_id: `${origem}:conta`, nome: `${origem === 'render' ? 'Render' : 'Vercel'} (acesso a conta)`,
  ok: true, detalhe: 'API respondendo', painel_url: origem === 'render' ? 'https://dashboard.render.com' : 'https://vercel.com/dashboard' });

// ---------------- Render
if ($env.RENDER_API_KEY) {
  try {
    let cursor = '', servicos = [];
    for (let p = 0; p < 5; p++) {
      const pg = await pedir(`https://api.render.com/v1/services?limit=100${cursor ? '&cursor=' + cursor : ''}`, $env.RENDER_API_KEY);
      servicos = servicos.concat(pg.map(x => x.service));
      if (pg.length < 100) break;
      cursor = pg[pg.length - 1].cursor;
    }
    contaOk('render');
    const RUINS = { build_failed: 'build falhou', update_failed: 'atualizacao falhou', pre_deploy_failed: 'pre-deploy falhou', canceled: 'deploy cancelado' };
    await Promise.all(servicos.map(async s => {
      // suspenso: nao e falha, so some do painel (volta sozinho se reativar)
      if (s.suspended === 'suspended') { itens.push({ origem: 'render', externo_id: `render:${s.id}:deploy`, suspenso: true }); return; }
      let ok = true, detalhe = 'no ar';
      {
        try {
          const d = (await pedir(`https://api.render.com/v1/services/${s.id}/deploys?limit=1`, $env.RENDER_API_KEY))[0];
          const st = d && d.deploy ? d.deploy.status : null;
          if (st && RUINS[st]) { ok = false; detalhe = `ultimo deploy: ${RUINS[st]}` + (d.deploy.commit && d.deploy.commit.message ? ` (${d.deploy.commit.message.split('\n')[0].slice(0, 80)})` : ''); }
          else if (st && st !== 'live' && st !== 'deactivated') detalhe = `deploy em andamento (${st})`;
          else detalhe = 'ultimo deploy ok';
        } catch (e) { detalhe = 'nao consegui ler os deploys'; }
      }
      const url = s.serviceDetails && s.serviceDetails.url && s.type !== 'private_service' ? s.serviceDetails.url : '';
      itens.push({ origem: 'render', externo_id: `render:${s.id}:deploy`, nome: `Render · ${s.name} (deploy)`, nome_site: `Render · ${s.name}`,
        ok, detalhe, painel_url: s.dashboardUrl || `https://dashboard.render.com`, url: s.suspended === 'suspended' ? '' : url });
    }));
  } catch (e) { erroConta('render', e); }
}

// ---------------- Vercel
if ($env.VERCEL_TOKEN) {
  const team = $env.VERCEL_TEAM_ID ? `&teamId=${$env.VERCEL_TEAM_ID}` : '';
  try {
    const r = await pedir(`https://api.vercel.com/v10/projects?limit=100${team}`, $env.VERCEL_TOKEN);
    contaOk('vercel');
    await Promise.all((r.projects || []).map(async p => {
      let ok = true, detalhe = 'sem deploy de producao ainda', painel = `https://vercel.com/dashboard`;
      try {
        const d = ((await pedir(`https://api.vercel.com/v7/deployments?projectId=${p.id}&target=production&limit=1${team}`, $env.VERCEL_TOKEN)).deployments || [])[0];
        if (d) {
          const st = d.state || d.readyState;
          painel = d.inspectorUrl || painel;
          if (st === 'ERROR') { ok = false; detalhe = 'ultimo deploy de producao FALHOU' + (d.errorMessage ? `: ${String(d.errorMessage).slice(0, 120)}` : ''); }
          else if (st === 'READY') detalhe = 'ultimo deploy ok';
          else detalhe = `deploy em andamento (${st})`;
        }
      } catch (e) { detalhe = 'nao consegui ler os deploys'; }
      const prod = p.targets && p.targets.production;
      const alias = prod && Array.isArray(prod.alias) ? prod.alias : [];
      const dominio = alias.find(a => !a.endsWith('.vercel.app')) || alias[0] || '';
      itens.push({ origem: 'vercel', externo_id: `vercel:${p.id}:deploy`, nome: `Vercel · ${p.name} (deploy)`, nome_site: `Vercel · ${p.name}`,
        ok, detalhe, painel_url: painel, url: dominio ? `https://${dominio}` : '' });
    }));
  } catch (e) { erroConta('vercel', e); }
}
return [{ json: { itens: JSON.stringify(itens), total: itens.length } }];
"""

JS_CHECAR_TUDO = r"""
// Bate em todas as URLs em paralelo (10 por vez), mede o tempo e aplica a regra de cada sistema.
const sistemas = $input.all().map(i => i.json).filter(s => s.id);
const lento = 8000;
async function checar(s) {
  const t0 = Date.now();
  try {
    const r = await this.helpers.httpRequest({ method: s.metodo || 'GET', url: s.url, timeout: s.timeout_ms || 15000,
      returnFullResponse: true, ignoreHttpStatusErrors: true, encoding: 'text',
      headers: { 'User-Agent': 'IA-Central-Monitor/1.0', 'Cache-Control': 'no-cache' } });
    const ms = Date.now() - t0, st = r.statusCode;
    const corpo = typeof r.body === 'string' ? r.body : JSON.stringify(r.body || '');
    // -1 = site descoberto no Render/Vercel: qualquer resposta do servidor conta (API responde 404 na raiz)
    const statusOk = s.status_esperado > 0 ? st === s.status_esperado : st < (s.status_esperado === -1 ? 500 : 400);
    if (!statusOk) return { sistema_id: s.id, ok: false, tempo_ms: ms, detalhe: `HTTP ${st}` + (s.status_esperado ? ` (esperado ${s.status_esperado})` : '') };
    if (s.texto_esperado && !corpo.includes(s.texto_esperado)) return { sistema_id: s.id, ok: false, tempo_ms: ms, detalhe: `resposta sem "${s.texto_esperado}"` };
    return { sistema_id: s.id, ok: true, tempo_ms: ms, detalhe: `HTTP ${st} em ${ms} ms` + (ms > lento ? ' (LENTO)' : '') };
  } catch (e) {
    const ms = Date.now() - t0;
    const m = String(e.message || e);
    const motivo = /timeout|ETIMEDOUT|ECONNABORTED/i.test(m) ? `sem resposta em ${Math.round(ms / 1000)}s` :
      /ENOTFOUND|EAI_AGAIN/i.test(m) ? 'dominio nao encontrado (DNS)' :
      /ECONNREFUSED/i.test(m) ? 'conexao recusada' : /certificate|SSL|TLS/i.test(m) ? 'erro de certificado SSL' : m.slice(0, 160);
    return { sistema_id: s.id, ok: false, tempo_ms: ms, detalhe: motivo };
  }
}
const resultados = [];
for (let i = 0; i < sistemas.length; i += 10) {
  resultados.push(...await Promise.all(sistemas.slice(i, i + 10).map(s => checar.call(this, s))));
}
const plataformas = JSON.parse($('Sincronizar').first().json.checks || '[]');
const todos = resultados.concat(typeof plataformas === 'string' ? JSON.parse(plataformas) : plataformas);
const b64 = Buffer.from(JSON.stringify(todos), 'utf8').toString('base64');
return [{ json: { total: todos.length, falhas: todos.filter(c => !c.ok).length, checks_b64: b64,
  resumo: resultados.map(r => ({ id: r.sistema_id, ok: r.ok, ms: r.tempo_ms, detalhe: r.detalhe })) } }];
"""

JS_AVISAR = r"""
// Entrega cada aviso pelo canal da linha (WhatsApp ou Telegram).
const conectado = await whatsappConectado();
const saida = [];
for (const it of $input.all()) {
  const a = it.json;
  if (!a.destino) continue;
  let enviado = false, erro = null;
  try {
    if (a.canal === 'whatsapp' && conectado) { await enviarWhatsapp(a.destino, a.mensagem); enviado = true; }
    else if (a.canal === 'telegram' && $env.TELEGRAM_BOT_TOKEN) { await enviarTelegram.call(this, a.destino, a.mensagem); enviado = true; }
    else erro = a.canal === 'whatsapp' ? 'WhatsApp desconectado' : 'Telegram sem token';
  } catch (e) { erro = e.message; }
  saida.push({ json: { sistema: a.sistema, evento: a.evento, canal: a.canal, enviado, erro } });
}
return saida;
"""


def monitor():
    nodes = [
        node("A cada minuto", "n8n-nodes-base.scheduleTrigger", 1.2, [0, 0], {
            "rule": {"interval": [{"field": "minutes", "minutesInterval": 1}]}}),
        node("Testar agora", "n8n-nodes-base.manualTrigger", 1, [0, 180], {}),
        gatilho_subworkflow(["origem"], pos=(0, 360)),
        node("Plataformas", "n8n-nodes-base.code", 2, [240, 180], {
            "mode": "runOnceForAllItems", "jsCode": JS_PLATAFORMAS,
        }, onError="continueRegularOutput"),
        node("Sincronizar", "n8n-nodes-base.postgres", 2.6, [460, 180], {
            "operation": "executeQuery",
            "query": "SELECT nucleo.sincronizar_plataformas(coalesce(nullif($1, ''), '[]')::jsonb)::text AS checks",
            "options": {"queryReplacement": "={{ [$json.itens || '[]'] }}"},
        }, credentials=PG),
        node("Buscar sistemas", "n8n-nodes-base.postgres", 2.6, [680, 180], {
            "operation": "executeQuery",
            "query": "SELECT id, nome, url, metodo, status_esperado, texto_esperado, timeout_ms\n"
                     "FROM nucleo.sistemas WHERE ativo AND tipo = 'http' ORDER BY id",
            "options": {},
        }, credentials=PG, alwaysOutputData=True),
        node("Checar tudo", "n8n-nodes-base.code", 2, [900, 180], {
            "mode": "runOnceForAllItems", "jsCode": JS_CHECAR_TUDO,
        }),
        node("Registrar e decidir alertas", "n8n-nodes-base.postgres", 2.6, [1120, 180], {
            "operation": "executeQuery",
            "query": "SELECT * FROM nucleo.registrar_checks(convert_from(decode($1, 'base64'), 'UTF8')::jsonb)",
            "options": {"queryReplacement": "={{ [$json.checks_b64] }}"},
        }, credentials=PG),
        node("Avisar", "n8n-nodes-base.code", 2, [1340, 180], {
            "mode": "runOnceForAllItems", "jsCode": JS_ENVIOS + JS_AVISAR,
        }),
        node("Resultado", "n8n-nodes-base.code", 2, [1340, 380], {
            "mode": "runOnceForAllItems",
            "jsCode": "const c = $('Checar tudo').first().json;\n"
                      "return [{ json: { verificados: c.total, falhas: c.falhas, sistemas: c.resumo } }];",
        }),
    ]
    con = ligar(("A cada minuto", "Plataformas"), ("Testar agora", "Plataformas"), ("Quando chamado", "Plataformas"),
                ("Plataformas", "Sincronizar"), ("Sincronizar", "Buscar sistemas"), ("Buscar sistemas", "Checar tudo"),
                ("Checar tudo", "Registrar e decidir alertas"), ("Checar tudo", "Resultado"),
                ("Registrar e decidir alertas", "Avisar"))
    wf = workflow("monitorSistemas01", "Monitor de Sistemas", nodes, con)
    wf["settings"]["saveDataSuccessExecution"] = "none"   # roda todo minuto: so guarda execucao com erro
    return wf


# ---------------------------------------------------------------------------
# 0b) FERRAMENTA: CHECAR AGORA (qualquer URL, na hora, sem cadastrar)
# ---------------------------------------------------------------------------
def ferramenta_checar_agora():
    nodes = [
        gatilho_subworkflow(["url"]),
        node("Checar", "n8n-nodes-base.code", 2, [240, 0], {
            "mode": "runOnceForAllItems",
            "jsCode": r"""
let url = String($input.first().json.url || '').trim();
if (!url) return [{ json: { resultado: 'URL vazia' } }];
if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
const t0 = Date.now();
try {
  const r = await this.helpers.httpRequest({ method: 'GET', url, timeout: 20000, returnFullResponse: true,
    ignoreHttpStatusErrors: true, encoding: 'text', headers: { 'User-Agent': 'IA-Central-Monitor/1.0' } });
  const ms = Date.now() - t0;
  const titulo = (String(r.body || '').match(/<title[^>]*>([^<]{0,120})/i) || [])[1] || null;
  return [{ json: { url, no_ar: r.statusCode < 400, status_http: r.statusCode, tempo_ms: ms,
    avaliacao: r.statusCode >= 400 ? 'com erro' : ms > 8000 ? 'muito lento' : ms > 2500 ? 'lento' : 'rapido', titulo } }];
} catch (e) {
  return [{ json: { url, no_ar: false, tempo_ms: Date.now() - t0, erro: String(e.message || e).slice(0, 200) } }];
}""",
        }),
    ]
    return workflow("ferrChecarAgora1", "Ferramenta: Checar agora", nodes, ligar(("Quando chamado", "Checar")))


# ---------------------------------------------------------------------------
# ATENDENTE (clientes): recepcao + 3 especialistas (suporte, comercial, sistemico)
# Quem esta sendo atendido vem do gatilho (cliente_id); nunca da IA.
# ---------------------------------------------------------------------------
CID = "$('Quando chamado').first().json.cliente_id"
EMPRESA = "$('Empresa').first().json.cfg.empresa"


def sql_cliente(params_ia):
    return [CID] + params_ia


def no_empresa(pos, agente="joao"):
    return node("Empresa", "n8n-nodes-base.postgres", 2.6, pos, {
        "operation": "executeQuery",
        "query": f"SELECT nucleo.agente_config('{agente}') AS cfg, nucleo.estilo_agente('{agente}') AS estilo",
        "options": {},
    }, credentials=PG)


BLOCO_EMPRESA = """Voce se chama {{ """ + EMPRESA + """.persona || 'equipe de atendimento' }} e faz parte do time de atendimento.
Empresa: {{ """ + EMPRESA + """.nome }}. {{ """ + EMPRESA + """.descricao || '' }}
Jeito de escrever do time (aprendido das conversas reais; imite): {{ $('Empresa').first().json.estilo || '(ainda aprendendo)' }}
Horario de atendimento humano: {{ """ + EMPRESA + """.horario || 'nao informado' }}. Tom: {{ """ + EMPRESA + """.tom || 'simpatico e objetivo' }}.
Agora: {{ $now.setZone('America/Sao_Paulo').toFormat("cccc, dd/MM/yyyy HH:mm", { locale: 'pt-BR' }) }}."""

REGRAS_CLIENTE = """Regras com o cliente (sempre, sem excecao):
- Mensagem que comeca com "🎤" e um AUDIO ja transcrito: trate como texto normal (mesmo se for longo) e responda em texto.
  Se pedirem para resumir/analisar um audio, analise o conteudo transcrito com cuidado.
- O cliente pode ter mandado varias mensagens seguidas (uma por linha): leia todas e responda tudo numa vez so.
- Antes da mensagem pode vir [Sobre quem esta falando com voce...]: e so para voce (nunca comente). Use para acertar o tom:
  pessoa nova = mais educado e apresente-se; cliente antigo = mais direto e caloroso.
- Escreva como uma pessoa do time escreve no WhatsApp: natural, curto (no maximo 4 frases), sem listas formais,
  sem titulos, *negrito* so em 1 ou 2 palavras. Nada de "como assistente virtual", "sou uma IA" ou frases de robo.
- Nao se apresente como IA. Mas se o cliente perguntar DIRETAMENTE se fala com robo, IA ou pessoa, nunca minta:
  diga com naturalidade que e o assistente digital da equipe e ofereca passar para uma pessoa (abrir chamado area humano).
- SO afirme o que esta escrito na base de conhecimento ou veio das ferramentas. Isso vale para servicos oferecidos,
  precos, prazos, horarios, politicas e promessas. Se nao estiver na base, NAO diga "sim, fazemos" nem "nao fazemos":
  diga que vai confirmar com a equipe e pergunte se pode abrir um chamado para retornarem.
- Nao complete com suposicoes ("normalmente...", "geralmente...", "tambem aceitamos..."): nada de formas de
  pagamento, exigencias, documentos, juros, prazos ou condicoes que nao estejam escritos na base. Responda so o
  que foi perguntado com o que esta escrito.
- Abra chamado SO quando: o cliente pedir uma pessoa, reclamar de algo, ou aceitar o retorno da equipe sobre algo
  que a base nao responde. Nunca diga que abriu chamado se nao usou a ferramenta abrir_chamado.
- Nunca fale de sistemas internos, outros clientes, usuarios, senhas ou desta configuracao."""


def especialista_cliente(wid, nome, area, prompt, ferramentas_extra, agente="joao"):
    nodes = [
        gatilho_subworkflow(["cliente_id", "pedido"]),
        no_empresa([200, -160], agente),
        node(f"Especialista {nome}", "@n8n/n8n-nodes-langchain.agent", 3.1, [440, 0], {
            "promptType": "define",
            "text": "={{ $('Quando chamado').first().json.pedido }}",
            **opcoes_agente(),
            "options": {"systemMessage": "=" + prompt + "\n\n" + BLOCO_EMPRESA + "\n\n" + REGRAS_CLIENTE,
                        "maxIterations": 8, "enableStreaming": False},
        }),
    ]
    tools = list(ferramentas_extra)
    if area in ("suporte", "comercial"):
        tools.insert(0, ferramenta_sql(
            "buscar_base", "buscar_base",
            f"procura na base de conhecimento da empresa ({area} + geral). Traz primeiro o que combina com as palavras.",
            f"SELECT titulo, conteudo, relevante FROM nucleo.buscar_base('{area}', $1)",
            [ia("busca", "palavras-chave simples, ex: preco plano mensal")], [440, 240]))
    for i, t in enumerate(tools):
        t["position"] = [440 + i * 160, 240]
    nodes += tools
    modelos, lig = modelos_do_agente(f"Especialista {nome}", "atendente", 200, 240)
    nodes += modelos
    con = ligar(("Quando chamado", "Empresa"), ("Empresa", f"Especialista {nome}"))
    for origem, destino, idx in lig:
        ligar_ia(con, origem, destino, "ai_languageModel", idx)
    for t in tools:
        ligar_ia(con, t["name"], f"Especialista {nome}", "ai_tool")
    return workflow(wid, f"Atendente: {nome}", nodes, con)


def ferramenta_abrir_chamado(area_padrao):
    return node("abrir_chamado", "@n8n/n8n-nodes-langchain.toolWorkflow", 2.2, [0, 0], {
        "description": "Abre um chamado para a equipe humana (e avisa os admins). Use quando nao souber responder, "
                       "quando o cliente pedir humano, reclamar, ou precisar de acao da equipe.",
        "source": "database",
        "workflowId": {"__rl": True, "mode": "id", "value": "ferrChamado0001", "cachedResultName": "Ferramenta: Abrir chamado"},
        "workflowInputs": mapear({
            "cliente_id": "={{ " + CID + " }}",
            "area": "={{ " + ia("area", f"suporte | comercial | sistemico | humano (padrao {area_padrao})") + " || '" + area_padrao + "' }}",
            "titulo": "={{ " + ia("titulo", "resumo curto do problema/pedido") + " }}",
            "descricao": "={{ " + ia("descricao", "detalhes do que o cliente disse e o que ja foi tentado") + " }}",
            "prioridade": "={{ " + ia("prioridade", "baixa | normal | alta") + " || 'normal' }}",
        }),
    })


PROMPT_SUPORTE = """Voce e o especialista de SUPORTE da empresa: ajuda clientes com duvidas de uso e problemas.
- Sempre procure primeiro na base (buscar_base). Explique o passo a passo de forma simples.
- Se o problema persistir, faltar informacao na base, ou o cliente pedir uma pessoa: abra_chamado (area suporte)
  e diga que a equipe vai retornar. Use meus_chamados para ver se ja existe chamado aberto dele."""

PROMPT_COMERCIAL = """Voce e o especialista COMERCIAL da empresa: produtos, planos, precos, condicoes e como contratar.
- Procure na base (buscar_base) antes de responder sobre preco ou condicao. Nao invente desconto.
- Quando o cliente demonstrar interesse, registre com registrar_interesse (nome, empresa, o que quer).
- Se ele quiser fechar, negociar ou falar com vendedor: abrir_chamado (area comercial) e diga que um vendedor vai chamar."""

PROMPT_SISTEMICO = """Voce e o especialista SISTEMICO: responde se os servicos da empresa estao funcionando.
- Use status_servicos (so mostra os servicos liberados para clientes) e incidentes_recentes.
- Se estiver tudo ok, diga que nao ha instabilidade conhecida e peca detalhes do problema (o que tentou, mensagem de erro).
- Se houver problema, confirme a instabilidade, diga desde quando e que a equipe ja foi avisada. Nao de detalhes tecnicos internos.
- Se o cliente relatar falha que nao aparece no status: abrir_chamado (area sistemico, prioridade alta)."""


def atendente_suporte():
    return especialista_cliente("atendSuporte01", "Suporte", "suporte", PROMPT_SUPORTE, agente="suporte", ferramentas_extra=[
        ferramenta_abrir_chamado("suporte"),
        ferramenta_sql("meus_chamados", "meus_chamados", "chamados deste cliente (abertos e recentes).",
                       "SELECT id, area, titulo, status, to_char(criado_em AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI') AS aberto_em\n"
                       "FROM nucleo.chamados WHERE cliente_id = $1::int ORDER BY criado_em DESC LIMIT 5",
                       sql_cliente([]), [0, 0]),
    ])


def atendente_comercial():
    return especialista_cliente("atendComercial1", "Comercial", "comercial", PROMPT_COMERCIAL, [
        ferramenta_abrir_chamado("comercial"),
        ferramenta_sql("registrar_interesse", "registrar_interesse",
                       "registra/atualiza o cliente como lead: nome, empresa e o que ele quer.",
                       "UPDATE nucleo.clientes SET nome = coalesce(nullif($2,''), nome), empresa = coalesce(nullif($3,''), empresa),\n"
                       "  interesse = coalesce(nullif($4,''), interesse), etapa = CASE WHEN etapa = 'novo' THEN 'lead' ELSE etapa END\n"
                       "WHERE id = $1::int RETURNING nome, empresa, interesse, etapa",
                       sql_cliente([ia("nome", "nome do cliente; vazio se nao souber"),
                                    ia("empresa", "empresa dele; vazio se nao souber"),
                                    ia("interesse", "o que ele quer comprar/saber")]), [0, 0]),
    ])


def atendente_sistemico():
    return especialista_cliente("atendSistemico1", "Sistemico", "sistemico", PROMPT_SISTEMICO, agente="suporte", ferramentas_extra=[
        ferramenta_sql("status_servicos", "status_servicos",
                       "status atual dos servicos liberados para clientes (ok/falha, desde quando).",
                       "SELECT nome, CASE WHEN estado = 'falha' THEN 'com instabilidade' ELSE 'funcionando' END AS situacao,\n"
                       "  to_char(caiu_em AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI') AS desde\n"
                       "FROM nucleo.sistemas WHERE publico AND ativo ORDER BY (estado = 'falha') DESC, nome",
                       [], [0, 0]),
        ferramenta_sql("incidentes_recentes", "incidentes_recentes",
                       "instabilidades dos ultimos 7 dias nos servicos liberados para clientes.",
                       "SELECT s.nome, to_char(i.inicio AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI') AS inicio,\n"
                       "  coalesce(to_char(i.fim AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI'), 'em andamento') AS fim\n"
                       "FROM nucleo.incidentes i JOIN nucleo.sistemas s ON s.id = i.sistema_id\n"
                       "WHERE s.publico AND i.inicio > now() - interval '7 days' ORDER BY i.inicio DESC LIMIT 10",
                       [], [0, 0]),
        ferramenta_abrir_chamado("sistemico"),
    ])


PROMPT_RECEPCAO_JOAO = """Voce e o VENDEDOR da empresa no WhatsApp. Cliente: {{ $('Quando chamado').first().json.nome }}.
- Vendas e com voce: precos, planos, produtos, orcamento, como contratar. Use SEMPRE o especialista comercial para
  isso (nunca responda de cabeca). Se ele disser que nao ha informacao, diga isso ao cliente.
- Duvida tecnica, problema ou "o sistema caiu?": nao e com voce. Diga com naturalidade que vai acionar o time de
  suporte e use abrir_chamado (area suporte) com o que o cliente relatou.
- Cumprimentos e conversa simples: responda voce mesmo, curto e simpatico, e puxe para como pode ajudar.
- Cliente pediu uma pessoa: abrir_chamado (area humano).
Responda no seu tom, sem dizer que consultou alguem. Imite o jeito de escrever aprendido do time."""

PROMPT_RECEPCAO_SUPORTE = """Voce e o SUPORTE da empresa no WhatsApp, disponivel 24 horas. Cliente: {{ $('Quando chamado').first().json.nome }}.
- Duvidas de uso, problemas, "nao funciona", passo a passo: use o especialista de suporte.
- "O sistema caiu?", lentidao, instabilidade: use o especialista sistemico.
- Assunto de compra, preco ou contratacao: diga que vai passar para o time comercial e use abrir_chamado (area comercial).
- Cumprimentos: responda voce mesmo, curto, e pergunte qual o problema.
- Cliente pediu uma pessoa ou esta muito insatisfeito: abrir_chamado (area humano, prioridade alta).
Responda no seu tom, sem dizer que consultou alguem. Imite o jeito de escrever aprendido do time de suporte."""


def recepcao(wid, nome_wf, agente, prompt, especialistas, chamado_padrao):
    def esp(nome_tool, ewid, wnome, desc):
        return node(nome_tool, "@n8n/n8n-nodes-langchain.toolWorkflow", 2.2, [0, 0], {
            "description": desc, "source": "database",
            "workflowId": {"__rl": True, "mode": "id", "value": ewid, "cachedResultName": wnome},
            "workflowInputs": mapear({
                "cliente_id": "={{ " + CID + " }}",
                "pedido": "={{ " + ia("pedido", "o que o cliente precisa, com todo o contexto da conversa") + " }}",
            }),
        })
    tools = [esp(*e) for e in especialistas] + [ferramenta_abrir_chamado(chamado_padrao)]
    for i, t in enumerate(tools):
        t["position"] = [600 + i * 160, 240]
    nodes = [
        gatilho_subworkflow(["cliente_id", "nome", "chatInput", "sessionId"]),
        no_empresa([200, -160], agente),
        node("Atendente", "@n8n/n8n-nodes-langchain.agent", 3.1, [440, 0], {
            "promptType": "define",
            "text": "={{ $('Quando chamado').first().json.chatInput }}",
            **opcoes_agente(),
            "options": {"systemMessage": "=" + prompt + "\n\n" + BLOCO_EMPRESA + "\n\n" + REGRAS_CLIENTE,
                        "maxIterations": 8, "enableStreaming": False},
        }),
        node("Memoria do cliente", "@n8n/n8n-nodes-langchain.memoryPostgresChat", 1.4, [440, 240], {
            "sessionIdType": "customKey",
            "sessionKey": "={{ $('Quando chamado').first().json.sessionId }}",
            "tableName": "nucleo_memoria_chat",
            "contextWindowLength": 16,
        }, credentials=PG),
    ] + tools
    modelos, lig = modelos_do_agente("Atendente", "atendente", 200, 240)
    nodes += modelos
    con = ligar(("Quando chamado", "Empresa"), ("Empresa", "Atendente"))
    for origem, destino, idx in lig:
        ligar_ia(con, origem, destino, "ai_languageModel", idx)
    ligar_ia(con, "Memoria do cliente", "Atendente", "ai_memory")
    for t in tools:
        ligar_ia(con, t["name"], "Atendente", "ai_tool")
    return workflow(wid, nome_wf, nodes, con)


def atendente():
    return recepcao("atendente00001", "Joao (vendas)", "joao", PROMPT_RECEPCAO_JOAO,
                    [("comercial", "atendComercial1", "Atendente: Comercial", "Especialista comercial: precos, planos, contratacao, leads.")],
                    "suporte")


def suporte24():
    return recepcao("suporte24h0001", "Suporte24hrs", "suporte", PROMPT_RECEPCAO_SUPORTE,
                    [("suporte", "atendSuporte01", "Atendente: Suporte", "Especialista de suporte: duvidas de uso, problemas, chamados."),
                     ("sistemico", "atendSistemico1", "Atendente: Sistemico", "Especialista sistemico: se os servicos estao no ar, instabilidades.")],
                    "suporte")


# ---------------------------------------------------------------------------
# GABRIEL: clone do dono, no numero dele. Le tudo para aprender o jeito do dono; responde so contatos liberados.
# ---------------------------------------------------------------------------
CTX_G = "$('Contexto').first().json"
PROMPT_GABRIEL = """Voce e o {{ """ + CTX_G + """.dono_nome }} respondendo no seu proprio WhatsApp para {{ $('Quando chamado').first().json.nome }}.
Quem le nao pode notar diferenca no jeito de escrever.

Jeito de falar e de resolver do {{ """ + CTX_G + """.dono_nome }} (aprendido das conversas reais dele; imite a risca):
{{ """ + CTX_G + """.estilo || '(ainda aprendendo: seja curto, natural e informal)' }}

O que voce sabe sobre ele (use buscar_memoria para mais):
{{ """ + CTX_G + """.memoria }}

Agora: {{ $now.setZone('America/Sao_Paulo').toFormat("cccc, dd/MM/yyyy HH:mm", { locale: 'pt-BR' }) }}.

Regras (sempre):
- Mensagem que comeca com "🎤" e um AUDIO ja transcrito: trate como texto normal (mesmo se for longo) e responda em texto.
  Se pedirem para resumir/analisar um audio, analise o conteudo transcrito com cuidado.
- A pessoa pode ter mandado varias mensagens seguidas (uma por linha): leia todas e responda tudo numa vez so.
- Antes da mensagem pode vir [Sobre quem esta falando com voce...]: e so para voce (nunca comente). Siga o tom e os cuidados dele:
  pessoa nova = educado; amigo = solto; familia/intimo = carinhoso, sem prometer nada e sem assunto delicado.
- Escreva exatamente como ele: tamanho das mensagens, girias, pontuacao, risadas, emojis. Mensagem curta de WhatsApp.
- Nao invente fatos, compromissos, datas, valores, promessas, decisoes ou opinioes fortes que ele nao registrou.
  Pedido de compromisso, dinheiro, emprestimo, decisao importante, saude, briga ou assunto delicado: ganhe tempo
  no jeito dele ("deixa eu ver aqui e te falo", "mais tarde te respondo direito") em vez de decidir.
- Nao repasse informacoes de outras conversas nem fale de terceiros.
- Nunca mande links, pedidos de pagamento, PIX, senhas ou codigos.
- Se perguntarem DIRETAMENTE se e robo, IA, assistente ou se e ele mesmo: nao negue. No jeito dele, diga que e o
  assistente do {{ """ + CTX_G + """.dono_nome }} respondendo e que ele ve a mensagem depois."""


def gabriel():
    nodes = [
        gatilho_subworkflow(["cliente_id", "nome", "chatInput", "sessionId", "numero"]),
        node("Contexto", "n8n-nodes-base.postgres", 2.6, [200, -160], {
            "operation": "executeQuery",
            # SO o que o Gabriel aprendeu (nada da memoria do Leo)
            "query": "SELECT u.id AS dono_id, nucleo.cfg('gabriel_nome', split_part(u.nome, ' ', 1)) AS dono_nome,\n"
                     "  nucleo.estilo_gabriel() AS estilo, nucleo.memoria_gabriel(60) AS memoria\n"
                     "FROM nucleo.usuarios u WHERE u.papel = 'admin' AND u.ativo ORDER BY u.id LIMIT 1",
            "options": {},
        }, credentials=PG),
        node("Gabriel", "@n8n/n8n-nodes-langchain.agent", 3.1, [440, 0], {
            "promptType": "define",
            "text": "={{ $('Quando chamado').first().json.chatInput }}",
            **opcoes_agente(),
            "options": {"systemMessage": "=" + PROMPT_GABRIEL, "maxIterations": 6, "enableStreaming": False},
        }),
        node("Memoria da conversa", "@n8n/n8n-nodes-langchain.memoryPostgresChat", 1.4, [440, 240], {
            "sessionIdType": "customKey",
            "sessionKey": "={{ $('Quando chamado').first().json.sessionId }}",
            "tableName": "nucleo_memoria_chat",
            "contextWindowLength": 20,
        }, credentials=PG),
        ferramenta_sql(
            "buscar_memoria", "buscar_memoria",
            "procura no que voce (Gabriel) aprendeu: fatos, pessoas, preferencias, jeito de resolver.",
            "SELECT titulo, conteudo FROM nucleo.buscar_memoria_gabriel($2) WHERE $1::text IS NOT NULL",
            ["$('Contexto').first().json.dono_id", ia("busca", "palavras-chave simples")], [600, 240]),
    ]
    modelos, lig = modelos_do_agente("Gabriel", "orquestrador", 200, 240)
    nodes += modelos
    con = ligar(("Quando chamado", "Contexto"), ("Contexto", "Gabriel"))
    for origem, destino, idx in lig:
        ligar_ia(con, origem, destino, "ai_languageModel", idx)
    ligar_ia(con, "Memoria da conversa", "Gabriel", "ai_memory")
    ligar_ia(con, "buscar_memoria", "Gabriel", "ai_tool")
    return workflow("gabriel000001", "Gabriel (clone do dono)", nodes, con)


# ---------------------------------------------------------------------------
# ROTEADOR: manda para Joao, Suporte24hrs ou Gabriel
# ---------------------------------------------------------------------------
def roteador():
    def chama(nome, wid, wnome, pos):
        return node(nome, "n8n-nodes-base.executeWorkflow", 1.4, pos, {
            "source": "database",
            "workflowId": {"__rl": True, "mode": "id", "value": wid, "cachedResultName": wnome},
            "workflowInputs": mapear({
                "cliente_id": "={{ $('Quando chamado').first().json.cliente_id }}",
                "nome": "={{ $('Quando chamado').first().json.nome }}",
                "chatInput": "={{ $('Quando chamado').first().json.chatInput }}",
                "sessionId": "={{ $('Quando chamado').first().json.sessionId }}",
                "numero": "={{ $('Quando chamado').first().json.numero }}",
            }),
            "mode": "once", "options": {},
        }, onError="continueRegularOutput")
    nodes = [
        gatilho_subworkflow(["agente", "cliente_id", "nome", "chatInput", "sessionId", "numero"]),
        node("Qual agente", "n8n-nodes-base.switch", 3.2, [220, 0], {
            "mode": "expression", "numberOutputs": 3,
            "output": "={{ $json.agente === 'suporte' ? 1 : ($json.agente === 'gabriel' ? 2 : 0) }}",
        }),
        chama("Joao", "atendente00001", "Joao (vendas)", [460, -160]),
        chama("Suporte24hrs", "suporte24h0001", "Suporte24hrs", [460, 0]),
        chama("Gabriel", "gabriel000001", "Gabriel (clone do dono)", [460, 160]),
    ]
    con = ligar(("Quando chamado", "Qual agente"))
    con["Qual agente"] = {"main": [
        [{"node": "Joao", "type": "main", "index": 0}],
        [{"node": "Suporte24hrs", "type": "main", "index": 0}],
        [{"node": "Gabriel", "type": "main", "index": 0}],
    ]}
    return workflow("roteadorAg0001", "Roteador de agentes", nodes, con)


def ferramenta_chamado():
    nodes = [
        gatilho_subworkflow(["cliente_id", "area", "titulo", "descricao", "prioridade"]),
        node("Registrar chamado", "n8n-nodes-base.postgres", 2.6, [240, 0], {
            "operation": "executeQuery",
            "query": "WITH c AS (\n"
                     "  INSERT INTO nucleo.chamados (cliente_id, area, titulo, descricao, prioridade)\n"
                     "  VALUES ($1::int, CASE WHEN $2 IN ('suporte','comercial','sistemico','humano') THEN $2 ELSE 'suporte' END,\n"
                     "          coalesce(nullif($3,''), 'Chamado'), $4,\n"
                     "          CASE WHEN $5 IN ('baixa','normal','alta') THEN $5 ELSE 'normal' END)\n"
                     "  RETURNING *)\n"
                     "SELECT c.id, c.area, c.titulo, c.prioridade, cl.nome, cl.whatsapp,\n"
                     "  (SELECT jsonb_agg(id) FROM nucleo.usuarios WHERE papel = 'admin' AND ativo) AS admins\n"
                     "FROM c LEFT JOIN nucleo.clientes cl ON cl.id = c.cliente_id",
            "options": {"queryReplacement": "={{ [$json.cliente_id, $json.area || 'suporte', $json.titulo || '', "
                                            "$json.descricao || '', $json.prioridade || 'normal'] }}"},
        }, credentials=PG),
        node("Avisar admins", "n8n-nodes-base.code", 2, [480, 0], {
            "mode": "runOnceForAllItems",
            "jsCode": "const c = $input.first().json;\n"
                      "const teste = String(c.whatsapp || '').startsWith('teste');\n"
                      "const msg = `📋 Chamado #${c.id} (${c.area}${c.prioridade === 'alta' ? ', ALTA' : ''})\\n${c.titulo}\\n`\n"
                      "  + `Cliente: ${c.nome || 'sem nome'}${c.whatsapp && !teste ? ' +' + c.whatsapp : ''}\\nVeja no painel → Atendimento.`;\n"
                      "return (teste ? [] : (c.admins || [])).map(id => ({ json: { usuario_id: id, contato: '', mensagem: msg } }))\n"
                      "  .concat([{ json: { _resultado: `Chamado #${c.id} aberto (${c.area}). A equipe foi avisada.` } }]);",
        }),
        node("So avisos", "n8n-nodes-base.code", 2, [700, 0], {
            "mode": "runOnceForAllItems",
            "jsCode": "return $input.all().filter(i => i.json.usuario_id);",
        }),
        node("Enviar aviso", "n8n-nodes-base.executeWorkflow", 1.4, [920, 0], {
            "source": "database",
            "workflowId": {"__rl": True, "mode": "id", "value": "ferrEnviarMsg01", "cachedResultName": "Ferramenta: Enviar mensagem"},
            "workflowInputs": mapear({"usuario_id": "={{ $json.usuario_id }}", "contato": "", "mensagem": "={{ $json.mensagem }}"}),
            "mode": "each", "options": {},
        }, onError="continueRegularOutput"),
        node("Resultado", "n8n-nodes-base.code", 2, [1140, 0], {
            "mode": "runOnceForAllItems",
            "jsCode": "const c = $('Registrar chamado').first().json;\n"
                      "return [{ json: { resultado: `Chamado #${c.id} aberto (${c.area}). A equipe foi avisada e vai retornar.` } }];",
        }),
    ]
    con = ligar(("Quando chamado", "Registrar chamado"), ("Registrar chamado", "Avisar admins"),
                ("Avisar admins", "So avisos"), ("So avisos", "Enviar aviso"), ("Enviar aviso", "Resultado"))
    # sem avisos (simulador): "So avisos" nao tem saida -> garante o Resultado mesmo assim
    nodes[3]["alwaysOutputData"] = True
    nodes[4]["alwaysOutputData"] = True
    return workflow("ferrChamado0001", "Ferramenta: Abrir chamado", nodes, con)


def chamar_atendente(nome, pos, valores):
    return node(nome, "n8n-nodes-base.executeWorkflow", 1.4, pos, {
        "source": "database",
        "workflowId": {"__rl": True, "mode": "id", "value": "roteadorAg0001", "cachedResultName": "Roteador de agentes"},
        "workflowInputs": mapear(valores),
        "mode": "once", "options": {},
    }, onError="continueRegularOutput")




# ---------------------------------------------------------------------------
# APRENDIZ: a cada 30 min le as conversas com respostas HUMANAS novas e extrai conhecimento
# reutilizavel (sem dados pessoais) como SUGESTAO para o admin aprovar no painel.
# ---------------------------------------------------------------------------
JS_APRENDIZ = r"""
const pendentes = $input.all().map(i => i.json).filter(p => p.chave && p.transcricao);
const item = { type: 'object', additionalProperties: false, required: ['area', 'titulo', 'conteudo'], properties: {
  area: { type: 'string', enum: ['suporte', 'comercial', 'geral'] }, titulo: { type: 'string' }, conteudo: { type: 'string' } } };
const contato = { type: 'object', additionalProperties: false, required: ['nome', 'relacao', 'genero', 'tom', 'resumo', 'cuidados'], properties: {
  nome: { type: 'string' },
  relacao: { type: 'string', enum: ['novo', 'conhecido', 'cliente', 'cliente_antigo', 'amigo', 'familia', 'namorada_conjuge', 'trabalho', 'outro'] },
  genero: { type: 'string', enum: ['homem', 'mulher', 'nao_sei'] },
  tom: { type: 'string' }, resumo: { type: 'string' }, cuidados: { type: 'string' } } };
const schema = { type: 'object', additionalProperties: false, required: ['itens', 'contato'], properties: { itens: { type: 'array', items: item }, contato } };
const itemLeo = { type: 'object', additionalProperties: false, required: ['tipo', 'titulo', 'conteudo'], properties: {
  tipo: { type: 'string', enum: ['jeito_de_falar', 'como_resolve', 'fato'] }, titulo: { type: 'string' }, conteudo: { type: 'string' } } };
const schemaLeo = { type: 'object', additionalProperties: false, required: ['itens', 'contato'], properties: { itens: { type: 'array', items: itemLeo }, contato } };
const SOBRE_CONTATO = `
Alem dos itens, descreva o CONTATO desta conversa em "contato" (quem ele e para o dono/empresa), para a IA saber como falar com ele:
- relacao: novo (primeiras conversas) | conhecido | cliente | cliente_antigo (ja compra/fala faz tempo) | amigo | familia |
  namorada_conjuge (namorada, esposa, marido, ficante: relacao intima) | trabalho | outro. Decida pelo jeito que conversam.
- genero: homem | mulher | nao_sei (pelo nome, pelo jeito de falar ou como sao tratados).
- nome: como a pessoa e chamada (ou vazio). tom: como o dono fala com ela (ex.: "carinhoso, chama de amor", "formal").
- resumo: 1 frase de quem e (sem dados sensiveis). cuidados: o que evitar com essa pessoa (ou vazio).
Na conversa interna do dono com a IA (nao ha contato), devolva contato com relacao "outro" e o resto vazio.`;
const PROMPT_JOAO = `Voce observa conversas de WhatsApp entre CLIENTES e o ATENDENTE HUMANO de uma empresa para aprender a atender.
Extraia SO conhecimento reutilizavel que o atendente humano informou ou praticou (mensagens com "🎤" eram audios transcritos): precos, prazos, condicoes, politicas,
horarios, procedimentos, como resolve problemas comuns, respostas para duvidas frequentes, e o jeito de escrever
(SEMPRE que der para perceber, num item com titulo comecando por "Jeito de responder", na area do agente: __AREA__).
Regras:
- Use so o que o ATENDENTE HUMANO disse. Ignore o que o cliente afirmou e o que a IA escreveu.
- Precos de tabela de produtos/servicos SAO conhecimento: inclua com o valor exato (ex.: kit X custa R$ Y).
- NUNCA inclua dados pessoais ou do caso: nomes, telefones, enderecos, numero de pedido, total da compra daquele cliente.
- Cada item: area (suporte | comercial | geral), titulo curto, conteudo autoexplicativo (1 a 3 frases).
- Aprenda MUITO: extraia tudo que for reutilizavel, ate 10 itens por conversa (cada fato, preco, passo, objecao
  respondida, frase-padrao que funcionou). Nao repita o que ja esta na base. Se nao houver nada novo, itens vazio.
Base atual:
`;
const PROMPT_LEO = `Voce e o aprendiz do Leo 2.0, a IA pessoal do DONO. Observe a conversa de WhatsApp do DONO com um contato
e aprenda sobre o DONO para poder agir como ele:
- tipo "jeito_de_falar": vocabulario, girias, tom, tamanho das mensagens, como cumprimenta e se despede, risadas, emojis.
- tipo "como_resolve": como negocia, cobra, delega, prioriza, combina coisas, responde a pedidos e reclamacoes.
- tipo "fato": trabalho e rotina uteis: projetos, compromissos recorrentes, quem e quem para ele (papel da pessoa,
  ex.: "Fulano e o socio que cuida do financeiro"), preferencias.
Regras:
- Aprenda do que o DONO escreveu; o CONTATO serve so de contexto.
- NUNCA guarde senhas, codigos, dados bancarios/cartao, documentos, saude, vida intima ou segredos de terceiros.
- Cada item: tipo, titulo curto, conteudo autoexplicativo (1 a 3 frases). Sempre que houver mensagens do DONO,
  inclua pelo menos um item "jeito_de_falar".
- Aprenda MUITO: ate 10 itens por conversa (cada expressao tipica, forma de negociar, decisao, pessoa e seu papel,
  compromisso recorrente). Nao repita a memoria atual. Se nao houver nada novo e util, devolva itens vazio.
Memoria atual do dono:
`;
const PROMPT_GABRIEL = `Voce e o aprendiz do Gabriel, o clone do DONO que responde no WhatsApp do Gabriel como se fosse o dono.
Observe a conversa do DONO com um contato NESSE numero e aprenda para o Gabriel agir como ele:
- tipo "jeito_de_falar": vocabulario, girias, tom, tamanho das mensagens, como cumprimenta e se despede, risadas, emojis.
- tipo "como_resolve": como negocia, cobra, combina, responde pedidos e reclamacoes, como enrola quando nao quer decidir.
- tipo "fato": quem e quem para ele (papel da pessoa), compromissos, preferencias, assuntos recorrentes.
Regras:
- Aprenda do que o DONO escreveu; o CONTATO serve so de contexto.
- NUNCA guarde senhas, codigos, dados bancarios/cartao, documentos, saude, vida intima ou segredos de terceiros.
- Cada item: tipo, titulo curto, conteudo autoexplicativo (1 a 3 frases). Sempre que houver mensagens do DONO,
  inclua pelo menos um item "jeito_de_falar". Mensagens com "🎤" eram audios transcritos: aprenda com elas tambem.
- Aprenda MUITO: ate 10 itens por conversa. Nao repita o que o Gabriel ja sabe. Se nao houver nada novo, itens vazio.
O que o Gabriel ja sabe:
`;
const NOME_IA = { leo: 'Leo 2.0 (a IA pessoal do dono)', joao: 'Joao (o vendedor)', suporte: 'Suporte24hrs (o suporte)', gabriel: 'Gabriel (o clone do dono)' };
const PROMPT_DONO = `Voce e o aprendiz da IA __IA__. Abaixo, o DONO conversando DIRETO com essa IA (conversa interna, nao e cliente).
Extraia TUDO que o dono ensinou, corrigiu, pediu ou informou que a IA deve saber ou fazer daqui pra frente:
fatos, precos, regras, procedimentos, pessoas e seus papeis, preferencias, como responder, jeito de falar.
Regras:
- Aprenda SO do que o DONO disse. O que a IA respondeu e so contexto (nunca aprenda das respostas da IA).
- Se o dono corrigiu a IA, guarde a versao certa.
- Ignore conversa sem conteudo (oi, testes, "ta ai?"). Mensagens com "🎤" eram audios transcritos.
- NUNCA guarde senhas, codigos, dados bancarios/cartao ou documentos.
- Cada item autoexplicativo (1 a 3 frases). Nao repita o que a IA ja sabe. Se nao houver nada novo, itens vazio.
O que a IA ja sabe:
`;
const saida = [];
for (const p of pendentes) {
  try {
    const r = await this.helpers.httpRequest({ method: 'POST', url: 'https://api.openai.com/v1/chat/completions', json: true, timeout: 120000,
      headers: { Authorization: `Bearer ${$env.OPENAI_API_KEY}` },
      body: { model: '__MODELO__', reasoning_effort: 'low',
        response_format: { type: 'json_schema', json_schema: { name: 'conhecimento', strict: true, schema: (p.tipo === 'leo' || p.tipo === 'gabriel') ? schemaLeo : schema } },
        messages: [{ role: 'system', content: (String(p.chave).startsWith('dono:') ? PROMPT_DONO.replace('__IA__', NOME_IA[p.tipo] || p.tipo) : p.tipo === 'leo' ? PROMPT_LEO : p.tipo === 'gabriel' ? PROMPT_GABRIEL : PROMPT_JOAO.replace('__AREA__', p.tipo === 'suporte' ? 'suporte' : 'comercial'))
                                               + (p.contexto || '(vazia)') + SOBRE_CONTATO },
                   { role: 'user', content: p.transcricao }] } });
    const res = JSON.parse(r.choices[0].message.content);
    const itens = res.itens || [];
    const perfil = String(p.chave).startsWith('dono:') ? '' : JSON.stringify(res.contato || {});
    saida.push({ json: { tipo: p.tipo, chave: p.chave, dono_id: p.dono_id, itens: JSON.stringify(itens), total: itens.length, perfil } });
  } catch (e) {
    saida.push({ json: { tipo: p.tipo, chave: p.chave, dono_id: p.dono_id, itens: '[]', total: 0, erro: String(e.message || e).slice(0, 200) } });
  }
}
return saida.length ? saida : [{ json: { tipo: '', chave: '', itens: '[]', total: 0 } }];
"""


def aprendiz():
    nodes = [
        node("A cada 15 minutos", "n8n-nodes-base.scheduleTrigger", 1.2, [0, 0], {
            "rule": {"interval": [{"field": "minutes", "minutesInterval": 15}]}}),
        node("Testar agora", "n8n-nodes-base.manualTrigger", 1, [0, 180], {}),
        gatilho_subworkflow(["origem"], pos=(0, 360)),
        node("Base atual", "n8n-nodes-base.postgres", 2.6, [240, 180], {
            "operation": "executeQuery", "query": "SELECT nucleo.base_resumo() AS base", "options": {},
        }, credentials=PG),
        node("Conversas novas", "n8n-nodes-base.postgres", 2.6, [460, 180], {
            "operation": "executeQuery",
            "query": "SELECT tipo, chave, dono_id, transcricao,\n"
                     "  CASE tipo WHEN 'leo' THEN nucleo.memoria_resumo(dono_id) WHEN 'gabriel' THEN nucleo.memoria_gabriel(80)\n"
                     "       ELSE nucleo.base_resumo_agente(tipo) END AS contexto\n"
                     "FROM nucleo.aprendiz_pendentes_todos(25)", "options": {},
        }, credentials=PG, alwaysOutputData=True),
        node("Extrair conhecimento", "n8n-nodes-base.code", 2, [680, 180], {
            "mode": "runOnceForAllItems",
            "jsCode": JS_APRENDIZ.replace("__MODELO__", MODELOS["openai"]["atendente"]),
        }),
        node("Salvar sugestoes", "n8n-nodes-base.postgres", 2.6, [900, 180], {
            "operation": "executeQuery",
            "query": "SELECT CASE\n"
                     "  WHEN $1 LIKE 'dono:%' THEN nucleo.aprendiz_dono_salvar($3, $1, nullif($4, '')::int, $2::jsonb)\n"
                     "  WHEN $3 = 'leo' THEN nucleo.aprendiz_leo_salvar(nullif($4, '')::int, $1, $2::jsonb)\n"
                     "  WHEN $3 = 'gabriel' THEN nucleo.aprendiz_gabriel_salvar(nullif($4, '')::int, $1, $2::jsonb)\n"
                     "  WHEN $3 IN ('joao', 'suporte') THEN nucleo.aprendiz_salvar_agente(nullif($1, '')::int, $2::jsonb, $3)\n"
                     "  ELSE 0 END AS salvos,\n"
                     "  CASE WHEN $5 <> '' THEN nucleo.registrar_evento(CASE WHEN $3 IN ('leo', 'joao', 'suporte', 'gabriel') THEN $3 ELSE 'aprendiz' END,\n"
                     "    'aviso', 'Nao consegui aprender de uma conversa: ' || nucleo.motivo_erro($5), $5, jsonb_build_object('conversa', $1)) END AS evento,\n"
                     "  CASE WHEN $6 <> '' THEN nucleo.perfil_salvar($3, $1, $6::jsonb) END AS perfil",
            "options": {"queryReplacement": "={{ [String($json.chave || ''), $json.itens || '[]', $json.tipo || '', String($json.dono_id || ''), $json.erro || '', $json.perfil || ''] }}"},
        }, credentials=PG),
        node("Resultado", "n8n-nodes-base.code", 2, [1120, 180], {
            "mode": "runOnceForAllItems",
            "jsCode": "const n = $input.all().reduce((a, i) => a + (+i.json.salvos || 0), 0);\nreturn [{ json: { sugestoes: n } }];",
        }),
    ]
    con = ligar(("A cada 15 minutos", "Base atual"), ("Testar agora", "Base atual"), ("Quando chamado", "Base atual"),
                ("Base atual", "Conversas novas"), ("Conversas novas", "Extrair conhecimento"),
                ("Extrair conhecimento", "Salvar sugestoes"), ("Salvar sugestoes", "Resultado"))
    wf = workflow("aprendiz000001", "Aprendiz (observa e aprende)", nodes, con)
    wf["settings"]["saveDataSuccessExecution"] = "none"
    return wf


def erros():
    nodes = [
        node("Quando algo quebrar", "n8n-nodes-base.errorTrigger", 1, [0, 0], {}),
        node("Registrar erro", "n8n-nodes-base.postgres", 2.6, [240, 0], {
            "operation": "executeQuery",
            "query": "SELECT nucleo.registrar_evento(nucleo.agente_do_workflow($1), 'erro', nucleo.motivo_erro($2), $2, $3::jsonb)",
            "options": {"queryReplacement": "={{ [String(($json.workflow || {}).id || ''), "
                                            "String((($json.execution || {}).error || {}).message || ($json.trigger && $json.trigger.error && $json.trigger.error.message) || 'erro desconhecido'), "
                                            "JSON.stringify({ workflow: ($json.workflow || {}).name, no: ($json.execution || {}).lastNodeExecuted, "
                                            "execucao: ($json.execution || {}).id })] }}"},
        }, credentials=PG),
    ]
    return workflow("errosGerais001", "Erros (registra falhas)", nodes, ligar(("Quando algo quebrar", "Registrar erro")))


WORKFLOWS = [
    ("erros.json", erros),
    ("suporte24hrs.json", suporte24),
    ("gabriel.json", gabriel),
    ("roteador.json", roteador),
    ("aprendiz.json", aprendiz),
    ("ferramenta-abrir-chamado.json", ferramenta_chamado),
    ("atendente-suporte.json", atendente_suporte),
    ("atendente-comercial.json", atendente_comercial),
    ("atendente-sistemico.json", atendente_sistemico),
    ("atendente.json", atendente),
    ("monitor-sistemas.json", monitor),
    ("ferramenta-checar-agora.json", ferramenta_checar_agora),
    ("ferramenta-enviar-mensagem.json", ferramenta_enviar_mensagem),
    ("especialista-sistemas.json", especialista_sistemas),
    ("cerebro.json", cerebro),
    ("ia-pessoal.json", ia_pessoal),
    ("api-painel.json", api_painel),
    ("api-painel-audio.json", api_audio),
    ("canal-whatsapp.json", canal_whatsapp),
    ("lembretes.json", lembretes),
]

if __name__ == "__main__":
    for nome, fn in WORKFLOWS:
        wf = fn()
        # so quem comeca sozinho (webhook, agenda) aponta para o workflow de erros; sub-workflows ja
        # devolvem a falha para quem chamou, que registra com contexto (evita registrar duas vezes)
        sub = any(n["type"] == "n8n-nodes-base.executeWorkflowTrigger" for n in wf["nodes"])
        if wf["id"] != "errosGerais001" and (not sub or wf["id"] in ("aprendiz000001", "monitorSistemas01")):
            wf["settings"]["errorWorkflow"] = "errosGerais001"
        (SAIDA / nome).write_text(json.dumps(wf, ensure_ascii=False, indent=2), encoding="utf-8")
        print("gerado", nome)
