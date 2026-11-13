# IA Central

Várias IAs especialistas sobre um núcleo único (memória, lembretes, contatos e monitoramento),
com um painel futurista em React, conversa por voz e **vários usuários, cada um com a própria IA**.

```
 Painel React (PC / celular)        Chat do n8n        WhatsApp (Evolution API, QR code)
        │  /webhook/painel  /webhook/painel-audio            │
        ▼                                                    ▼
 API do Painel ──► regras no banco (login, quem vê o quê) ──► CÉREBRO da IA (1 por usuário)
                                                                 │ ferramentas
                         ┌───────────────────┬───────────────────┼───────────────┐
                 Especialista: Sistemas   Enviar mensagem   Memória/Lembretes   Contatos
                         │
                 Monitor (sem IA, 1 min): sites + Render + Vercel ──► alertas WhatsApp/Telegram
 NÚCLEO: Postgres 17 + pgvector (schema nucleo)
```

## Estrutura

| Caminho | O que é |
|---|---|
| `docker-compose.yml` | n8n 2.47.5 + Postgres 17 com pgvector + Evolution API 2.3.7 (WhatsApp) |
| `db/init/01-nucleo.sql` | sistemas, incidentes, alertas, contatos, memória, conversas |
| `db/init/02-ia-pessoal.sql` | lembretes, busca na memória sem acento |
| `db/init/03-usuarios.sql` | **usuários, login, regras de privacidade e a API do painel (`nucleo.api`)** |
| `db/init/05-plataformas.sql` | monitor v2: Render/Vercel, tempo de resposta, avisos para admins |
| `db/init/04-whatsapp.sql` | número do WhatsApp → usuário (com/sem o 9), registro das conversas |
| `scripts/montar_workflows.py` | gera todos os workflows (prompts, ferramentas, modelos ficam aqui) |
| `scripts/implantar.sh` | gera + importa + publica no n8n |
| `scripts/testar_api.py` | teste de ponta a ponta: vários usuários, isolamento de memória, voz |
| `scripts/testar_conversa.py` | conversa com a IA pela linha de comando |
| `scripts/testar_whatsapp.py` | simula a Evolution mandando texto/áudio, testa segurança e status |
| `scripts/ver-execucao.sh` | mostra o que aconteceu na última execução de um workflow |
| `painel/` | painel React (Vite + TypeScript), instalável no celular |

Workflows gerados em `workflows/`:

| Workflow | Id | Função |
|---|---|---|
| Monitor de Sistemas | `monitorSistemas01` | a cada 1 min: Render, Vercel e sites (com tempo), avisa quando cai/volta |
| Ferramenta: Checar agora | `ferrChecarAgora1` | testa qualquer URL na hora (status, tempo, título) |
| Cerebro IA (por usuário) | `iaCerebro00001` | a IA: recebe quem está falando e usa as ferramentas daquela pessoa |
| Especialista: Sistemas | `espSistemas01` | status, quedas; cadastrar/pausar só admin |
| Ferramenta: Enviar mensagem | `ferrEnviarMsg01` | Telegram para a própria pessoa ou um contato |
| API do Painel | `apiPainel00001` | `POST /webhook/painel` — login, resumo, chat, voz (TTS), admin |
| API do Painel (áudio) | `apiPainelAudio1` | `POST /webhook/painel-audio` — áudio → texto → IA |
| Canal WhatsApp | `canalWhatsapp01` | `POST /webhook/whatsapp` — mensagem/áudio no WhatsApp → IA da pessoa → resposta |
| IA Pessoal (chat n8n) | `iaPessoal00001` | chat dentro do n8n, falando como o admin |
| Lembretes | `lembretes00001` | envia os lembretes na hora |

## Subir do zero

```bash
cp .env.example .env          # preencha senhas, OPENAI_API_KEY, ADMIN_SENHA...
docker compose up -d
sh scripts/implantar.sh       # banco + admin + credenciais + todos os workflows (alguns minutos)
cd painel && npm install && npm run dev
```

Painel: **http://localhost:5173** (entre com `ADMIN_LOGIN` / `ADMIN_SENHA` do `.env`).
n8n: http://localhost:5678.

Mudou prompt, ferramenta ou modelo? Edite `scripts/montar_workflows.py` e publique só o que mudou:
```bash
sh scripts/implantar.sh cerebro especialista-sistemas
```
(No Git Bash os scripts já usam `MSYS_NO_PATHCONV=1`.)

## Usuários e privacidade

Cada usuário tem a **própria IA**: memória, lembretes, contatos e histórico de conversa separados.
As regras ficam no banco (`nucleo.pode_ver_memoria`), não no prompt — a IA não consegue "vazar"
a memória de alguém mesmo se for convencida a tentar.

| | Vê as próprias | Vê as dos outros |
|---|---|---|
| Usuário, memória compartilhada **desligada** | sim | não |
| Usuário, memória compartilhada **ligada** e participando | sim | de quem também participa |
| Usuário que **saiu** (não participa) | sim | não — e ninguém vê as dele |
| **Admin** pedindo "ideias de todo mundo" | sim | **todas**, sempre (mesmo se ele não participar) |

- Só o admin liga/desliga a **memória compartilhada** e cria/desativa usuários (painel → Privacidade/Usuários).
- Cada pessoa (inclusive o admin) decide se **participa**; o admin pode ficar de fora e ainda consultar todos.
- Ao usar memória de outras pessoas, a IA diz de quem veio cada ideia.
- Só o admin cadastra ou pausa sistemas monitorados; todos podem ver o status.
- Senhas com bcrypt (`pgcrypto`), sessão por token de 30 dias, login errado demora de propósito.

## WhatsApp

Um número de WhatsApp vira o "número da IA". Cada usuário cadastra o próprio celular no painel
(Privacidade → Meu WhatsApp) e passa a conversar com **a própria IA** mandando mensagem para esse número.

1. Painel (admin) → cartão **WhatsApp** → **Conectar com QR code**.
2. No celular do número da IA: WhatsApp → Aparelhos conectados → Conectar aparelho → leia o QR.
   (Painel aberto no próprio celular? Digite o número e use o botão de celular: gera um código
   de pareamento para "Conectar com número de telefone".)
3. Cada pessoa cadastra o próprio número em "Meu WhatsApp" (o admin também, mesmo que seja o número conectado).

### Dois modos (cartão WhatsApp → interruptor)

| | **Pessoal** (padrão) — o número da IA é o seu celular | **Dedicado** — chip só da IA |
|---|---|---|
| Você fala com a IA | na conversa **"Você"** (mensagem para si mesmo) | mandando mensagem para o número da IA |
| Outros usuários cadastrados | só se começarem com **`/ia`** (ex.: `/ia quais minhas ideias?`) | direto, qualquer mensagem |
| Amigos, família, desconhecidos | ignorados e **nada é guardado** | ignorados, mas registrados para o admin |
| Suas conversas com outras pessoas | ignoradas | — |

- Toda resposta da IA começa com 🤖 — assim ela nunca responde a si mesma na conversa "Você".
- A conexão é configurada para **não marcar mensagens como lidas**, não ficar "online" e ignorar grupos.

O que acontece:
- **Texto** → IA responde no estilo do WhatsApp (*negrito*, curto), com "digitando…".
- **Áudio** → transcrito, a IA responde **em áudio** (voz da OpenAI); se falhar, responde em texto.
- Lembretes e `enviar_mensagem` vão pelo WhatsApp quando a pessoa tem número (senão Telegram).
- **Números não cadastrados** são ignorados (no modo dedicado aparecem no cartão WhatsApp do admin).
  Grupos e status também são ignorados.
- Segurança: a Evolution manda um token secreto (`WHATSAPP_WEBHOOK_SEGREDO`) em cada evento;
  o que chegar sem ele é descartado — ninguém consegue se passar por outro número chamando o webhook.

> A Evolution API usa o WhatsApp Web (não oficial). Funciona bem, mas o WhatsApp pode banir números
> com uso abusivo (spam, muitas mensagens para quem não te conhece). No número pessoal o uso é leve
> (você falando consigo mesmo), mas o risco não é zero — se a IA for atender muita gente, passe para
> um chip dedicado. Para atendimento de clientes em escala, o caminho é a WhatsApp Cloud
> API oficial (Meta) — o workflow já separa leitura da mensagem e envio, dá para trocar a ponta.

## Atendente (clientes no WhatsApp)

```
Cliente ──► ATENDENTE (recepção) ──┬── Suporte    → base de conhecimento (suporte), chamados
                                   ├── Comercial  → base (comercial), registra lead, chama vendedor
                                   └── Sistêmico  → status dos serviços liberados para clientes
```

- Só atende de verdade com o WhatsApp no **modo dedicado** (chip só da IA). No modo pessoal os
  desconhecidos continuam ignorados. Para testar sem chip: painel → **Atendimento → Simular cliente**.
- **Modos:** *desligada* · **só observando** (padrão: lê as conversas e aprende, nunca responde) ·
  *com aprovação* (a IA sugere, você aprova/edita e só então vai para o cliente) · *automática*.
- **Para quem responde:** só os clientes **marcados** (interruptor "IA" em cada cliente) ou **todos**.
- **Lê conversas de:** só números **cadastrados como cliente** (padrão; família e amigos ficam de fora) ou todos.
- **Aprendiz** (a cada 30 min, ou "aprender agora"): lê as suas respostas aos clientes e extrai preços, prazos,
  políticas, procedimentos e o seu jeito de responder — sem nome/telefone/pedido do cliente. Vira **sugestão**:
  só entra na base depois que você aprova no painel.
- **Persona:** responde com o nome configurado (padrão **Leo 2.0**) e escreve como gente no WhatsApp, sem se
  anunciar como IA. Se o cliente perguntar diretamente se é robô, não mente: diz que é o assistente digital da
  equipe e oferece passar para uma pessoa (transparência com o consumidor e regras do WhatsApp).
- **Aprendizado:** cada resposta aprovada vira conhecimento da empresa ("aprendido" na base) e passa a ser
  usada nas próximas perguntas parecidas.
- **Regras fixas:** só afirma o que está na base (serviços, preços, prazos); se não souber, oferece abrir
  chamado. Chamado só quando o cliente pede uma pessoa, reclama ou aceita retorno — e os admins são avisados.
- Painel → Atendimento: modo, dados da empresa, fila para aprovar, base de conhecimento, chamados,
  clientes (leads) e quais serviços os clientes podem saber se estão fora.
- Testes: `python scripts/testar_atendente.py` e `python scripts/testar_observacao.py` (números que não existem no WhatsApp).

## Painel

- **Voz:** toque no botão rosa para falar e toque de novo para enviar — ou segure enquanto fala
  (walkie-talkie). O áudio é transcrito (`gpt-4o-mini-transcribe`) e a resposta pode ser falada
  (`gpt-4o-mini-tts`, botão de alto-falante). Se a voz da OpenAI falhar, usa a voz do aparelho.
- **Orbe:** muda de cor e pulsa com a sua voz (ouvindo), processando e com a voz da IA (falando).
- **Celular:** layout próprio com abas IA / Painel; pode ser instalado na tela inicial (PWA).

### Abrir no celular (mesma rede Wi-Fi)

O navegador do celular só libera o microfone em HTTPS:
```bash
cd painel && npm run dev:celular
```
Abra no celular o endereço `https://<ip-do-pc>:5173` que aparece no terminal, aceite o aviso de
certificado e use "Adicionar à tela inicial". Para uso fora de casa, publique (veja Render).

## Modelos: OpenAI + Claude

No topo de `scripts/montar_workflows.py`: `PRINCIPAL = "openai"` (gpt-5 / gpt-5-mini) e
`RESERVA = "anthropic"` (claude-sonnet-5-5 / claude-haiku-5-5). Se o principal falhar, o agente usa a
reserva. A reserva só é ligada se `ANTHROPIC_API_KEY` estiver no `.env`.

## Monitor de sistemas (Render, Vercel e qualquer site)

Roda **a cada 1 minuto** (workflow `Monitor de Sistemas`), sem IA nas regras:

- **Sites:** bate em todas as URLs em paralelo e mede o **tempo de resposta**. Falha = erro HTTP (≥ 400),
  sem resposta, DNS ou SSL quebrado, ou falta do `texto_esperado`. Mais de 8 s aparece como LENTO.
- **Render** (`RENDER_API_KEY`): lista os serviços da conta; avisa se um serviço for **suspenso** ou se o
  **último deploy falhar** (build/atualização). A URL de cada serviço entra sozinha no monitor de sites.
- **Vercel** (`VERCEL_TOKEN`, e `VERCEL_TEAM_ID` se for um time): avisa se o **último deploy de produção**
  der erro. O domínio de produção de cada projeto entra sozinho no monitor de sites.
- Se a chave da plataforma parar de funcionar, isso também vira um alerta ("acesso à conta").
- Só avisa depois de `falhas_para_alertar` falhas seguidas (sites: 2; deploys: 1) e só na mudança
  (caiu / voltou), dizendo quanto tempo ficou fora.
- **Quem recebe:** todos os **admins** (WhatsApp, na conversa "Você", ou Telegram) + contatos de `nucleo.escalonamento`.

Na conversa: *"monitora https://meusite.com"*, *"checa agora se o meusite.com está no ar"* (testa na hora,
mesmo sem cadastrar), *"como estão meus sistemas?"*, *"pausa o monitor do X"*. No painel, o botão
**agora** no cartão Sistemas roda tudo na hora.

> Serviços **free** do Render dormem depois de 15 min sem acesso; checando a cada minuto eles ficam
> acordados (consome as horas grátis do mês) e a primeira resposta depois de dormir pode passar do tempo limite.

### Chaves das plataformas (no `.env`, nunca no chat)

| Variável | Onde criar |
|---|---|
| `RENDER_API_KEY` | dashboard.render.com → Account Settings → API Keys |
| `VERCEL_TOKEN` | vercel.com → Account Settings → Tokens (escopo da conta ou do time) |
| `VERCEL_TEAM_ID` | só se os projetos estão num time: Settings do time → General → Team ID |

Depois: `docker compose up -d` (o n8n lê as variáveis novas) e, no painel, **agora**.

## Testes

```bash
python scripts/testar_api.py                       # isolamento entre usuários + voz, limpa no final
python scripts/testar_conversa.py "como estão os sistemas?"
sh scripts/ver-execucao.sh apiPainel00001 v        # depurar a última execução
```

## Render (produção)

- **Banco:** Render Postgres 17; rode os 3 arquivos de `db/init/` uma vez.
- **n8n:** Web Service com `n8nio/n8n:2.47.5`, mesmas variáveis do `.env`, `N8N_SECURE_COOKIE=true`,
  `WEBHOOK_URL=https://<n8n>.onrender.com/`. Plano pago (o free hiberna e o monitor para).
- **WhatsApp:** Evolution como outro Web Service (`evoapicloud/evolution-api:v2.3.7`) com disco
  persistente em `/evolution/instances`; no n8n, `EVOLUTION_URL` e `WHATSAPP_WEBHOOK_BASE` com os
  endereços internos do Render.
- **Painel:** Static Site com raiz `painel`, build `npm install && npm run build`, publicar `dist`,
  variável `VITE_API_URL=https://<n8n>.onrender.com`. Em HTTPS o microfone funciona no celular.
- Leve a mesma `N8N_ENCRYPTION_KEY` se for migrar credenciais.

## Próximas etapas

2. Telegram como canal de conversa (hoje só envia avisos).
3. Escalonamento de alertas (se ninguém reconhecer em X min, avisa o próximo).
4. Busca semântica (embeddings) na memória.
