# Sentinela — Monitoramento, Custos e Alertas da SelfMachine

Nov 23, 2026 · @Mateus Saavedra

## Visão geral

O Sentinela é um serviço que lê as APIs da Render e da Vercel, testa URLs cadastradas, acompanha os gastos e avisa pelo WhatsApp os números cadastrados quando algo sai do normal — com um diagnóstico feito por IA junto do alerta. Ele reaproveita a mesma base do sistema multiagente: Node.js, PostgreSQL, Redis, BullMQ e Evolution API.

### O que ele vigia

| Fonte | O que observa | Exemplo de alerta |
| --- | --- | --- |
| Render | Serviços, deploys, eventos, instâncias, métricas, logs | “Deploy da `api-totem` falhou há 2 min” |
| Vercel | Projetos, deploys, domínios, certificados | “Build do `site-selfmachine` em erro na branch main” |
| URLs externas | Disponibilidade, latência, SSL, conteúdo esperado, mudanças visuais | “`checkout.cliente.com` respondendo 502 há 3 checagens” |
| Custos | Plano e uso da Render/Vercel, gasto com LLMs, outros provedores | “Gasto com LLM do mês projetado 40% acima do orçamento” |
| Sistema próprio | Sessão da Evolution, watch do Gmail, filas, banco, crons | “Sessão do WhatsApp desconectada” |

### Objetivos

- Saber de um problema antes do cliente: alerta em até 2 minutos para serviços críticos.
- Nunca virar barulho: um incidente gera um alerta, com atualizações no mesmo fio, não dez mensagens.
- Cada alerta já vem com contexto: o que mudou, desde quando, provável causa e o que fazer.
- Visibilidade de custo diária, com projeção do fechamento do mês.

### Princípios

1. **Somente leitura por padrão.** As chaves usadas para monitorar não fazem deploy nem rollback; ações exigem comando explícito e aprovação.
2. **Fatos antes da IA.** Regras determinísticas disparam o alerta; a IA explica e sugere, mas não decide sozinha se há incidente.
3. **Alerta tem dono e fim.** Todo incidente fica aberto até ser reconhecido e resolvido, com histórico.
4. **Independência.** O Sentinela roda fora do serviço que ele vigia e tem um vigia externo para ele mesmo (seção Funcionalidades extras).

## Arquitetura

O Sentinela tem quatro partes: coletores que transformam tudo em observações, um motor de regras que decide quando há problema, um gerenciador de incidentes que avisa e escala, e a IA que explica cada incidente.

&#91;embedded content: arquitetura do Sentinela · das fontes ao aviso\]

A IA fica ao lado do fluxo, não no meio: se ela falhar, o alerta sai do mesmo jeito, só que sem diagnóstico. O painel lê o banco; o WhatsApp só recebe o que virou incidente ou resumo.

### Processos

| Processo | Função | Onde roda |
| --- | --- | --- |
| `api` | Webhooks da Vercel/Render, comandos do WhatsApp, painel e SSE | Mesmo servidor do sistema multiagente ou outro |
| `collector` | Polling das APIs e checagens HTTP leves | Worker BullMQ |
| `browser` | Playwright: navegador real, logins e jornadas | Worker separado, com mais memória |
| `engine` | Avalia regras, abre e resolve incidentes, agenda notificações | Worker BullMQ |
| `notifier` | Envia pela instância de alertas da Evolution, controla escalonamento | Worker BullMQ |

## Coletor Render

O coletor usa a API REST da Render (`https://api.render.com/v1`, autenticação `Bearer`) para listar serviços, acompanhar deploys e eventos e ler métricas; os nomes de endpoint abaixo são os conhecidos até meados de 2026 e devem ser conferidos na documentação atual antes de implementar.

### O que coletar

| Recurso | Endpoint (referência) | Frequência | Para quê |
| --- | --- | --- | --- |
| Serviços | `GET /services` | 10 min | Inventário, plano, região, status suspenso |
| Deploys | `GET /services/{id}/deploys` | 1 min (ou webhook) | Deploy falho, travado ou lento |
| Eventos | `GET /services/{id}/events` | 1 min | Crash, restart, OOM, falha de health check |
| Instâncias e escala | detalhes do serviço | 5 min | Quantidade de instâncias, autoscaling |
| Métricas | endpoints de métricas (CPU, memória, requisições HTTP, latência) | 1–5 min | Saturação, picos de erro 5xx |
| Logs | endpoint de logs com filtro por nível | sob demanda | Contexto para a IA no momento do incidente |
| Bancos e Redis gerenciados | `GET /postgres`, `GET /redis` (ou equivalentes) | 10 min | Status, plano, uso de disco |
| Cron jobs | execuções do job | a cada execução | Job que falhou ou não rodou |

Se a sua conta tiver webhooks da Render disponíveis, use-os para deploys e eventos e mantenha o polling só como reconciliação a cada 5 minutos.

### Verificação da própria chave

A cada 15 minutos, uma chamada leve (`GET /owners` ou `GET /services?limit=1`) confirma que a chave continua válida. Resposta `401` gera alerta crítico “chave da Render inválida ou revogada”; `429` reduz a frequência automaticamente.

### Normalização

Tudo vira um `Observation` genérico, o mesmo formato usado pela Vercel e pelo monitor de URLs:

```ts
type Observation = {
  source: 'RENDER' | 'VERCEL' | 'URL' | 'COST' | 'SELF';
  resourceId: string;        // srv-xxxx, prj_xxxx, monitor id
  resourceName: string;
  kind: string;              // deploy_status, event, metric, http_check...
  value: number | string | null;
  status: 'OK' | 'WARN' | 'FAIL';
  details: Record<string, unknown>;
  observedAt: string;
};
```

### Regras típicas da Render

| Regra | Severidade |
| --- | --- |
| Deploy com status de falha em serviço de produção | Crítica |
| Deploy em andamento há mais de 3× a duração média dos últimos 10 | Aviso |
| Mais de 3 restarts em 10 min | Crítica |
| Memória acima de 90% por 5 min | Aviso |
| Taxa de 5xx acima de 5% por 5 min | Crítica |
| Serviço suspenso | Crítica |
| Disco do Postgres gerenciado acima de 80% | Aviso |

## Coletor Vercel

Na Vercel, o melhor caminho é combinar webhooks de deploy (tempo real) com a API REST (`https://api.vercel.com`, `Bearer` + `teamId` quando houver time) para inventário, domínios e reconciliação. As versões dos endpoints mudam com frequência (`/v6`, `/v9`, `/v13`...), então confira a referência atual.

### O que coletar

| Recurso | Fonte | Frequência | Para quê |
| --- | --- | --- | --- |
| Projetos | `GET /projects` | 10 min | Inventário, framework, domínio de produção |
| Deploys | Webhooks `deployment.created`, `deployment.succeeded`, `deployment.error`, `deployment.canceled` + `GET /deployments` | tempo real + 5 min | Build falho, deploy de produção, quem fez e qual commit |
| Eventos do build | endpoint de eventos do deployment | sob demanda | Trecho do log de erro para a IA |
| Domínios | `GET /domains` e configuração por domínio | 1 h | Domínio mal configurado, DNS errado |
| Certificados | certificados por domínio | 6 h | Certificado perto de expirar ou com erro |
| Uso e gasto | Spend Management do time (alertas de limite, se disponível no plano) + painel de uso | diário | Projeção de custo |

### Webhook da Vercel

```ts
app.post('/webhooks/vercel', async (req, reply) => {
  const signature = req.headers['x-vercel-signature'];
  const expected = createHmac('sha1', env.VERCEL_WEBHOOK_SECRET)
    .update(req.rawBody).digest('hex');
  if (signature !== expected) return reply.code(401).send();

  await collectQueue.add('vercel-event', req.body, { jobId: `vc:${req.body.id}` });
  return reply.send({ ok: true });
});
```

A verificação usa o corpo bruto da requisição; configure o Fastify para preservá-lo nessa rota. Confira na documentação o algoritmo de assinatura vigente.

### Regras típicas da Vercel

| Regra | Severidade |
| --- | --- |
| `deployment.error` em produção | Crítica |
| `deployment.error` em preview da branch principal | Aviso |
| Produção sem deploy bem-sucedido após um deploy com falha por mais de 30 min | Crítica |
| Certificado expira em menos de 14 dias | Aviso; menos de 3 dias, crítica |
| Domínio com configuração inválida | Crítica |
| Alerta de gasto do time atingido | Aviso |
| Chave da Vercel retornando `401`/`403` | Crítica |

### Correlação com o monitor de URLs

Todo deploy de produção (Render ou Vercel) dispara uma checagem extra imediata nas URLs ligadas ao projeto. Se a URL piorar logo após o deploy, o alerta já diz: “piorou 2 min depois do deploy `a1b2c3` de Gabriel na branch main”.

## Monitor de URLs externas

Qualquer URL pode ser cadastrada — pelo painel ou pelo WhatsApp com `/monitor add` — e passa por checagens em camadas: as baratas a cada minuto, as de conteúdo e as de IA com menos frequência ou quando algo muda.

### Camadas de checagem

| Camada | O que verifica | Frequência padrão | Custo |
| --- | --- | --- | --- |
| 1. Disponibilidade | Status HTTP esperado, tempo de resposta, redirecionamentos | 1 min | Mínimo |
| 2. Segurança básica | Validade e emissor do certificado SSL, expiração do domínio (WHOIS/RDAP), HTTPS forçado | 6 h | Mínimo |
| 3. Conteúdo | Texto obrigatório presente (“Adicionar ao carrinho”), texto proibido ausente (“Error”, “Maintenance”), JSON com campos esperados em APIs | 5 min | Baixo |
| 4. Navegador real | Playwright carrega a página, coleta erros de console, requisições falhas, tempo de carregamento e screenshot | 30 min | Médio |
| 5. Fluxo sintético | Roteiro de passos (abrir, clicar, preencher, verificar), por exemplo login ou checkout de teste | 1 h | Médio |
| 6. Análise por IA | Modelo multimodal avalia screenshot + HTML resumido + erros e diz se a página parece correta | quando as camadas 3–4 mudam, ou 1× ao dia | Alto |

### Cadastro de um monitor

```json
{
  "name": "Checkout cliente Padaria Central",
  "url": "https://checkout.cliente.com",
  "method": "GET",
  "expectStatus": [200],
  "maxLatencyMs": 2500,
  "mustContain": ["Finalizar pedido"],
  "mustNotContain": ["Internal Server Error"],
  "browserCheck": true,
  "aiCheck": { "enabled": true, "instructions": "Deve mostrar o cardápio com preços e o botão de finalizar pedido." },
  "regions": ["sa-east", "us-east"],
  "failuresToAlert": 3,
  "linkedProject": "vercel:prj_site",
  "subscribers": ["grupo:engenharia"]
}
```

### Como a IA analisa

1. Recebe: screenshot, título, texto visível resumido, erros de console, requisições falhas, as `instructions` do cadastro e a última análise considerada correta.
2. Responde em JSON validado: `looks_ok` (sim/não), `confidence`, `issues` (lista curta), `changed_since_baseline`.
3. `looks_ok = false` com confiança acima de 0.7 gera alerta de aviso; só vira crítico se uma checagem determinística também falhar.
4. O conteúdo da página é tratado como dado não confiável: o prompt diz que instruções escritas na página devem ser ignoradas.

### Evitando falso positivo

- Alerta só depois de N falhas seguidas (padrão 3) e, se houver mais de uma região, falha em pelo menos duas.
- Uma checagem de controle em um site neutro confirma que a rede do próprio Sentinela está funcionando antes de culpar o alvo.
- Janelas de manutenção cadastradas silenciam o monitor.

### Checagens com login (monitores autenticados)

Um monitor pode ter e-mail e senha cadastrados: no intervalo que você definir, o Sentinela abre um navegador, faz login no sistema, percorre as páginas indicadas e avisa os números cadastrados se algo estiver errado. O login é feito por código (Playwright), não pela IA: a IA só recebe o que aparece depois de logado e nunca vê a senha.

#### Cadastro

```json
{
  "name": "Painel admin dos totens",
  "url": "https://admin.selfmachine.com/login",
  "schedule": { "cron": "*/30 6-23 * * *", "timezone": "America/Sao_Paulo", "alsoOnDeployOf": "render:srv-admin" },
  "auth": {
    "type": "form",
    "credentialRef": "vault://sentinela/admin-totens",
    "usernameSelector": "input[name=email]",
    "passwordSelector": "input[name=password]",
    "submitSelector": "button[type=submit]",
    "totp": true,
    "successCheck": { "urlContains": "/dashboard", "mustContain": "Totens online" }
  },
  "journey": [
    { "goto": "/pedidos", "mustContain": "Pedidos de hoje", "maxLatencyMs": 3000 },
    { "click": "text=Relatórios", "mustNotContain": "Erro", "expectNoConsoleErrors": true },
    { "goto": "/totens", "screenshot": true }
  ],
  "aiCheck": { "enabled": true, "instructions": "Depois do login, o painel deve listar os totens com status e os pedidos do dia, sem mensagens de erro." },
  "subscribers": ["grupo:engenharia"]
}
```

O JSON do monitor guarda só a referência `credentialRef`; e-mail, senha e segredo de 2FA ficam no cofre.

#### Opções de agendamento

| Opção | Exemplo | Quando usar |
| --- | --- | --- |
| Intervalo fixo | a cada 15, 30 ou 60 min | Sistemas críticos do dia a dia |
| Cron com janela | `*/30 6-23 * * *` | Só no horário em que o sistema é usado |
| Horários fixos | 07:00, 12:00 e 18:00 | Sistemas de terceiros ou de clientes, menos invasivo |
| Após deploy | `alsoOnDeployOf` | Validar cada publicação logo após o deploy |
| Sob demanda | `/check painel-admin` pelo WhatsApp | Quando alguém reclamar |

#### Como as credenciais são cadastradas e protegidas

- **Só pelo painel**, em formulário com HTTPS e 2FA. Senha nunca é enviada pelo WhatsApp, porque ficaria no histórico do chat; o comando `/monitor login <nome>` apenas devolve o link do formulário.
- **Cofre:** o formulário grava direto no cofre (ou criptografa com AES-256-GCM e chave mestra fora do banco). Depois de salva, a senha não é exibida de novo, só pode ser substituída.
- **Acesso restrito:** só o worker de navegador lê a credencial, em memória, no momento do login.
- **Nada vaza nos artefatos:** campos de senha mascarados nos screenshots (`mask` do Playwright), trace desligado durante a digitação, logs com redação.
- **Conta dedicada:** crie um usuário próprio para o Sentinela (por exemplo `monitor@selfmachine.com`), com o menor perfil que consiga ver as telas — de preferência somente leitura. Nunca use a sua conta pessoal: se a credencial vazar, o estrago fica limitado e a auditoria do sistema mostra claramente o que foi acesso do robô.

#### 2FA, captcha e bloqueio de conta

| Situação | Tratamento |
| --- | --- |
| 2FA por aplicativo (TOTP) | O segredo do TOTP fica no cofre e o código é gerado na hora (biblioteca `otplib`) |
| 2FA por SMS ou e-mail | Não automatizar; pedir ao sistema uma exceção para a conta de monitoramento (allowlist de IP) ou um token de API |
| Captcha | Não contornar; pedir allowlist do IP do Sentinela ou um endpoint de teste |
| Bloqueio por tentativas | Duas falhas seguidas de login param as tentativas e geram alerta, para não bloquear a conta |
| Sessão | Cookies (`storageState`) salvos criptografados e reaproveitados entre checagens; login completo pelo menos 1× ao dia para testar o próprio login |

#### Tipos de alerta

| Resultado | Severidade | Mensagem típica |
| --- | --- | --- |
| Credencial recusada (“senha inválida”) | Aviso | “Login do Painel admin recusado: a senha pode ter sido trocada ou expirada” |
| Tela de login fora do ar ou com erro | Crítica | “Painel admin não carrega a tela de login (502)” |
| Login ok, passo da jornada falhou | Crítica ou aviso, conforme o passo | “Página de pedidos sem o texto esperado após login” |
| Tudo ok, mas a IA estranhou | Aviso | “Painel carregou, mas a lista de totens está vazia, diferente do normal” |
| Lento | Aviso | “Pedidos levou 7,2 s para carregar (limite 3 s)” |

#### Sistemas de terceiros

Antes de automatizar login em sistema de outra empresa (ERP, gateway, painel de fornecedor), confira os termos de uso: muitos proíbem acesso automatizado. Quando o sistema tiver API ou página de status, prefira usar isso; quando for sistema de cliente, tenha a autorização por escrito.

#### Campos acrescentados ao schema

```prisma
model Monitor {
  // ...campos anteriores
  schedule        Json?     // cron, timezone, alsoOnDeployOf
  auth            Json?     // seletores e successCheck, sem segredos
  credentialRef   String?   // referência no cofre
  sessionStateRef String?   // cookies criptografados
  journey         Json?     // passos após o login
  lastLoginOkAt   DateTime?
  consecutiveLoginFailures Int @default(0)
}
```

### Cuidados com sites de terceiros

Monitore apenas sites seus, de clientes que autorizaram ou páginas públicas em frequência baixa, respeitando os termos de uso. Use um `User-Agent` identificável (`SelfMachine-Sentinela/1.0`). Credenciais de fluxos sintéticos ficam no cofre, em contas de teste.

## Custos e orçamento

Nem todo provedor expõe o gasto por API, então o Sentinela combina três fontes: gasto medido por nós mesmos (LLMs), gasto estimado a partir do inventário e da tabela de preços (Render, Vercel), e o valor real da fatura lançado ou importado no fechamento para corrigir a estimativa.

### Fontes de custo

| Provedor | Como obter | Precisão |
| --- | --- | --- |
| LLMs (OpenAI, Anthropic, Google) | Soma de `AgentRun.costUsd` do sistema multiagente + APIs de uso/custo dos provedores quando a conta permitir | Alta |
| Render | Inventário de serviços × tabela de preços por tipo de instância cadastrada (`PriceBook`), proporcional ao tempo ativo; banda e extras estimados | Média; corrigida pela fatura |
| Vercel | Plano + uso informado no painel/Spend Management; alertas de limite do próprio time | Média; corrigida pela fatura |
| Evolution, servidor, domínios, outros | Custos fixos cadastrados manualmente com recorrência | Alta |

A ausência de endpoint público de faturamento na Render e de um endpoint estável de custo na Vercel é a premissa deste desenho; se algum deles passar a existir, basta trocar o estimador pelo valor real.

### Cálculos diários

- **Gasto do mês até hoje** por provedor e por projeto.
- **Projeção de fechamento:** gasto até hoje + média dos últimos 7 dias × dias restantes.
- **Desvio:** comparação com o mesmo período do mês anterior e com o orçamento cadastrado.
- **Custo por cliente/conversa** (sistema multiagente): `AgentRun` agrupado por contato.

### Regras de alerta de custo

| Regra | Severidade |
| --- | --- |
| Projeção do mês acima de 100% do orçamento de um provedor | Aviso |
| Gasto real acima de 90% do orçamento | Crítica |
| Gasto de LLM do dia acima de 3× a média dos últimos 14 dias | Crítica (possível loop ou abuso) |
| Novo serviço pago criado na Render ou na Vercel | Informativo |
| Serviço sem tráfego há 30 dias e ainda pago | Informativo semanal (“você pode desligar”) |

### Exemplo de mensagem

```text
💰 Custos · 23/11
Mês até agora: US$ 182 (orçamento US$ 300)
Projeção de fechamento: US$ 251
• Render: US$ 74 · Vercel: US$ 20 · LLMs: US$ 61 · fixos: US$ 27
Maior alta: LLMs +38% vs. semana passada (Clara, suporte)
```

Os valores acima são ilustrativos.

## Motor de alertas

Observações passam por regras; uma regra violada abre ou atualiza um incidente; o incidente notifica os assinantes, espera reconhecimento e escala se ninguém responder. Um problema = um incidente = um fio de mensagens.

### Severidades

| Severidade | Quando | Canal | Horário silencioso |
| --- | --- | --- | --- |
| Crítica | Produção fora do ar, deploy de produção falho, chave inválida, gasto anormal | WhatsApp imediato + ligação opcional | Ignora |
| Aviso | Degradação, certificado perto de expirar, projeção de custo alta | WhatsApp | Segura até o fim do silêncio |
| Informativo | Novo serviço, deploy bem-sucedido, recursos ociosos | Resumo diário | Sempre no resumo |

### Regras como dados

```json
{
  "id": "render-5xx-rate",
  "source": "RENDER",
  "match": { "kind": "metric", "metric": "http_5xx_rate" },
  "condition": { "op": ">", "value": 0.05, "for": "5m" },
  "severity": "CRITICAL",
  "groupBy": ["resourceId"],
  "resolveWhen": { "op": "<", "value": 0.01, "for": "5m" },
  "subscribers": ["grupo:engenharia"],
  "runbook": "Ver últimos deploys; se correlacionado, considerar rollback."
}
```

Regras ficam no banco (editáveis pelo painel), com um conjunto padrão criado na instalação.

### Deduplicação e agrupamento

- **Chave do incidente** = `ruleId + groupBy` (por exemplo `render-5xx-rate:srv-abc`). Enquanto o incidente está aberto, novas violações só atualizam contadores.
- **Agrupamento por causa:** se várias URLs ligadas ao mesmo projeto caem junto com um deploy falho, vira um incidente com três sintomas, não quatro alertas.
- **Flapping:** um recurso que alterna OK/FAIL mais de 4 vezes em 30 min vira “instável” com uma única mensagem.
- **Resolução automática** quando `resolveWhen` se mantém; a mensagem de resolução informa a duração.

### Reconhecimento e escalonamento

1. O alerta chega aos assinantes de primeiro nível com um código curto (`#I-042`).
2. Responder `ok 42` (ou `/ack 42`) marca como reconhecido e para o escalonamento.
3. Sem reconhecimento em 10 min (crítico), o alerta vai ao segundo nível; em mais 10 min, ligação ou SMS ao responsável principal.
4. Enquanto aberto, uma atualização a cada 30 min só se algo mudou.

### Formato da mensagem

```text
🔴 CRÍTICO #I-042 · api-totem (Render)
Erros 5xx em 12% das requisições há 6 min
Começou 3 min após o deploy 9f2c1e (main, “ajusta timeout PDV”)
IA: logs mostram timeout na conexão com o Postgres a partir do deploy.
Sugestão: rollback para o deploy anterior.
Responda: ok 42 · detalhes 42 · rollback 42
```

Os dados do exemplo são ilustrativos.

## Contatos e assinaturas

Cada número cadastrado escolhe o que quer receber — por fonte, projeto e severidade — e só números cadastrados e verificados podem dar comandos ao Sentinela.

### Cadastro de um contato

| Campo | Exemplo | Uso |
| --- | --- | --- |
| Nome | Gabriel | Exibição e menções |
| Telefone (E.164) | 5511999999999 | Envio pela Evolution |
| E-mail | opcional | Resumos e fallback |
| Papel | `OWNER`, `ENGINEER`, `FINANCE`, `CLIENT_VIEWER` | Permissões de comando |
| Grupos | engenharia, financeiro, cliente-padaria | Assinaturas em lote |
| Horário silencioso | 22:00–07:00, fuso America/Sao\_Paulo | Segura avisos |
| Nível de escalonamento | 1 ou 2 | Ordem de chamada |
| Verificado em | data | Só ativos após confirmar código |

### Verificação do número

Ao cadastrar, o Sentinela envia um código de 6 dígitos para o número; o contato responde o código e só então passa a receber alertas. Isso evita mandar alertas a um número digitado errado e impede que alguém se cadastre por outra pessoa.

### Assinaturas

| Grupo | Recebe | Severidade mínima |
| --- | --- | --- |
| engenharia | Render, Vercel, URLs, sistema próprio | Aviso |
| financeiro | Custos | Aviso + resumo semanal |
| owner | Tudo | Crítica imediata; demais no resumo diário |
| cliente-x | Só as URLs do cliente X | Crítica, em linguagem não técnica |

Contatos de cliente recebem mensagens sem detalhes internos (sem logs, nomes de serviço ou custos), geradas por um template próprio.

### Permissões de comando

| Comando | OWNER | ENGINEER | FINANCE | CLIENT\_VIEWER |
| --- | --- | --- | --- | --- |
| `/status`, `/custos` | sim | sim | sim | só status do seu serviço |
| `ok <id>`, `detalhes <id>` | sim | sim | não | não |
| `/monitor add`, `/silenciar` | sim | sim | não | não |
| `rollback <id>`, `restart <serviço>` | sim, com confirmação | não | não | não |
| `/contato add` | sim | não | não | não |

### Número de envio

O ideal é uma instância da Evolution separada da usada pelos agentes de atendimento: se o número de atendimento for bloqueado, os alertas continuam chegando, e as conversas com clientes não se misturam com alertas.

## IA de diagnóstico e comandos

A IA entra em três momentos — ao abrir um incidente, quando alguém pergunta algo pelo WhatsApp e no resumo diário — sempre trabalhando sobre dados que o Sentinela já coletou, com ferramentas somente leitura.

### Diagnóstico ao abrir incidente

Entrada montada pelo código: regra violada, série das últimas observações, deploys das últimas 2 h nos projetos relacionados (autor, branch, mensagem do commit), trechos de log com erro, status das URLs ligadas e incidentes parecidos já resolvidos (com a causa registrada). Saída em JSON:

```ts
const Diagnosis = z.object({
  summary: z.string().max(280),            // 1–2 frases para o WhatsApp
  probable_cause: z.string().max(400),
  evidence: z.array(z.string()).max(5),    // fatos concretos que sustentam
  confidence: z.enum(['LOW', 'MEDIUM', 'HIGH']),
  suggested_actions: z.array(z.object({
    action: z.enum(['ROLLBACK', 'RESTART', 'SCALE_UP', 'CHECK_EXTERNAL', 'WAIT', 'NONE']),
    reason: z.string(),
  })).max(3),
});
```

Regra do prompt: só afirmar o que está nas evidências; quando não souber, `confidence = LOW` e dizer o que falta verificar.

### Perguntas livres pelo WhatsApp

O contato pode escrever em linguagem natural: “por que o site tá lento?”, “quanto gastamos com a Vercel esse mês?”, “o deploy de ontem deu certo?”. Um agente com tools de leitura responde:

| Tool | Faz |
| --- | --- |
| `get_status(scope)` | Estado atual de serviços, projetos e monitores |
| `get_incidents(filter)` | Incidentes abertos ou recentes |
| `get_costs(period, provider)` | Gastos e projeção |
| `get_deploys(project, since)` | Deploys com autor e status |
| `get_metrics(resource, metric, window)` | Série de métricas resumida |
| `get_logs(resource, since, level)` | Trechos de log, já com segredos mascarados |
| `run_check(monitorId)` | Executa uma checagem agora |

### Comandos diretos

| Comando | Efeito |
| --- | --- |
| `/status` | Painel resumido: tudo OK ou lista do que não está |
| `/custos` | Gasto do mês e projeção por provedor |
| `/incidentes` | Incidentes abertos |
| `ok <id>` / `detalhes <id>` | Reconhece ou expande um incidente |
| `/silenciar <recurso> <tempo>` | Janela de manutenção rápida |
| `/monitor add <url>` | Cadastra URL com padrões; a IA propõe `mustContain` a partir da página |
| `/check <url>` | Checagem completa avulsa com análise por IA |
| `rollback <id>` / `restart <serviço>` | Ação com confirmação (seção Segurança) |

### Ações com confirmação

Rollback e restart usam uma segunda chave, com permissão de escrita, guardada separada. O fluxo exige duas mensagens: o pedido e a confirmação com um código de 4 dígitos que expira em 2 minutos. O Sentinela nunca executa ações sugeridas pela IA sem esse ciclo.

## Funcionalidades extras

Além de Render, Vercel, URLs e custos, estas funcionalidades cobrem os pontos cegos mais comuns de uma operação como a da SelfMachine; estão ordenadas pelo valor que entregam em relação ao esforço.

| Funcionalidade | O que faz | Esforço |
| --- | --- | --- |
| Vigia do sistema de atendimento | Checa sessão da Evolution, watch do Gmail, tamanho das filas BullMQ, aprovações pendentes há muito tempo e taxa de erro dos agentes | Baixo |
| Heartbeat de crons | Cada cron/job chama `POST /heartbeat/:id` ao terminar; se não chamar no intervalo esperado, alerta (“o backup não rodou”) | Baixo |
| Resumo diário às 8h | Uma mensagem: incidentes das últimas 24 h, deploys, gastos, certificados vencendo, monitores instáveis | Baixo |
| Relatório semanal | Disponibilidade por serviço, tempo médio de resposta, incidentes, custo vs. orçamento, recursos ociosos | Baixo |
| Expiração de domínios e SSL de todos os domínios | Lista única de vencimentos com aviso em 30, 14 e 3 dias | Baixo |
| Vigia externo do Sentinela | Um serviço de uptime externo (ou um cron em outro provedor) testa o `/health` do Sentinela e avisa se ele cair | Baixo |
| Status page | Página pública ou por cliente com o estado dos serviços, atualizada pelos incidentes | Médio |
| Integração com GitHub | Liga deploys a PRs e autores; comenta no PR quando um deploy dele causa incidente | Médio |
| Checagem de segurança leve | Headers de segurança, portas expostas inesperadas nos seus próprios domínios, dependências com vulnerabilidade conhecida no repositório | Médio |
| Monitor de banco | Conexões abertas, queries lentas, crescimento de tabelas, backup mais recente | Médio |
| Totens em campo (IoT) | Os totens enviam heartbeat e telemetria básica (online, impressora, leitor de cartão); totem offline vira incidente para a Clara/suporte | Médio |
| Gateway de pagamento | Taxa de aprovação de transações e erros da API do gateway; queda brusca = crítico | Médio |
| Pós-mortem automático | Ao resolver um incidente crítico, a IA rascunha linha do tempo, causa e ações; você revisa | Médio |
| Memória de incidentes | Causa e solução de cada incidente resolvido viram base para o diagnóstico dos próximos | Médio |
| Previsão de saturação | Tendência de disco, memória e custo para avisar antes de estourar | Alto |

Para a SelfMachine, os totens em campo e o gateway de pagamento costumam ser os pontos onde um problema custa venda diretamente; vale priorizar logo depois do básico.

## Painel de visualização

O painel é uma aplicação web (Next.js ou React + Vite servido pelo próprio Sentinela) com login e 2FA, atualizada em tempo real por Server-Sent Events; o WhatsApp avisa, o painel mostra o quadro completo.

### Telas

| Tela | Conteúdo principal |
| --- | --- |
| Visão geral | Semáforo por fonte (Render, Vercel, URLs, custos, sistema), incidentes abertos, últimos deploys, gasto do mês vs. orçamento |
| Serviços | Lista de serviços Render e projetos Vercel com status, último deploy, CPU/memória, 5xx, links diretos para o provedor |
| Monitores | URLs cadastradas com uptime de 24 h/7 d/30 d, latência, validade do SSL, último screenshot e veredito da IA |
| Incidentes | Linha do tempo de cada incidente: observações, mensagens enviadas, quem reconheceu, diagnóstico, pós-mortem |
| Custos | Gasto diário por provedor, projeção do mês, comparativo com o mês anterior, custo por projeto e por cliente |
| Contatos e regras | Cadastro de números, grupos, assinaturas, horário silencioso e editor de regras |
| Configurações | Chaves (só últimos 4 caracteres visíveis), status de cada integração, tabela de preços, janelas de manutenção |

### Gráficos principais

- Latência e disponibilidade por monitor (linha, com faixa de erro).
- Gasto acumulado do mês com a linha de orçamento e a projeção pontilhada.
- Deploys marcados como pontos sobre as métricas, para ver na hora se um deploy coincidiu com a piora.
- Mapa de calor de incidentes por dia da semana e hora.

### Tempo real

O painel abre uma conexão SSE em `/events`; o motor de alertas publica no Redis (`pub/sub`) cada mudança de status ou incidente, e a API repassa para os navegadores conectados.

## Schema do banco

O Sentinela usa o mesmo PostgreSQL do sistema multiagente, em um schema separado (`sentinela`), para poder ler `AgentRun` sem duplicar dados; observações de alta frequência ficam numa tabela particionada por dia (ou TimescaleDB, se preferir).

```prisma
enum Source   { RENDER VERCEL URL COST SELF IOT PAYMENT }
enum Severity { INFO WARNING CRITICAL }
enum IncidentStatus { OPEN ACKNOWLEDGED RESOLVED }

model Integration {
  id          String   @id @default(uuid())
  provider    String   // RENDER, VERCEL, GITHUB, OPENAI...
  label       String
  secretRef   String   // referência ao cofre, nunca a chave em si
  scope       String   // READ_ONLY | WRITE
  lastOkAt    DateTime?
  lastError   String?
}

model Resource {
  id          String  @id @default(uuid())
  source      Source
  externalId  String  // srv-..., prj_..., monitor id
  name        String
  environment String  @default("production")
  meta        Json
  status      String  @default("UNKNOWN")
  @@unique([source, externalId])
}

model Monitor {
  id              String   @id @default(uuid())
  name            String
  url             String
  config          Json     // expectStatus, mustContain, browserCheck, aiCheck...
  intervalSec     Int      @default(60)
  failuresToAlert Int      @default(3)
  linkedResource  String?
  baselineShot    String?  // URL do screenshot de referência
  enabled         Boolean  @default(true)
}

model Observation {
  id          BigInt   @id @default(autoincrement())
  resourceId  String
  kind        String
  value       Float?
  status      String   // OK | WARN | FAIL
  details     Json?
  observedAt  DateTime @default(now())
  @@index([resourceId, kind, observedAt])
}

model Rule {
  id          String   @id
  source      Source
  definition  Json     // match, condition, groupBy, resolveWhen
  severity    Severity
  runbook     String?
  enabled     Boolean  @default(true)
}

model Incident {
  id           Int            @id @default(autoincrement()) // #I-042
  key          String         // ruleId + groupBy
  ruleId       String
  severity     Severity
  status       IncidentStatus @default(OPEN)
  title        String
  diagnosis    Json?
  openedAt     DateTime       @default(now())
  ackedBy      String?
  ackedAt      DateTime?
  resolvedAt   DateTime?
  rootCause    String?        // preenchido no pós-mortem
  events       IncidentEvent[]
  @@index([key, status])
}

model IncidentEvent {
  id          String   @id @default(uuid())
  incidentId  Int
  incident    Incident @relation(fields: [incidentId], references: [id])
  type        String   // OPENED, UPDATED, NOTIFIED, ACKED, ESCALATED, RESOLVED, ACTION
  payload     Json
  createdAt   DateTime @default(now())
}

model AlertContact {
  id          String   @id @default(uuid())
  name        String
  phone       String   @unique
  email       String?
  role        String   // OWNER, ENGINEER, FINANCE, CLIENT_VIEWER
  groups      String[]
  quietHours  Json?
  escalationLevel Int  @default(1)
  verifiedAt  DateTime?
}

model Subscription {
  id          String   @id @default(uuid())
  group       String
  source      Source?
  resourceId  String?
  minSeverity Severity
}

model CostEntry {
  id          String   @id @default(uuid())
  provider    String
  project     String?
  day         DateTime @db.Date
  amountUsd   Decimal  @db.Decimal(12, 4)
  kind        String   // MEASURED | ESTIMATED | INVOICE
  @@unique([provider, project, day, kind])
}

model Budget {
  id          String  @id @default(uuid())
  provider    String
  monthlyUsd  Decimal @db.Decimal(12, 2)
}

model PriceBook {
  id          String  @id @default(uuid())
  provider    String
  item        String  // tipo de instância, plano
  usdPerMonth Decimal @db.Decimal(12, 4)
  validFrom   DateTime
}

model Heartbeat {
  id          String   @id
  expectedEverySec Int
  lastSeenAt  DateTime?
}
```

Retenção sugerida: `Observation` brutas por 30 dias e agregados por hora/dia por 13 meses; incidentes e custos sem prazo.

## Segurança das chaves

As chaves da Render e da Vercel dão controle sobre a infraestrutura inteira; o Sentinela as guarda num cofre, usa o menor escopo possível e nunca as expõe à IA, aos logs ou ao WhatsApp.

### Práticas obrigatórias

- **Cofre:** chaves no Doppler, Infisical, Vault ou no gerenciador de segredos do provedor onde o Sentinela roda; o banco guarda só `secretRef`.
- **Escopo mínimo:** na Vercel, token restrito ao time e, se possível, com expiração; na Render, uma conta/usuário dedicado ao monitoramento. Se o provedor não oferecer token somente leitura, a separação é feita no código: o módulo de coleta só tem chamadas `GET`.
- **Chave de escrita separada:** rollback e restart usam outra chave, carregada só no módulo de ações e só após confirmação.
- **Mascaramento:** qualquer string parecida com token (`rnd_`, `vercel_`, `sk-`, `Bearer ...`, JWTs) é trocada por `***` antes de logar, de mandar para a IA ou de enviar por WhatsApp.
- **Rotação:** lembrete a cada 90 dias e procedimento documentado; o painel mostra a idade de cada chave.
- **Webhooks:** assinatura verificada (Vercel) ou token secreto na URL/header; endpoints com limite de requisições.
- **Comandos pelo WhatsApp:** só de números verificados e com o papel certo; ações destrutivas exigem código de confirmação.
- **Auditoria:** todo uso da chave de escrita e todo comando gera `IncidentEvent` ou registro de auditoria com quem, quando e o quê.

### Se uma chave vazar

1. Revogar no painel do provedor imediatamente.
2. Gerar nova chave e atualizar o cofre; o Sentinela recarrega sem reiniciar.
3. Revisar o log de auditoria do provedor no período.
4. Registrar incidente de segurança com linha do tempo.

## Roadmap e checklist

O Sentinela entra em quatro etapas, começando pelo que dá alerta útil já na primeira semana de uso (deploys e uptime) e deixando a IA e as automações para quando os dados básicos estiverem confiáveis.

**Etapa 1 · Base e alertas essenciais**

- [ ] Schema `sentinela`, filas e processos `api`, `collector`, `engine`, `notifier`
- [ ] Instância da Evolution só para alertas
- [ ] Cadastro e verificação de contatos, grupos e assinaturas
- [ ] Coletor Render (serviços, deploys, eventos) e verificação da chave
- [ ] Webhooks da Vercel e inventário de projetos e domínios
- [ ] Monitor de URLs camadas 1 a 3
- [ ] Regras padrão, dedupe, `ok <id>` e escalonamento
- [ ] Vigia externo do próprio Sentinela

**Etapa 2 · Custos e painel**

- [ ] Gasto de LLM a partir de `AgentRun`
- [ ] `PriceBook`, orçamentos e estimativa de Render/Vercel
- [ ] Projeção do mês e regras de custo
- [ ] Painel: visão geral, serviços, monitores, incidentes, custos
- [ ] Resumo diário às 8h e relatório semanal
- [ ] Heartbeat de crons e vigia do sistema de atendimento

**Etapa 3 · Navegador, logins e IA**

- [ ] Worker `browser` com Playwright (camadas 4 e 5)
- [ ] Cofre e formulário de credenciais no painel
- [ ] Conta dedicada `monitor@` nos sistemas que serão testados com login
- [ ] Agendamento por cron, janela de horário e após deploy
- [ ] TOTP, reuso de sessão e proteção contra bloqueio de conta
- [ ] Análise visual por IA com baseline
- [ ] Diagnóstico por IA nos incidentes e perguntas livres pelo WhatsApp

**Etapa 4 · Ações e extras**

- [ ] Chave de escrita separada, `rollback` e `restart` com código de confirmação
- [ ] Telemetria dos totens em campo
- [ ] Monitor do gateway de pagamento
- [ ] Status page por cliente
- [ ] Pós-mortem automático e memória de incidentes
- [ ] Integração com GitHub
