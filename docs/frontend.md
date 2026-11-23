# Frontend SelfMachine — Arquitetura e UX do Centro de Comando

Nov 23, 2026 · @Mateus Saavedra

## Visão e princípios

O frontend é um único Centro de Comando para tudo que construímos — conversas dos agentes, aprovações, Sentinela, custos e totens em campo — com uma cena 3D viva da operação como peça central e o resto da interface rápido, limpo e silencioso para não competir com ela.

### A ideia central: a operação como um lugar

A SelfMachine vive de máquinas físicas em lojas. Em vez do painel genérico de cards, a tela inicial mostra a operação como uma maquete 3D: cada loja é uma ilha, cada totem é uma peça com a luz de status acesa, os serviços da Render e da Vercel formam a “casa de máquinas” no centro, e as conversas aparecem como fluxos de luz chegando dos canais até os agentes. Quando algo quebra, o lugar onde quebrou acende. Você entende o estado do negócio em um olhar e clica direto no problema.

### Princípios

1. **Ousadia em um lugar só.** O 3D vive na visão geral e em pontos pontuais (detalhe de totem). Listas, formulários e tabelas são planos, densos e rápidos.
2. **Nada espera o 3D.** A interface aparece pronta e usável antes da cena carregar; a cena chega depois, sem bloquear clique nem rolagem.
3. **Tudo tem um lugar óbvio.** Oito áreas fixas, cada uma com ícone próprio (e cor nas cinco de trabalho diário), sempre na mesma posição. Você nunca se pergunta “onde fica isso”.
4. **Teclado primeiro, mouse sempre.** Paleta de comandos (`Ctrl/⌘ K`) leva a qualquer tela, conversa, totem ou ação.
5. **O que precisa de você vem primeiro.** Aprovações pendentes, incidentes críticos e conversas em takeover têm contadores visíveis em qualquer tela.
6. **Filtros que lembram.** Todo filtro vive na URL e pode ser salvo como visão; compartilhar um link compartilha exatamente o que você está vendo.
7. **Confortável por horas.** Tema escuro calibrado para longas sessões, tema claro para ambientes iluminados, contraste AA no mínimo e movimento reduzido respeitado.

### Metas de experiência

| Meta | Alvo |
| --- | --- |
| Tela utilizável após abrir | menos de 1,5 s em desktop com cache frio; menos de 0,5 s com cache |
| Troca entre telas | percebida como instantânea (menos de 100 ms com dados em cache) |
| Resposta a clique ou tecla (INP) | menos de 200 ms |
| Cena 3D | 60 fps em notebook comum; nunca abaixo de 30 fps (qualidade se ajusta sozinha) |
| Chegar a qualquer item | no máximo 2 cliques ou 1 busca |

## Stack e arquitetura

O frontend é uma aplicação de página única (SPA) com Vite e React, servida como arquivos estáticos pela Vercel; não há renderização no servidor porque tudo fica atrás de login, e o ganho de velocidade vem de cache agressivo e carregamento sob demanda.

&#91;embedded content: camadas do frontend · do navegador ao backend\]

A cena 3D nunca está no caminho crítico: se ela demorar ou falhar, a casca e as telas já estão funcionando.

### Por que essa stack

| Escolha | Motivo |
| --- | --- |
| Vite + React 19 | Build rápido, ecossistema do R3F, sem custo de servidor para páginas logadas |
| TanStack Router | Rotas tipadas, filtros na URL validados, pré-carregamento por intenção |
| TanStack Query | Cache, atualização em segundo plano, mutations otimistas, persistência |
| Tailwind v4 + tokens | Estilo consistente e CSS mínimo no pacote final |
| Radix UI | Acessibilidade correta em menus, diálogos e abas sem impor visual |
| React Three Fiber + drei | Three.js declarativo, com `PerformanceMonitor`, instancing e loaders prontos |
| uPlot | Gráficos de séries temporais muito leves e rápidos com milhares de pontos |
| SSE | Tempo real simples, atravessa proxies, reconexão nativa; WebSocket só se surgir necessidade bidirecional |

Se no futuro houver páginas públicas (status page de clientes), elas podem ser um projeto Next.js separado, sem pesar no painel.

## Mapa de navegação e divisões

A barra lateral tem oito áreas fixas, sempre na mesma ordem, e cada uma responde a uma pergunta só; dentro delas, abas finas separam as sub-visões.

&#91;embedded content: mapa de navegação · 8 áreas\]

As três primeiras áreas são o trabalho do dia a dia e ficam no topo; Configurações fica separada no rodapé da barra.

### A pergunta de cada área

| Área | Responde | Contador na barra |
| --- | --- | --- |
| Início | Como está a operação agora? | Itens que precisam de você |
| Conversas | O que os clientes estão falando? | Conversas sem resposta ou em takeover |
| Aprovações | O que espera minha decisão? | Pedidos pendentes |
| Agentes | Os agentes estão indo bem? | — |
| Sentinela | Algo está quebrado ou lento? | Incidentes abertos |
| Custos | Quanto estamos gastando? | Selo âmbar se a projeção passar do orçamento |
| Totens | Os equipamentos em campo estão ok? | Totens offline |
| Configurações | Como o sistema está ajustado? | — |

### URLs

Toda tela, aba, item aberto e filtro tem URL própria e legível: `/conversas/7f3a?painel=contexto`, `/sentinela/incidentes/42`, `/custos?periodo=mes&provedor=vercel`. Voltar e avançar do navegador funcionam como esperado.

## Design system

A identidade visual vem do próprio produto: o azul-petróleo do vidro de um totem desligado, o âmbar dos LEDs de status e o ciano das telas acesas. Tudo é definido em tokens CSS, então tema claro, escuro e ajustes futuros mudam em um único arquivo.

### Paleta base (tema escuro)

| Token | Hex | Uso |
| --- | --- | --- |
| `--petroleo-900` | #0F2830 | Fundo da aplicação e da cena 3D |
| `--petroleo-800` | #163641 | Superfícies: barra lateral, painéis, tabelas |
| `--petroleo-700` | #21495A | Bordas, linhas, divisórias, hover de linha |
| `--nevoa` | #E6EFEE | Texto principal |
| `--nevoa-60` | #9FB4B6 | Texto secundário e rótulos |
| `--ambar-led` | #F2B33D | Ação principal, foco, “precisa de você” |
| `--ciano-tela` | #5CC8D7 | Dados, gráficos, links, seleção |

No tema claro, o fundo vira `#EEF3F2`, superfícies `#FFFFFF`, bordas `#CAD8D8`, texto `#102A31`; âmbar e ciano escurecem um tom (`#B97E0E`, `#127A89`) para manter contraste.

### Cores de estado (semânticas)

| Estado | Escuro | Claro | Sempre acompanhado de |
| --- | --- | --- | --- |
| Ok | #43B884 | #1E7F55 | ícone de check |
| Aviso | #F2B33D | #9A6408 | ícone de triângulo |
| Crítico | #EF5A5A | #B3261E | ícone de alerta + pulso lento |
| Inativo | #6C8487 | #7A8E90 | ícone de pausa |
| IA trabalhando | #5CC8D7 | #127A89 | animação de 3 pontos |

Cor nunca é o único sinal: todo estado tem ícone e texto.

### Cores das áreas

Cada área tem uma cor de identidade usada só no ícone da navegação, no indicador da aba ativa e na linha fina no topo da página — nunca em fundos grandes. Conversas: ciano. Aprovações: âmbar. Sentinela: verde-sinal `#43B884`. Custos: lilás `#A796E8`. Totens: coral `#F08A6C`. Assim você sabe onde está só pela cor do topo.

### Tipografia

- **Família única:** Schibsted Grotesk (títulos e interface), com números tabulares (`font-variant-numeric: tabular-nums`) em tabelas, métricas e custos para os dígitos alinharem.
- **Código e logs:** JetBrains Mono, só dentro de blocos de log e payloads.
- **Escala** (razão 1,2): 12 · 14 · 16 · 19 · 23 · 28 · 34 px. Corpo 14 px em telas densas, 16 px em leitura de conversas.
- **Pesos:** 400 e 600. Nada de itálico ou cor para destacar uma palavra isolada em título.
- **Rótulos** em caixa normal (sentence case), nunca em CAIXA ALTA.
- **Linhas de texto** com no máximo 75 caracteres em painéis de leitura (conversas, diagnósticos da IA).

### Espaço, forma e profundidade

- Grade de 4 px; espaçamentos 4, 8, 12, 16, 24, 32, 48.
- Raio diferente por hierarquia: 6 px em controles (botões, inputs, chips), 10 px em painéis, 0 em linhas de tabela. Não há um raio único para tudo.
- Profundidade por luminosidade, não por sombra: quanto mais à frente, mais clara a superfície (900 → 800 → 700). Sombra só em elementos flutuantes (menus, paleta de comandos, popovers).
- Divisórias de 1 px em `--petroleo-700` separam seções; cards só quando o item é realmente um objeto (um totem, um incidente).

### Movimento

- Um único momento orquestrado: ao abrir a visão geral, a câmera da cena 3D desce do alto até a maquete em 1,2 s. O resto da interface não anima ao carregar.
- Movimento que responde a você: painéis laterais deslizam em 180 ms, menus aparecem em 120 ms, itens removidos encolhem em 150 ms.
- Easing padrão `cubic-bezier(0.2, 0, 0, 1)`; nada de molas exageradas em elementos de trabalho.
- `prefers-reduced-motion`: câmera parada, pulsos viram ícone fixo, transições viram troca direta.

### Ícones

Lucide (traço 1,5 px), importados um a um para não carregar a biblioteca inteira. Tamanhos 16 e 20 px.

## Camada 3D

A cena 3D é feita com React Three Fiber (Three.js) e carregada como um pacote separado depois que a interface já está usável; ela tem três modos de qualidade que se ajustam sozinhos e um fallback 2D para máquinas fracas ou quem prefere menos movimento.

### Cena 1 — Maquete da operação (visão geral)

| Elemento 3D | Representa | Comportamento |
| --- | --- | --- |
| Ilhas hexagonais | Lojas/clientes | Tamanho pelo número de totens; clique foca a câmera e abre o painel da loja |
| Totens (peças low-poly) | Cada totem em campo | LED no topo com a cor do estado; crítico pulsa e projeta um feixe vertical visível de longe |
| Casa de máquinas (centro) | Serviços Render, projetos Vercel, banco, filas | Blocos empilhados; deploy em andamento mostra um anel girando; falha deixa o bloco vermelho |
| Quatro torres | Agentes Léo, João, Clara, Gabriel (IA) | Brilho proporcional às conversas ativas; aprovação pendente acende um farol âmbar |
| Fluxos de partículas | Mensagens entrando por WhatsApp e Gmail | Partículas percorrem curvas dos portões até a torre do agente que respondeu |
| Anel externo | Custos do mês | Preenche conforme o gasto; muda para âmbar ao passar da projeção |

Interface sobre a cena (HTML, não 3D): contadores de “precisa de você” no canto superior, linha do tempo dos últimos eventos na lateral, e rótulos que só aparecem ao passar o mouse ou ao aproximar a câmera. Clicar em qualquer objeto abre um painel lateral com os dados reais; a cena nunca é o único caminho para uma informação.

### Cena 2 — Totem em detalhe

No detalhe de um totem, um modelo 3D do equipamento gira lentamente e destaca o componente com problema (impressora, leitor de cartão, tela, rede). Ao lado, telemetria e histórico em 2D. Útil para a Clara e para o técnico entenderem o que está falhando.

### Cena 3 — Grafo da conversa (opcional)

No detalhe de uma conversa, um grafo leve mostra por quais agentes ela passou, onde houve handoff e aprovação. Vale como fase posterior; a linha do tempo 2D resolve o essencial.

### Técnicas para não travar

- **Instancing:** todos os totens são um único `InstancedMesh` (centenas de totens = uma chamada de desenho). Partículas também.
- **Modelos leves:** GLB comprimido com Draco/Meshopt, menos de 300 KB no total; texturas KTX2; geometria low-poly estilizada (combina com a identidade e é barata).
- **Renderização sob demanda:** `frameloop="demand"` — a cena só redesenha quando algo muda ou a câmera se move; parada, ela não gasta GPU.
- **Pausa automática:** aba escondida ou cena fora da tela = render parado.
- **Qualidade adaptativa:** `PerformanceMonitor` do drei reduz DPR, desliga pós-processamento e diminui partículas quando o fps cai.
- **Atualizações fora do React:** estados que mudam a todo momento (partículas, LEDs) são escritos direto nos buffers via `useFrame`, sem re-render de componentes.
- **Iluminação barata:** luz ambiente + uma direcional + emissivos para os LEDs; bloom só no modo alto.

### Modos de qualidade

| Modo | Quando | O que muda |
| --- | --- | --- |
| Alto | GPU dedicada ou fps estável acima de 55 | Bloom nos LEDs, sombras suaves, 2.000 partículas, DPR até 2 |
| Médio | padrão | Sem sombras dinâmicas, 600 partículas, DPR 1,5 |
| Baixo | fps abaixo de 30 ou bateria fraca | Sem pós-processamento, 150 partículas, DPR 1 |
| 2D | sem WebGL, `prefers-reduced-motion`, celular pequeno ou escolha do usuário | Mapa plano em SVG com os mesmos dados e cliques |

O usuário pode fixar o modo em Configurações; a escolha fica salva.

### Carregamento da cena

1. A visão geral abre com o mapa 2D já desenhado (leve, imediato).
2. Quando o navegador fica ocioso (`requestIdleCallback`), o pacote 3D (\~250 KB gzip, estimado) e os modelos começam a baixar.
3. Ao terminar, o 2D dá lugar ao 3D com a descida da câmera. Se a pessoa já estiver interagindo com o 2D, a troca espera um momento parado.
4. Nas visitas seguintes, o pacote vem do cache do service worker e o 3D aparece quase de imediato.

## Telas principais

Todas as telas seguem o mesmo esqueleto — barra lateral fixa, cabeçalho com filtros, conteúdo e painel lateral de detalhe — para que aprender uma seja aprender todas.

### Esqueleto comum

```text
┌──────┬──────────────────────────────────────────────┐
│ nav  │ Título da área   [busca]   [filtros]  [visões] │
│      ├────────────────────────────┬───────────────────┤
│ ● 3 │ lista ou conteúdo principal  │ painel de detalhe  │
│ ● 1 │ (virtualizado)                │ (abre ao clicar,   │
│      │                               │  fecha com Esc)    │
└──────┴──────────────────────────────┴───────────────────┘
```

A barra lateral tem 64 px recolhida (só ícones + contadores) e 232 px expandida. O painel de detalhe ocupa 40% da largura e pode ser expandido para tela cheia ou aberto em nova aba (cada item tem URL própria).

### Início (Centro de Comando)

- Cena 3D da operação ocupando a área principal.
- Faixa “Precisa de você” no topo: aprovações pendentes, incidentes críticos, conversas paradas há muito tempo, promessas vencendo hoje. Cada item com ação direta (aprovar, reconhecer, abrir).
- Linha do tempo lateral com os últimos 50 eventos, filtrável por área.
- Quatro números do dia: conversas atendidas, tempo médio de resposta, incidentes, gasto do dia.

### Conversas

- **Coluna 1, caixa de entrada:** lista virtualizada com contato, canal (ícone WhatsApp/Gmail), agente ativo (avatar com a cor do agente), última mensagem, tempo e selos (aprovação pendente, takeover, cliente irritado).
- **Coluna 2, conversa:** mensagens no estilo do canal, com a mensagem de cada agente marcada pelo nome e cor, áudios com transcrição expansível, imagens com a descrição da IA, notas internas do Léo em faixa discreta e eventos (handoff, takeover) como divisórias.
- **Coluna 3, contexto:** perfil, `facts` editáveis, resumo, promessas com prazo, tickets e histórico do outro canal.
- **Ações:** assumir conversa (ativa takeover), devolver para um agente, escrever como humano, enviar sugestão da IA com edição, marcar como resolvida.
- **Atalhos:** `J/K` próxima/anterior, `A` assumir, `E` resolver, `R` responder.

### Aprovações

- Fila em cartões grandes, um por pedido: quem pediu, cliente, o que foi pedido, contexto em 3 linhas, rascunho da resposta.
- Botões “Aprovar e enviar”, “Editar e enviar”, “Recusar”. Atalhos `1`, `2`, `3`.
- Contador regressivo até o lembrete/expiração.

### Agentes

- Uma coluna por agente com: conversas ativas, taxa de resolução, handoffs, custo do dia, latência média.
- Editor de prompt com versionamento, diff entre versões e botão “Rodar conjunto de testes” antes de publicar.
- Lista de tools habilitadas e limites (desconto máximo etc.), editáveis por quem tem permissão.

### Sentinela

- Abas: Incidentes, Serviços, Monitores, Logins agendados.
- Incidente aberto mostra linha do tempo, gráfico com o momento do deploy marcado, diagnóstico da IA e botões de ação com confirmação.
- Monitores em grade com miniatura do último screenshot, uptime e veredito da IA.

### Custos

- Gráfico de gasto acumulado do mês com linha de orçamento e projeção pontilhada.
- Barras por provedor e por agente; tabela por cliente.
- Sugestões de economia vindas do Sentinela (serviços ociosos).

### Totens

- Mapa (2D ou 3D) e tabela alternados por um botão.
- Detalhe do totem com a cena 3D do equipamento, telemetria, tickets e conversas do cliente.

### Configurações

Contatos e assinaturas, integrações e chaves (mascaradas), regras de alerta, credenciais de monitores (só escrita), tema, qualidade do 3D, atalhos e usuários com papéis.

## Filtros, busca e paleta de comandos

Filtrar é a ação mais frequente num sistema assim, então os filtros têm um padrão único em todas as telas: chips no cabeçalho, sempre visíveis, guardados na URL e salváveis como visões.

### Barra de filtros

- Cada filtro ativo é um chip (`Canal: WhatsApp ×`); clicar no chip edita, o `×` remove.
- Botão “+ Filtro” abre a lista de campos disponíveis para aquela tela, com busca.
- Filtros combinam com E; dentro de um campo, múltiplos valores combinam com OU (`Agente: João, Clara`).
- Contador de resultados atualiza enquanto você filtra, sem botão “aplicar”.
- “Limpar tudo” aparece só quando há 2 ou mais filtros.

### Filtros por tela

| Tela | Campos |
| --- | --- |
| Conversas | Canal, agente ativo, status, urgência, sentimento, estágio do CRM, com aprovação pendente, em takeover, período, tag do contato |
| Aprovações | Tipo de ação, agente que pediu, valor, idade do pedido |
| Sentinela | Fonte, severidade, status, serviço/projeto, período |
| Custos | Provedor, projeto, agente, cliente, período |
| Totens | Loja/cliente, modelo, estado, sem contato há X horas, componente com falha |

### Filtros rápidos e visões salvas

- Cada tela tem 3 a 5 visões prontas como abas finas acima da lista: “Precisa de mim”, “Hoje”, “Clientes irritados”, “Sem resposta há 1 h”.
- “Salvar visão” guarda a combinação atual de filtros, ordenação e colunas com um nome; visões podem ser pessoais ou da equipe.
- Toda visão tem URL própria (`/conversas?agente=clara&status=aberta`), então dá para mandar um link exato no WhatsApp.

### Filtro por linguagem natural

Na busca, digitar uma frase como “conversas do João com desconto pendente essa semana” gera os chips equivalentes (um modelo pequeno traduz a frase em filtros estruturados validados). Os chips aparecem para você conferir e ajustar — a IA nunca filtra “escondido”.

### Busca global

- Um campo só procura em contatos, conversas (texto das mensagens), tickets, incidentes, totens e serviços.
- Resultados agrupados por tipo, com destaque do trecho encontrado.
- Backend: busca de texto completo do PostgreSQL (`tsvector` com dicionário português) + `pg_trgm` para nomes com erro de digitação; resposta em menos de 150 ms como meta.

### Paleta de comandos (`Ctrl/⌘ K`)

| Você digita | Acontece |
| --- | --- |
| `padaria` | Contato, conversas, totens e incidentes da Padaria Central |
| `>aprovar` | Lista aprovações pendentes para decidir ali mesmo |
| `>tema` | Alterna claro/escuro |
| `>3d baixo` | Muda a qualidade da cena |
| `>rollback api-totem` | Abre o fluxo de rollback com confirmação |
| `#I-042` | Vai direto ao incidente |
| `?` | Mostra todos os atalhos |

A paleta mostra os itens recentes antes de você digitar e carrega em menos de 50 ms porque usa o índice local de itens já vistos, completando com o servidor em seguida.

## Desempenho

A regra é simples: a casca da aplicação é pequena e chega primeiro, cada tela baixa só o próprio código, dados aparecem do cache na hora e se atualizam por trás, e listas longas só desenham o que está na tela.

### Orçamento de tamanho (gzip)

| Pacote | Limite | Conteúdo |
| --- | --- | --- |
| Casca inicial | 150 KB JS + 20 KB CSS | React, roteador, cliente de dados, layout, navegação, paleta de comandos |
| Cada tela | 60 KB | Componentes daquela área |
| Gráficos | 50 KB | uPlot para séries temporais; carregado só nas telas com gráfico |
| 3D | 250 KB + modelos 300 KB | Three.js, R3F, drei (só o usado), GLBs |
| Fontes | 2 arquivos WOFF2 com subset latino | Schibsted Grotesk 400/600 |

O CI quebra o build se algum limite for ultrapassado (`size-limit`).

### Carregamento

- **Divisão por rota:** cada área é um `lazy()` do roteador; ao passar o mouse num link da navegação, o código e os dados daquela tela começam a ser pré-carregados (`preload: 'intent'` do TanStack Router).
- **Dados antes do código terminar:** o loader da rota dispara a busca de dados em paralelo com o download do componente.
- **Fontes:** `preload` do arquivo 400, `font-display: swap` e métricas de fallback ajustadas (`size-adjust`) para o texto não “pular”.
- **Imagens:** screenshots de monitores e fotos de totens em AVIF/WebP, tamanhos responsivos e `loading="lazy"`.
- **Service worker** (Workbox): guarda casca, fontes, pacote 3D e modelos; visitas seguintes abrem sem rede para os estáticos.

### Dados

- **TanStack Query** com `staleTime` por tipo de dado: listas 30 s, detalhes 60 s, configurações 10 min. Ao voltar para uma tela, os dados aparecem do cache instantaneamente e atualizam em segundo plano.
- **Persistência do cache** em IndexedDB: ao reabrir o sistema, a última visão aparece de imediato enquanto o servidor confirma.
- **Paginação por cursor** e carregamento contínuo ao rolar; o servidor nunca devolve listas inteiras.
- **Payloads enxutos:** listas recebem só os campos que a lista mostra; o detalhe busca o resto quando aberto.
- **Tempo real atualiza o cache**, não a tela: eventos SSE fazem `setQueryData` pontual em vez de recarregar listas.

### Renderização

- **Virtualização** (TanStack Virtual) em toda lista ou tabela com mais de 100 linhas: 10.000 conversas rolam tão leve quanto 50.
- **Estado granular:** Zustand com seletores para estado de interface; um contador mudando não re-renderiza a página.
- **React Compiler** (ou `memo` nos componentes de linha) para evitar re-renders em cascata.
- **Trabalho pesado fora da tela principal:** agregações de custos e parsing de logs grandes num Web Worker.
- **`content-visibility: auto`** em seções longas abaixo da dobra.
- **Transições não bloqueantes:** `startTransition` ao trocar filtros, para a digitação nunca engasgar.

### Metas medidas em produção

| Métrica | Meta (p75) |
| --- | --- |
| LCP | menos de 1,5 s |
| INP | menos de 200 ms |
| CLS | menos de 0,05 |
| Troca de rota com cache | menos de 100 ms |
| fps da cena 3D | 55 ou mais no modo médio |

As métricas são coletadas com a biblioteca `web-vitals` e enviadas ao backend, aparecendo no próprio Sentinela como mais um monitor.

## Tempo real e atualizações otimistas

Uma única conexão Server-Sent Events por aba traz todos os eventos do sistema; as ações do usuário aparecem na tela antes do servidor confirmar e são desfeitas com aviso se falharem.

### Canal de eventos

```ts
// um EventSource por aba; abas extras recebem via BroadcastChannel
const es = new EventSource('/api/events', { withCredentials: true });
es.addEventListener('message.created', (e) => {
  const msg = JSON.parse(e.data);
  queryClient.setQueryData(['thread', msg.threadId], (old) => appendMessage(old, msg));
  queryClient.setQueryData(['inbox'], (old) => bumpThread(old, msg));
});
es.addEventListener('incident.opened', (e) => { /* atualiza contador e cena 3D */ });
```

| Evento | Atualiza |
| --- | --- |
| `message.created` | Conversa aberta, caixa de entrada, partículas da cena |
| `thread.updated` | Agente ativo, selos, takeover |
| `approval.created` / `approval.decided` | Fila de aprovações, contador, farol da torre |
| `incident.opened` / `incident.updated` / `incident.resolved` | Sentinela, contador, cor do objeto na cena |
| `deploy.updated` | Casa de máquinas, lista de serviços |
| `totem.status` | LED do totem, tabela de totens |
| `cost.updated` | Anel de custos, tela de custos (no máximo 1× por minuto) |

### Comportamentos

- **Uma conexão para várias abas:** a primeira aba abre o SSE e repassa eventos às outras por `BroadcastChannel`, poupando servidor.
- **Reconexão:** o servidor envia `id` em cada evento; ao reconectar, o navegador manda `Last-Event-ID` e recebe o que perdeu.
- **Agrupamento:** eventos que chegam em rajada são aplicados num único frame (`requestAnimationFrame`), evitando dezenas de re-renders.
- **Novas mensagens sem pular a tela:** se você estiver rolando a lista, aparece “3 novas” no topo em vez de empurrar o conteúdo.

### Ações otimistas

| Ação | Na hora | Se o servidor recusar |
| --- | --- | --- |
| Aprovar pedido | Cartão sai da fila, contador diminui | Cartão volta com a mensagem do erro |
| Assumir conversa | Selo “você” aparece, campo de resposta ativa | Selo some, aviso explicando |
| Enviar mensagem | Bolha aparece com relógio; vira check quando confirmada | Bolha fica vermelha com “Tentar de novo” |
| Reconhecer incidente | Status muda para reconhecido | Volta e mostra o motivo |
| Editar `facts` | Valor muda | Volta ao anterior |

Ações destrutivas (rollback, excluir contato) nunca são otimistas: esperam confirmação do servidor e mostram progresso.

## Acessibilidade e conforto visual

O sistema será usado por horas seguidas, então conforto visual é requisito, não enfeite: contraste certo, nada piscando sem motivo, densidade ajustável e tudo operável pelo teclado.

### Conforto para os olhos

- **Escuro que não é preto:** o fundo petróleo `#0F2830` reduz o contraste extremo de branco sobre preto, que cansa em sessões longas; o texto principal é `#E6EFEE`, não branco puro.
- **Tema automático:** segue o sistema operacional por padrão; opcionalmente muda pelo horário (claro de dia, escuro à noite).
- **Densidade:** três níveis (confortável, padrão, compacto) mudam altura de linha e espaçamentos em tabelas e listas.
- **Tamanho do texto:** controle de 90% a 125% nas configurações, além do zoom do navegador.
- **Nada pisca:** o único pulso é o de incidente crítico, com ciclo lento de 2 s e amplitude suave; nenhum elemento pisca mais de 3 vezes por segundo.
- **Modo foco:** esconde a barra lateral, a cena 3D e os contadores, deixando só a conversa ou a fila de aprovações.

### Requisitos de acessibilidade (WCAG 2.2 AA)

- Contraste mínimo de 4,5:1 para texto e 3:1 para ícones e bordas de controles, verificado nos dois temas.
- Foco visível em todos os elementos: anel âmbar de 2 px com 2 px de afastamento.
- Tudo operável por teclado, inclusive a cena 3D: `Tab` percorre lojas e serviços, `Enter` abre o painel. Alternativa em lista sempre disponível.
- Componentes baseados em Radix UI (menus, diálogos, abas, combobox) para semântica ARIA correta.
- Regiões ao vivo (`aria-live="polite"`) para novas mensagens e incidentes; críticos usam `assertive`.
- Alvos de clique de pelo menos 24 × 24 px (44 px no celular).
- Estados nunca só por cor; sempre ícone + texto.
- Textos alternativos nas imagens das conversas usando a descrição gerada pela IA.

### Celular

No celular, o sistema vira um app instalável (PWA) focado em agir rápido: aprovações, incidentes, conversas e o mapa 2D. A cena 3D fica opcional. Navegação inferior com as cinco áreas mais usadas e notificações push para o que precisa de você.

## Estados: vazio, carregando, erro e offline

Cada tela define seus quatro estados antes de ser construída; nenhum deles é uma tela em branco ou um spinner girando sem explicação.

| Estado | Como aparece | Exemplo de texto |
| --- | --- | --- |
| Carregando (primeira vez) | Esqueleto com o formato real do conteúdo (linhas, avatares), sem animação de brilho forte | — |
| Carregando (atualização) | Conteúdo do cache visível + barra fina de 2 px no topo da área | — |
| Vazio | Frase que diz o que fazer, com o botão da ação | “Nenhuma aprovação pendente. Quando um agente pedir um desconto ou prazo especial, ele aparece aqui.” |
| Vazio por filtro | Mostra quais filtros zeraram o resultado e oferece removê-los | “Nada com Agente: Gabriel + Status: urgente. Remover ‘urgente’?” |
| Erro de carregamento | Mensagem do que falhou + “Tentar de novo”; o resto da tela continua funcionando | “Não foi possível carregar os custos da Vercel: a chave foi recusada. Verifique em Configurações › Integrações.” |
| Offline | Faixa discreta no topo; dados do cache continuam visíveis; ações ficam na fila e são enviadas ao voltar | “Sem conexão. Mostrando dados de 14:32. 2 ações aguardando envio.” |
| 3D indisponível | Mapa 2D no lugar, com uma linha explicando | “Seu navegador não suporta a visão 3D; mostrando o mapa plano.” |

### Regras de escrita da interface

- Mensagens dizem o que aconteceu e o que fazer, sem pedir desculpas.
- Botões dizem exatamente o que acontece: “Aprovar e enviar”, não “Confirmar”; o aviso seguinte usa a mesma palavra (“Aprovado e enviado”).
- Nomes pelo que a pessoa entende: “Avisos” e “Números que recebem alertas”, não “webhooks” ou “subscriptions”.
- Erros isolados por bloco (error boundary por painel): uma parte quebrada nunca derruba a página inteira.

## Estrutura de pastas e componentes

O código é organizado por área (feature), não por tipo de arquivo: tudo de Conversas fica junto, e o que é compartilhado mora em `ui/` e `lib/`.

```text
web/
├─ public/
│  └─ models/              # GLB comprimidos (totem, ilhas)
├─ src/
│  ├─ app/
│  │  ├─ router.tsx         # TanStack Router, rotas lazy
│  │  ├─ query-client.ts    # TanStack Query + persistência
│  │  ├─ realtime.ts        # SSE + BroadcastChannel
│  │  └─ shell/             # barra lateral, cabeçalho, paleta
│  ├─ features/
│  │  ├─ command-center/    # início, faixa "precisa de você"
│  │  ├─ conversations/
│  │  │  ├─ api.ts          # queries e mutations
│  │  │  ├─ Inbox.tsx
│  │  │  ├─ Thread.tsx
│  │  │  ├─ ContextPanel.tsx
│  │  │  └─ filters.ts      # schema dos filtros (zod) ↔ URL
│  │  ├─ approvals/
│  │  ├─ agents/
│  │  ├─ sentinel/
│  │  ├─ costs/
│  │  ├─ totems/
│  │  └─ settings/
│  ├─ scene3d/               # pacote 3D separado
│  │  ├─ OperationScene.tsx
│  │  ├─ Totems.tsx         # InstancedMesh
│  │  ├─ MessageFlows.tsx   # partículas
│  │  ├─ quality.ts         # modos e PerformanceMonitor
│  │  └─ FlatMap.tsx        # fallback 2D (SVG)
│  ├─ ui/                    # design system
│  │  ├─ tokens.css
│  │  ├─ Button.tsx, Chip.tsx, FilterBar.tsx, DataTable.tsx,
│  │  │  SidePanel.tsx, StatusBadge.tsx, EmptyState.tsx, Skeleton.tsx
│  │  └─ charts/            # wrappers de uPlot
│  ├─ lib/                   # formatação (moeda, datas pt-BR), atalhos, workers
│  └─ main.tsx
├─ tests/                    # Playwright e2e
└─ vite.config.ts
```

### Componentes-chave do design system

| Componente | Responsabilidade |
| --- | --- |
| `FilterBar` | Chips, “+ Filtro”, visões salvas; lê e escreve na URL a partir de um schema zod |
| `DataTable` | TanStack Table + Virtual; colunas configuráveis, ordenação, seleção, densidade |
| `SidePanel` | Painel de detalhe com URL própria, `Esc` fecha, expandir para tela cheia |
| `StatusBadge` | Cor + ícone + texto de cada estado, padronizado |
| `AgentAvatar` | Cor e inicial do agente, presença (respondendo, ocioso) |
| `TimeAgo` | “há 3 min” atualizado sem re-render da lista inteira |
| `Money` | Moeda com números tabulares e conversão USD/BRL |
| `EmptyState` / `ErrorState` | Textos e ações padronizados |
| `CommandPalette` | cmdk + índice local + busca no servidor |

### Stack resumida

React 19 + TypeScript, Vite, TanStack Router/Query/Table/Virtual, Zustand, Tailwind CSS v4 sobre os tokens, Radix UI, cmdk, Motion (animações de interface), uPlot (gráficos), React Three Fiber + drei + postprocessing (3D), Workbox (service worker), zod (validação compartilhada com o backend).

## Qualidade e testes

Velocidade e acessibilidade são verificadas automaticamente a cada pull request; um build que deixa o sistema mais lento ou inacessível não entra.

| Verificação | Ferramenta | Bloqueia o merge quando |
| --- | --- | --- |
| Tamanho dos pacotes | `size-limit` | Algum pacote passa do orçamento |
| Performance de carregamento | Lighthouse CI em 3 telas | Performance abaixo de 90 ou LCP acima de 2 s |
| Acessibilidade | `axe-core` no Playwright | Qualquer violação séria ou crítica |
| Fluxos principais | Playwright e2e | Falha em aprovar, assumir conversa, filtrar, reconhecer incidente |
| Regressão visual | Screenshots do Playwright nos dois temas | Diferença acima do limiar sem aprovação |
| Componentes | Vitest + Testing Library | Testes falhando |
| Tipos | `tsc --noEmit` | Erro de tipo |
| Cena 3D | Teste de fumaça: carrega, renderiza 60 frames, mede fps em máquina de CI | Erro de WebGL ou fps médio abaixo do limite no modo baixo |

### Catálogo de componentes

Storybook (ou Ladle, mais leve) com cada componente do design system nos dois temas, nas três densidades e nos estados vazio/carregando/erro. É onde se revisa visual antes de usar numa tela.

### Monitoramento em produção

- Web vitals reais (LCP, INP, CLS) enviados ao backend e exibidos no Sentinela.
- Erros de JavaScript capturados (Sentry ou endpoint próprio) com a rota e a versão.
- fps médio e modo de qualidade escolhido da cena 3D, para ajustar os limites com dados reais.

## Roadmap e checklist

O 3D vem por último de propósito: primeiro as telas de trabalho ficam rápidas e completas com o mapa 2D, depois a cena entra por cima de uma base que já funciona.

**Etapa 1 · Casca e design system**

- [ ] Projeto Vite + React 19 + TypeScript, roteador e cliente de dados
- [ ] Tokens de cor, tipografia, espaçamento e os dois temas
- [ ] Barra lateral, cabeçalho, `SidePanel`, `FilterBar`, `DataTable`, estados
- [ ] Paleta de comandos com navegação
- [ ] Login com 2FA e papéis
- [ ] `size-limit`, Lighthouse CI e axe no pipeline

**Etapa 2 · Telas de trabalho**

- [ ] Conversas (caixa de entrada, conversa, contexto, assumir/devolver)
- [ ] Aprovações com atalhos
- [ ] SSE, `BroadcastChannel` e ações otimistas
- [ ] Visões salvas e filtros na URL
- [ ] Busca global

**Etapa 3 · Sentinela, custos e totens**

- [ ] Telas do Sentinela com gráficos uPlot e marcação de deploys
- [ ] Custos com projeção e orçamento
- [ ] Totens em tabela e mapa 2D
- [ ] Agentes: métricas e editor de prompt com testes
- [ ] PWA e push no celular

**Etapa 4 · Centro de Comando 3D**

- [ ] Modelos low-poly (ilha, totem, casa de máquinas, torres) em GLB comprimido
- [ ] Cena com instancing, renderização sob demanda e modos de qualidade
- [ ] Partículas de mensagens e LEDs ligados ao SSE
- [ ] Carregamento ocioso, troca 2D → 3D e cache no service worker
- [ ] Navegação por teclado na cena
- [ ] Totem em detalhe 3D

**Etapa 5 · Refinos**

- [ ] Filtro por linguagem natural
- [ ] Grafo da conversa
- [ ] Ajustes de limites com os dados reais de fps e web vitals
