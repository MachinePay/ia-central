# Implantar no Render (sem desconectar os WhatsApps)

O banco `ia-central-db` e a Evolution `ia-central-evolution` (com o disco das sessões) continuam os mesmos.
Os WhatsApps só passam a falar com o sistema novo no passo 4. Até lá, o n8n antigo segue atendendo.

## 1. Subir

1. Faça o merge desta branch na `main`. O Render lê o `render.yaml` (Blueprint → **Sync**) e cria
   `ia-central-redis`, `ia-central-api` e `ia-central-worker`.
2. O build do `ia-central-n8n` antigo vai falhar (os arquivos dele saíram do repositório). Isso é esperado:
   o Render mantém a versão que já está no ar até você suspendê-lo no passo 5.

## 2. Cadastrar no Render (grupo de variáveis `selfmachine-agents`)

| Variável | O que colocar |
|---|---|
| `OPENAI_API_KEY` | a mesma chave que o n8n usava |
| `ANTHROPIC_API_KEY` | opcional, para o modelo de reserva |
| `LLM_FALLBACK_MODEL` | opcional: `anthropic:claude-sonnet-5-5` (precisa da chave acima) |
| `WA_INSTANCES` | papel de cada instância da Evolution. Exemplo: `joao:ATENDIMENTO,suporte:ATENDIMENTO,gabriel:GABRIEL,nucleo:OFF`. Veja os nomes no passo 4 |
| `GABRIEL_PERSONAL_PHONE` | seu celular com DDI e DDD, só números (ex.: `5511999999999`): recebe aprovações e alertas |
| `APPROVAL_INSTANCE` | instância que manda as aprovações para você (uma de atendimento, ex.: `joao`) |
| `ADMIN_PASSWORD` | senha do painel de filas em `/admin/queues` (usuário `admin`) |
| `AUTO_SEND_AGENTS` | deixe vazio no começo (modo sombra) |
| `GMAIL_*` | opcional, ver seção 6 |

Nos dois serviços (`ia-central-api` e `ia-central-worker`): `PUBLIC_URL` = endereço da API
(ex.: `https://ia-central-api.onrender.com`).

`EVOLUTION_API_KEY` e `WHATSAPP_WEBHOOK_SEGREDO` já existem no grupo `ia-central-segredos`; não mexa.

## 3. Trazer o que a IA antiga aprendeu

No Render → `ia-central-api` → **Shell**:

```bash
node dist/src/scripts/migrar-legado.js
```

Ele copia empresas, base aprovada, perguntas sem resposta, clientes e perfis do schema antigo (`nucleo`, que
fica intacto) para o novo (`app`). Pode rodar de novo sem duplicar. Os embeddings são gerados sozinhos pelo worker.

## 4. Apontar os WhatsApps para o sistema novo

No Shell do `ia-central-api`:

```bash
node dist/src/scripts/religar-whatsapp.js           # só mostra as instâncias e o papel de cada uma
node dist/src/scripts/religar-whatsapp.js --apply   # aponta o webhook para a API nova
```

Nenhum QR code é necessário: só muda para onde a Evolution manda as mensagens.
Para voltar ao n8n, basta reativá-lo e reconectar o webhook pelo painel antigo.

## 5. Desligar o antigo

Render → `ia-central-n8n` → **Suspend**. Não apague o banco: o schema `nucleo` fica como histórico.

## 6. Gmail (opcional)

1. Google Cloud: ative Gmail API e Pub/Sub; crie o tópico `gmail-inbox` e dê permissão de publicação para
   `gmail-api-push@system.gserviceaccount.com`.
2. Assinatura **push** para `https://<api>/webhooks/gmail` com autenticação (service account); use o mesmo
   endereço como audience → `GMAIL_PUSH_AUDIENCE` e o e-mail da service account → `GMAIL_PUSH_SERVICE_ACCOUNT`.
3. OAuth com os escopos `gmail.modify` e `gmail.send` → `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`.
4. `GMAIL_ACCOUNT` = o endereço, `GMAIL_PUBSUB_TOPIC` = `projects/<projeto>/topics/gmail-inbox`.
   O worker liga o watch sozinho e renova todo dia.

## 7. Testar

1. `https://<api>/health` deve mostrar `db: ok`, `redis: ok` e `open` em cada WhatsApp.
2. De outro celular, mande mensagem para um número de atendimento. Com `SHADOW_NOTIFY=true` o rascunho chega
   no seu WhatsApp; nada vai para o cliente enquanto `SEND_MODE=draft`.
3. No seu número pessoal (papel `GABRIEL`), os bots só respondem contatos com a tag `BOT` (coluna `tags` de `app.contacts`).
4. Filas e erros: `https://<api>/admin/queues`. Execuções e custos: tabela `app.agent_runs`.
5. Quando os rascunhos estiverem bons: `AUTO_SEND_AGENTS=CLARA` (por exemplo) e, depois, `SEND_MODE=auto`.

## Base de conhecimento

A Clara só responde com o que estiver em `app.knowledge_chunks`, e o João usa a base para produtos quando a
empresa não tem catálogo. Depois da migração, revise as descrições das empresas em `app.companies`. As antigas
estavam marcadas com "REVISAR".
