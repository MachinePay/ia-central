# SelfMachine Agents

Atendimento multiagente no WhatsApp (Evolution API) e no Gmail: **Léo** (roteador), **João** (comercial),
**Clara** (suporte) e **assistente do Gabriel**. A arquitetura completa está em [docs/arquitetura.md](docs/arquitetura.md).

```
Evolution / Gmail ──► API (Fastify) ──► fila ingest ──► dedupe + filtros ──► mídia vira texto
                                                                    │
                     debounce 6 s por conversa ◄────────────────────┘
                                │
          lock por conversa ──► roteamento: regras ► continuidade ► Léo
                                │
                João / Clara / Gabriel (tools validadas no código) ──► verificador de saída
                                │                                         │
                   aprovação no WhatsApp do Gabriel ◄── ações sensíveis   ▼
                                                              rascunho ou envio (fila outbound)
```

| Peça | Onde |
|---|---|
| Webhooks, `/health`, filas (`/admin/queues`) | `src/api` |
| Filas: ingest, media, respond, summarize, outbound, maintenance | `src/workers` |
| Roteamento (3 níveis) | `src/routing/route.ts` |
| Prompts versionados | `src/agents/prompts/*.md` |
| Tools (descontos, chamados, aprovações...) | `src/tools/index.ts` |
| Verificador de saída e mascaramento | `src/guardrails` |
| Memória (contexto, resumo, base de conhecimento) | `src/memory` |
| Schema do banco (schema `app`) | `db/migrations` |

Mudanças em relação ao documento: SQL direto com `pg` em vez de Prisma (mesmo schema), e o número
pessoal do Gabriel pode ser uma instância própria (papel `GABRIEL`) em que os bots só respondem contatos com a tag `BOT`.

## Rodar local

```bash
cp .env.example .env          # preencha (ou reaproveite o .env.legado)
docker compose up -d postgres redis evolution
npm install
npm run db:migrate            # cria o schema "app"
npm run migrar:legado         # traz o que o sistema antigo aprendeu
npm run dev:api               # http://localhost:3000/health
npm run dev:worker
```

## Comandos no WhatsApp (no chat do cliente, pelo celular)

| Comando | Efeito |
|---|---|
| qualquer mensagem sua | bots em silêncio nessa conversa por 2 h |
| `/bot on` | devolve aos agentes |
| `/bot off` | silencia até novo `/bot on` |
| `/bot joao` · `/bot clara` · `/bot gabriel` | devolve e escolhe o agente |

Aprovações chegam no seu WhatsApp como `[Aprovação #A-0001]`: responda **citando a mensagem** com `1` (aprovar),
`2` (recusar) ou o texto que deve ir para o cliente.

## Papel de cada número (`WA_INSTANCES`)

| Papel | O que faz |
|---|---|
| `ATENDIMENTO` | o Léo roteia e João/Clara/Gabriel respondem (rascunho ou envio, conforme `SEND_MODE`) |
| `OBSERVAR` | só aprendendo: guarda as conversas e o aprendiz estuda as respostas da equipe a cada 30 min; nunca responde |
| `GABRIEL` | seu número pessoal: só fala com contatos liberados (tag `BOT`); a conversa "Você" recebe rascunhos e aprovações |
| `OFF` | ignorado |

O que o aprendiz guarda vai para `app.knowledge_chunks` com origem `aprendido:equipe` (sem dados de cliente nem preços).

## Modo sombra → envio automático

`SEND_MODE=draft` (padrão): nada vai para o cliente. No WhatsApp o rascunho fica no banco (e chega para você se
`SHADOW_NOTIFY=true`); no Gmail vira rascunho na própria thread. Quando estiver bom, libere por agente com
`AUTO_SEND_AGENTS=CLARA` ou `JOAO:WHATSAPP`, ou tudo com `SEND_MODE=auto`.

## Render

Veja [docs/implantar.md](docs/implantar.md).
