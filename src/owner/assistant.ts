import { generateText, stepCountIs, tool, type ModelMessage } from 'ai';
import { z } from 'zod';
import { fill, loadPrompt } from '../agents/prompts.js';
import { decideApproval } from '../approvals/approvals.js';
import { sendDocument, sendText } from '../channels/whatsapp/evolution.js';
import { stripEmojis } from '../channels/whatsapp/format.js';
import { deliver } from '../delivery.js';
import { findWaThread, getThread, saveOutbound } from '../domain/repo.js';
import { one, q } from '../lib/db.js';
import { centralInstance, env, instanceRole, instanceRoles, personaFor } from '../lib/env.js';
import { addCost, costToday, costUsd, withFallback } from '../lib/llm.js';
import { logger } from '../lib/logger.js';
import { normalizePhone } from '../lib/phone.js';
import { keys, redis } from '../lib/redis.js';
import { TAKEOVER_SECONDS } from '../takeover.js';
import { fence, nowLabel } from '../lib/util.js';
import { statusText } from '../sentinela/commands.js';
import { costSummary, formatCosts } from '../sentinela/costs.js';
import { ack } from '../sentinela/incidents.js';
import { brl, clienteLinha, dia, gk, gkBuscar, gkEnabled, gkClientes, gkCobrancasMes, gkHistorico, type GkProduto } from '../integrations/gk.js';
import { catalogo, COMO_PEDIR, girakids, girakidsLogado, produtoLinha } from '../integrations/girakids.js';
import { fecharPedido, fecharPedidoPrimeplush, mandarOrcamentoAoCliente, montarOrcamento, numeroVendedor } from '../integrations/vendas.js';
import { catalogoPrimeplush, orcarPrimeplush, produtoLinhaPp, relatorioPrimeplush } from '../integrations/primeplush.js';
import { acharMaquinas, desfazerFechamento, enviarCredito, fecharMaquina, pdfExtratoMaquina, listarMaquinas, PLATAFORMAS, plataformasLigadas, statusMaquina, type Plataforma } from '../integrations/maquinas.js';
import { acharLoja, agarramais, agarramaisLigada, lojas } from '../integrations/agarramais.js';
import { consultarCompactPay } from '../integrations/plataformas/compactPayService.js';
import { ROTAS_SISTEMAS } from '../integrations/rotas-sistemas.js';
import { addItem, fmtWhen, itemLine, listItems, parseLocal, remindersText, removeItem, resolveInstance, updateItem } from './agenda.js';

/**
 * IA central: o orquestrador. Conversa so com o dono, pelo numero da IA (papel CENTRAL)
 * ou pela conversa "Voce" do numero pessoal dele. Le tudo e executa o que ele mandar.
 */

// v2: comeca limpo (o historico antigo ensinava a pedir confirmacao e perguntar de qual numero mandar)
const HISTORY_KEY = 'owner-chat:v2';

/** owner: o numero pessoal de quem pediu (ex.: 'leo'), quando veio pelo Maestro */
type Where = { instance: string; to: string; owner?: string };

/** Onde responder: no numero da IA (central) ou na propria conversa "Voce". */
export function ownerReplyTarget(cameFrom: 'central' | 'self', selfInstance?: string): Where | undefined {
  const phone = normalizePhone(env.GABRIEL_PERSONAL_PHONE);
  if (!phone) return undefined;
  if (cameFrom === 'central') { const c = centralInstance(); return c ? { instance: c, to: phone } : undefined; }
  return selfInstance ? { instance: selfInstance, to: phone } : undefined;
}

async function findThread(search: string) {
  const digits = search.replace(/\D/g, '');
  return q<{ id: string; instance: string; contact: string; phone: string | null; contact_id: string }>(
    `SELECT t.id, t.instance, coalesce(c.name, c.phone, c.email) AS contact, c.phone, c.id AS contact_id FROM threads t JOIN contacts c ON c.id = t.contact_id
      WHERE c.name ILIKE $1 OR ($2 <> '' AND c.phone LIKE '%' || $2 || '%') OR c.email ILIKE $1
      ORDER BY coalesce(t.last_inbound_at, t.updated_at) DESC LIMIT 5`,
    [`%${search}%`, digits.length >= 4 ? digits : ''],
  );
}

/** Quebra textos longos em partes que o WhatsApp aceita bem, sem cortar linhas no meio. */
function splitText(text: string, max = 3500): string[] {
  const parts: string[] = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (cur && cur.length + line.length + 1 > max) { parts.push(cur); cur = ''; }
    cur = cur ? `${cur}\n${line}` : line;
    while (cur.length > max) { parts.push(cur.slice(0, max)); cur = cur.slice(max); }
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

/** Para quem mandar: numero digitado, nome na agenda do celular deste numero (contact_names) ou contato conhecido. */
async function findPerson(instance: string, busca: string): Promise<Array<{ phone: string; name: string }>> {
  const digits = busca.replace(/\D/g, '');
  if (digits.length >= 10) return [{ phone: normalizePhone(digits), name: busca.trim() }];
  const words = busca.trim().split(/\s+/).filter((w) => w.length >= 2).slice(0, 6);
  if (!words.length) return [];
  const all = (col: string) => words.map((_, i) => `${col} ILIKE $${i + 2}`).join(' AND ');
  const rows = await q<{ phone: string; name: string }>(
    `SELECT phone, name FROM (
       SELECT phone, name, 1 AS rank FROM contact_names WHERE instance = $1 AND ${all('name')}
       UNION ALL
       SELECT c.phone, c.name, 2 AS rank FROM contacts c WHERE c.phone IS NOT NULL AND c.name IS NOT NULL AND ${all('c.name')}
     ) x ORDER BY rank LIMIT 30`,
    [instance, ...words.map((w) => `%${w}%`)],
  );
  const byPhone = new Map<string, { phone: string; name: string }>();
  for (const r of rows) { const ph = normalizePhone(r.phone); if (ph && !byPhone.has(ph)) byPhone.set(ph, { phone: ph, name: r.name }); }
  const list = [...byPhone.values()];
  const exact = list.filter((r) => r.name.trim().toLowerCase() === busca.trim().toLowerCase());
  return exact.length === 1 ? exact : list;
}

function tools(log: string[], here: string, where?: Where) {
  const done = (s: string) => { log.push(s); return s; };
  const diasAtras = (n: number) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' }).format(new Date(Date.now() - n * 86400_000));
  const umaMaquina = async (busca: string, plataforma?: string) => {
    const found = (await acharMaquinas(busca, plataforma as Plataforma | undefined)).filter((m) => m.plataforma !== 'compactpay');
    if (!found.length) return { erro: 'Não achei essa máquina na MachinePay nem na Machine Coin.' } as const;
    if (found.length > 1) return { varias: found.slice(0, 10).map((m) => `${PLATAFORMAS[m.plataforma]} · ${m.nome} [${m.id}]${m.cliente ? ` · ${m.cliente}` : ''}`), pedir: 'Pergunte qual delas.' } as const;
    return found[0];
  };
  const mandarPdf = async (m: Awaited<ReturnType<typeof acharMaquinas>>[number], desde: string) => {
    const { pdf, resumo } = await pdfExtratoMaquina(m, desde);
    if (!where) return `PDF gerado, mas sem conversa para mandar (${resumo})`;
    await sendDocument(where.instance, where.to, pdf, `extrato-${m.nome.replace(/[^w-]+/g, '-').toLowerCase()}-${desde}.pdf`, resumo);
    return `PDF do extrato enviado aqui (${resumo})`;
  };
  return {
    visao_geral: tool({
      description: 'Como está tudo agora: aprovações pendentes, incidentes, conversas sem resposta, números de WhatsApp e gasto do dia.',
      inputSchema: z.object({}),
      execute: async () => {
        const [approvals, unanswered, numbers] = await Promise.all([
          q(`SELECT code, action, requested_by FROM pending_approvals WHERE status = 'PENDING' ORDER BY created_at`),
          q(`SELECT coalesce(c.name, c.phone) AS contato, t.instance AS numero, t.last_inbound_at FROM threads t JOIN contacts c ON c.id = t.contact_id
              WHERE t.last_inbound_at > now() - interval '2 days' AND (t.last_outbound_at IS NULL OR t.last_outbound_at < t.last_inbound_at) AND c.role <> 'PESSOAL'
              ORDER BY t.last_inbound_at LIMIT 10`),
          Promise.resolve([...instanceRoles()].map(([n, r]) => `${n} (${r}, ${personaFor(n).name})`)),
        ]);
        return { aprovacoes: approvals, sem_resposta: unanswered, sentinela: await statusText(), numeros: numbers, gasto_ia_hoje_usd: (await costToday()).toFixed(2) };
      },
    }),
    conversas: tool({
      description: 'Lista conversas recentes. filtro: sem_resposta, com_aprovacao ou recentes. numero: nome da instância (opcional).',
      inputSchema: z.object({ filtro: z.enum(['sem_resposta', 'com_aprovacao', 'recentes']), numero: z.string().optional() }),
      execute: async ({ filtro, numero }) => q(
        `SELECT coalesce(c.name, c.phone) AS contato, t.instance AS numero, t.active_agent AS agente, left(lm.content, 100) AS ultima, lm.direction AS de
           FROM threads t JOIN contacts c ON c.id = t.contact_id
           LEFT JOIN LATERAL (SELECT content, direction FROM messages m WHERE m.thread_id = t.id ORDER BY created_at DESC LIMIT 1) lm ON true
          WHERE ($2::text IS NULL OR t.instance = $2)
            AND ($1 <> 'sem_resposta' OR (t.last_inbound_at IS NOT NULL AND (t.last_outbound_at IS NULL OR t.last_outbound_at < t.last_inbound_at)))
            AND ($1 <> 'com_aprovacao' OR EXISTS (SELECT 1 FROM pending_approvals a WHERE a.thread_id = t.id AND a.status = 'PENDING'))
          ORDER BY coalesce(t.last_inbound_at, t.updated_at) DESC LIMIT 10`,
        [filtro, numero ?? null],
      ),
    }),
    ler_conversa: tool({
      description: 'Lê a conversa com um contato (busca por nome ou telefone): resumo, como o dono trata a pessoa e as últimas mensagens.',
      inputSchema: z.object({ busca: z.string().min(2) }),
      execute: async ({ busca }) => {
        const found = await findThread(busca);
        if (!found.length) return { erro: 'Não achei esse contato.' };
        if (found.length > 1 && !found.every((f) => f.contact_id === found[0].contact_id)) return { varios: found.map((f) => `${f.contact} (${f.phone ?? ''}, número ${f.instance})`) };
        const t = found[0];
        const th = await getThread(t.id);
        const msgs = await q<{ direction: string; sender: string | null; content: string; created_at: Date }>(
          `SELECT direction, sender, content, created_at FROM messages WHERE thread_id = $1 AND status NOT IN ('DRAFT_DISCARDED') ORDER BY created_at DESC LIMIT 15`, [t.id],
        );
        return {
          contato: t.contact, numero: t.instance, resumo: th?.summary,
          mensagens: msgs.reverse().map((m) => `${new Date(m.created_at).toLocaleString('pt-BR', { timeZone: env.TIMEZONE, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} ${m.direction === 'INBOUND' ? 'CONTATO' : m.sender === 'HUMAN' ? 'VOCÊ' : `IA (${m.sender})`}: ${m.content.replace(/^⁣/, '').slice(0, 300)}`),
        };
      },
    }),
    decidir_aprovacao: tool({
      description: 'Aprova, recusa ou envia um texto próprio para uma aprovação pendente (código tipo A-0003).',
      inputSchema: z.object({ codigo: z.string(), decisao: z.enum(['aprovar', 'recusar', 'editar']), texto: z.string().optional() }),
      execute: async ({ codigo, decisao, texto }) => {
        const a = await one<{ id: string }>(`SELECT id FROM pending_approvals WHERE code = $1`, [codigo.toUpperCase().replace(/^#/, '')]);
        if (!a) return { erro: 'Não achei essa aprovação.' };
        try {
          const st = await decideApproval(a.id, decisao === 'aprovar' ? 'APPROVE' : decisao === 'recusar' ? 'REJECT' : 'EDIT', texto);
          return { ok: done(`aprovação ${codigo}: ${st}`) };
        } catch (e: any) { return { erro: e.message }; }
      },
    }),
    enviar_mensagem: tool({
      description: 'Manda mensagem DO WHATSAPP DO PRÓPRIO DONO que está falando com você (nunca de outro número) para uma pessoa. para = nome como está salvo na agenda do celular dele, nome do contato ou o número de telefone. texto = a mensagem final que a pessoa vai ler (se ele ditou, igual ao ditado). Texto longo (ex.: lista de máquinas) vai inteiro: o envio divide em partes sozinho. arquivo_conteudo (opcional) manda junto um arquivo .txt com esse conteúdo.',
      inputSchema: z.object({
        para: z.string().min(2),
        texto: z.string().min(1).max(30000),
        arquivo_nome: z.string().max(80).optional(),
        arquivo_conteudo: z.string().max(300000).optional(),
      }),
      execute: async ({ para, texto, arquivo_nome, arquivo_conteudo }) => {
        const found = await findPerson(here, para);
        if (!found.length) return { erro: `Não achei "${para}" na agenda do seu celular nem nos contatos. Nada foi enviado. Peça o número.` };
        if (found.length > 1) return { varios: found.slice(0, 8).map((f) => `${f.name} (${f.phone})`), pedir: 'Nada foi enviado. Pergunte qual deles.' };
        const { phone, name } = found[0];
        const parts = splitText(texto);
        let sent = 0;
        try {
          for (const part of parts) { await sendText(here, phone, part); sent++; }
          if (arquivo_conteudo) await sendDocument(here, phone, Buffer.from(arquivo_conteudo, 'utf8'), (arquivo_nome || 'lista').replace(/\.txt$/i, '') + '.txt', '', 'text/plain');
        } catch (e: any) {
          logger.warn({ err: String(e), here, phone }, 'envio do dono falhou');
          return { erro: `O WhatsApp não enviou${sent ? ` (só ${sent} de ${parts.length} partes saíram${arquivo_conteudo ? ', o arquivo não' : ''})` : ' (nada saiu)'}: ${String(e.message).slice(0, 150)}` };
        }
        // fica registrado na conversa daquele contato, e a IA de la fica quieta (foi voce que falou)
        const th = await findWaThread(here, `${phone}@s.whatsapp.net`).catch(() => undefined);
        if (th) {
          await redis.set(keys.takeover(th.id), '1', 'EX', TAKEOVER_SECONDS);
          await saveOutbound(th.id, texto, 'HUMAN', 'SENT').catch(() => undefined);
        }
        return { ok: done(`enviado do seu WhatsApp (número ${here}) para ${name} (${phone})${parts.length > 1 ? ` em ${parts.length} mensagens` : ''}${arquivo_conteudo ? ' + arquivo' : ''}`) };
      },
    }),
    ligar_ia_contato: tool({
      description: 'Liga ou desliga a IA para um contato (em todos os números em que ele conversa, ou só no número informado). responder_sozinha=true faz a resposta sair sem rascunho.',
      inputSchema: z.object({ busca: z.string().min(2), ligar: z.boolean(), responder_sozinha: z.boolean().optional(), numero: z.string().optional() }),
      execute: async ({ busca, ligar, responder_sozinha, numero }) => {
        let found = await findThread(busca);
        if (numero) found = found.filter((f) => f.instance === numero);
        if (!found.length) return { erro: 'Não achei esse contato.' };
        if (!found.every((f) => f.contact_id === found[0].contact_id)) return { varios: found.map((f) => `${f.contact} (número ${f.instance})`) };
        await q(`UPDATE threads SET ai_enabled = $2, ai_auto = $3 WHERE id = ANY($1::uuid[])`, [found.map((f) => f.id), ligar, ligar && !!responder_sozinha]);
        return { ok: done(`${found[0].contact}: IA ${ligar ? (responder_sozinha ? 'ligada, respondendo sozinha' : 'ligada, em rascunho') : 'desligada'} (${found.map((f) => f.instance).join(', ')})`) };
      },
    }),
    reconhecer_incidente: tool({
      description: 'Marca um incidente do Sentinela como reconhecido (número do incidente, ex.: 42).',
      inputSchema: z.object({ numero: z.number().int() }),
      execute: async ({ numero }) => ((await ack(numero, 'Gabriel (central)')) ? { ok: done(`incidente #I-${numero} reconhecido`) } : { erro: 'Não achei esse incidente aberto.' }),
    }),
    custos: tool({
      description: 'Gasto do mês, projeção e por provedor.',
      inputSchema: z.object({}),
      execute: async () => formatCosts(await costSummary()),
    }),

    // ------------------------------------------------------------ Grupo GK: mensalidades MachinePay e CompactPay
    gk_clientes: tool({
      description: 'Clientes da MachinePay e/ou CompactPay no Grupo GK com mensalidade, máquinas e situação (em dia, em aberto, atrasado). Use para "quem está atrasado?", "quantos clientes ativos?", "quanto tenho a receber?".',
      inputSchema: z.object({ produto: z.enum(['machinepay', 'compactpay', 'ambos']).default('ambos'), filtro: z.enum(['atrasados', 'em_aberto', 'todos']).default('todos'), busca: z.string().optional() }),
      execute: async ({ produto, filtro, busca }) => {
        const prods: GkProduto[] = produto === 'ambos' ? ['machinepay', 'compactpay'] : [produto];
        let list = busca ? await gkBuscar(busca, prods) : (await Promise.all(prods.map((p) => gkClientes(p)))).flat();
        list = list.filter((c) => c.status !== 'INATIVO' || busca);
        if (filtro === 'atrasados') list = list.filter((c) => Number(c.valorAtrasado ?? 0) > 0);
        if (filtro === 'em_aberto') list = list.filter((c) => Number(c.valorEmAberto ?? 0) > 0);
        const soma = (k: 'valorAtrasado' | 'valorEmAberto' | 'valorCalculado') => brl(list.reduce((s, c) => s + Number(c[k] ?? 0), 0));
        return {
          total: list.length, mensalidades_somadas: soma('valorCalculado'), em_aberto: soma('valorEmAberto'), atrasado: soma('valorAtrasado'),
          clientes: list.sort((a, b) => Number(b.valorAtrasado ?? 0) - Number(a.valorAtrasado ?? 0)).slice(0, 25).map(clienteLinha),
        };
      },
    }),
    gk_cliente: tool({
      description: 'Ficha de um cliente MachinePay/CompactPay (por nome, CNPJ/CPF ou telefone): mensalidade, máquinas e as últimas cobranças (mês, valor, vencimento, pago ou não, PIX).',
      inputSchema: z.object({ busca: z.string().min(2) }),
      execute: async ({ busca }) => {
        const found = await gkBuscar(busca);
        if (!found.length) return { erro: 'Não achei esse cliente no Grupo GK.' };
        if (found.length > 1 && !found.some((c) => c.nome.toLowerCase() === busca.toLowerCase())) return { varios: found.slice(0, 10).map(clienteLinha) };
        const c = found.find((x) => x.nome.toLowerCase() === busca.toLowerCase()) ?? found[0];
        const h = await gkHistorico(c.produto as GkProduto, c.id);
        return {
          cliente: clienteLinha(c), telefone: c.telefone ?? undefined, documento: c.documento ?? undefined,
          cobrancas: h.cobrancas.slice(0, 8).map((x) => `${x.competencia}: ${brl(x.valorMes ?? x.valor)} · vence ${dia(x.vencimento)} · ${x.situacao}${x.pagoEm ? ` (pago ${dia(x.pagoEm)})` : ''}`),
          pix_em_aberto: h.cobrancas.find((x) => (x.situacao === 'PENDENTE' || x.situacao === 'ATRASADO') && x.pixCopiaCola)?.pixCopiaCola ?? undefined,
        };
      },
    }),
    gk_cobrancas_mes: tool({
      description: 'Resumo das cobranças de um mês (competência AAAA-MM) da MachinePay ou CompactPay: previsto, recebido, em aberto, atrasado e quantidades.',
      inputSchema: z.object({ produto: z.enum(['machinepay', 'compactpay']), competencia: z.string().regex(/^\d{4}-\d{2}$/).optional() }),
      execute: async ({ produto, competencia }) => {
        const comp = competencia ?? new Intl.DateTimeFormat('en-CA', { timeZone: env.TIMEZONE }).format(new Date()).slice(0, 7);
        const r = await gkCobrancasMes(produto, comp);
        const s = r.resumo ?? {};
        return { competencia: comp, previsto: brl(s.previsto), recebido: brl(s.recebido), em_aberto: brl(s.emAberto), atrasado: brl(s.atrasado), pagas: s.qtdPagas, pendentes: s.qtdPendentes, atrasadas: s.qtdAtrasadas, maquinas: s.maquinas };
      },
    }),

    // ------------------------------------------------------------ Girakids: catalogo, vendas e boletos
    girakids_catalogo: tool({
      description: 'Catálogo da Girakids: produtos, preço por unidade e por pacote, estoque e como fazer o pedido.',
      inputSchema: z.object({ busca: z.string().optional(), categoria: z.string().optional() }),
      execute: async ({ busca, categoria }) => {
        const r = await catalogo({ busca, categoria });
        return { produtos: r.produtos.slice(0, 20).map(produtoLinha), total: r.total, categorias: !busca && !categoria ? (r.categorias ?? []).map((c: any) => c.nome ?? c.categoria) : undefined, como_pedir: COMO_PEDIR };
      },
    }),
    girakids_vendas: tool({
      description: 'Vendas da Girakids num período (AAAA-MM-DD; padrão: do dia 1 até hoje): total vendido, recebido, em aberto, boletos, ticket médio, produtos que mais saíram (pacotes e receita), produtos com MAIOR MARGEM de lucro (% e R$) e os que mais deram LUCRO em reais. Use para qualquer pergunta de margem ou lucro por produto.',
      inputSchema: z.object({ inicio: z.string().optional(), fim: z.string().optional() }),
      execute: async ({ inicio, fim }) => {
        const qs = new URLSearchParams({ ...(inicio && { inicio }), ...(fim && { fim }) });
        const r: any = await girakids(`/dashboard/resumo?${qs}`);
        const card = (k: string) => r.cards?.[k] ? `${r.cards[k].pedidos} pedidos, ${brl(r.cards[k].bruta)}` : '-';
        return {
          periodo: r.periodo, vendido: card('total'), recebido: card('recebida'), em_aberto: card('aberto'), boletos: card('boletos'), aguardando: card('aguardando'),
          ticket_medio: r.extras?.ticketMedio != null ? brl(r.extras.ticketMedio) : undefined,
          mais_vendidos: (r.topQuantidade ?? []).slice(0, 5).map((p: any) => `${p.nome}: ${p.pacotes} pacotes, receita ${brl(p.receita)}, lucro ${brl(p.lucro)} (${p.margemPercentual}%)`),
          maior_margem: (r.topMargem ?? []).slice(0, 5).map((p: any) => `${p.nome}: margem ${p.margemPercentual}%, lucro ${brl(p.lucro)} em ${p.pacotes} pacotes`),
          mais_lucro_em_reais: [...(r.topMargem ?? [])].sort((a: any, b: any) => b.lucro - a.lucro).slice(0, 5).map((p: any) => `${p.nome}: lucro ${brl(p.lucro)} (${p.margemPercentual}%)`),
          obs_margem: 'Margem só dos produtos com custo cadastrado.',
        };
      },
    }),
    girakids_boletos: tool({
      description: 'Boletos/parcelas em aberto da Girakids (quem deve, valor, vencimento, vencidos). Período opcional (AAAA-MM-DD).',
      inputSchema: z.object({ inicio: z.string().optional(), fim: z.string().optional() }),
      execute: async ({ inicio, fim }) => {
        const qs = new URLSearchParams({ por: 'vencimento', ...(inicio && { inicio }), ...(fim && { fim }) });
        const r: any = await girakids(`/dashboard/boletos?${qs}`);
        return {
          total: r.total != null ? brl(r.total) : undefined, vencidos: r.vencidos,
          linhas: (r.linhas ?? []).slice(0, 20).map((l: any) => `${l.clienteNome} · pedido ${l.numero} · ${brl(l.valor)} · vence ${dia(l.vencimento)}${l.vencido ? ' (VENCIDO)' : ''}`),
        };
      },
    }),

    girakids_orcamento: tool({
      description: `Monta um orçamento na Girakids a pedido do dono (ele está pedindo para tirar um pedido para um cliente).
itens: produto = SKU ou nome do catálogo (confira com girakids_catalogo) e pacotes = quantidade de PACOTES.
cliente: nome e telefone; CPF/CNPJ e endereço se ele disser (para virar pedido o CPF/CNPJ é obrigatório).
entrega: RETIRAR_LOCAL, TRANSPORTADORA, PAC ou SEDEX. pagamento: PIX_ONLINE, CREDITO_LINK, BOLETO, TRANSFERENCIA ou A_DEFINIR.
mandar_para_cliente: true manda o resumo ao cliente pelo WhatsApp do João (o vendedor). Mostre o resumo ao dono e pergunte se fecha o pedido.`,
      inputSchema: z.object({
        itens: z.array(z.object({ produto: z.string().min(1), pacotes: z.number().int().min(1) })).min(1),
        cliente: z.object({ nome: z.string().min(2), telefone: z.string().optional(), documento: z.string().optional(), email: z.string().optional(), cep: z.string().optional(), rua: z.string().optional(), numero: z.string().optional(), complemento: z.string().optional(), bairro: z.string().optional(), cidade: z.string().optional(), estado: z.string().optional() }),
        entrega: z.enum(['RETIRAR_LOCAL', 'TRANSPORTADORA', 'PAC', 'SEDEX']).optional(),
        pagamento: z.enum(['PIX_ONLINE', 'CREDITO_LINK', 'BOLETO', 'TRANSFERENCIA', 'A_DEFINIR']).optional(),
        observacoes: z.string().max(500).optional(),
        mandar_para_cliente: z.boolean().optional(),
      }),
      execute: async ({ itens, cliente, entrega, pagamento, observacoes, mandar_para_cliente }) => {
        const r = await montarOrcamento({ itens, cliente, entrega, pagamento, observacoes, via: `pedido de ${personaFor(here).name}` });
        if ('erro' in r) return r;
        let enviado = '';
        if (mandar_para_cliente) {
          const vendedor = numeroVendedor();
          const tel = (cliente.telefone ?? '').replace(/\D/g, '');
          if (!vendedor || tel.length < 10) enviado = 'não mandei ao cliente: falta o telefone dele ou o número do João';
          else {
            await mandarOrcamentoAoCliente({ vendedor, telefone: tel.startsWith('55') ? tel : `55${tel}`, nome: cliente.nome, resumo: r.resumo, orcamentoId: r.orcamento.id });
            enviado = `mandado ao cliente pelo WhatsApp de ${personaFor(vendedor).name}`;
          }
        }
        return { ok: done(`orçamento criado: ${r.resumo}${enviado ? ` · ${enviado}` : ''}`), orcamento_id: r.orcamento.id, proximo: 'Pergunte ao dono se fecha o pedido; só então use girakids_fechar_pedido.' };
      },
    }),
    girakids_fechar_pedido: tool({
      description: 'Transforma o orçamento da Girakids em PEDIDO (quando o dono mandar fechar ou disser que o cliente aprovou) e avisa o comercial no WhatsApp cadastrado.',
      inputSchema: z.object({ orcamento_id: z.string().min(8), cliente_nome: z.string().optional(), telefone_cliente: z.string().optional().describe('com o telefone, o João manda o PDF do pedido ao cliente') }),
      execute: async ({ orcamento_id, cliente_nome, telefone_cliente }) => {
        const tel = (telefone_cliente ?? '').replace(/\D/g, '');
        const r = await fecharPedido(orcamento_id, { instance: numeroVendedor(), cliente: cliente_nome, telefone: tel.length >= 10 ? (tel.startsWith('55') ? tel : `55${tel}`) : undefined });
        return { ok: done(`pedido gerado: ${r.resumo}${r.pdf ? ` · ${r.pdf}` : ''}`) };
      },
    }),

    // ------------------------------------------------------------ PrimePlush (pelucias)
    primeplush_catalogo: tool({
      description: 'Catálogo da PrimePlush (loja de pelúcias): preço por unidade e estoque. Busca por nome ou categoria.',
      inputSchema: z.object({ busca: z.string().optional(), categoria: z.string().optional() }),
      execute: async ({ busca, categoria }) => {
        const r = await catalogoPrimeplush(busca, categoria);
        return { total: r.length, produtos: r.slice(0, 30).map(produtoLinhaPp) };
      },
    }),
    primeplush_vendas: tool({
      description: 'Relatório da PrimePlush no período: faturamento, pedidos, cancelados, ticket médio, mais vendidos, alertas de estoque e quanto falta pagar à Girakids. Sem datas: mês atual.',
      inputSchema: z.object({ inicio: z.string().optional().describe('AAAA-MM-DD'), fim: z.string().optional().describe('AAAA-MM-DD') }),
      execute: async ({ inicio, fim }) => {
        const now = new Date();
        const ini = inicio ? new Date(`${inicio}T00:00:00-03:00`) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 3));
        const end = fim ? new Date(`${fim}T23:59:59-03:00`) : now;
        return relatorioPrimeplush(ini, end);
      },
    }),
    primeplush_pedido: tool({
      description: `Orçamento e pedido na PrimePlush a pedido do dono. itens: produto = nome do catálogo, quantidade = unidades.
fechar=false (padrão): só calcula o orçamento e mostra ao dono. fechar=true: cria o pedido (precisa nome e CPF/CNPJ do cliente) e, com o telefone do cliente, o João manda o PDF do pedido a ele.`,
      inputSchema: z.object({
        itens: z.array(z.object({ produto: z.string().min(1), quantidade: z.number().int().min(1) })).min(1),
        fechar: z.boolean().default(false),
        cliente_nome: z.string().optional(), documento: z.string().optional(), telefone_cliente: z.string().optional(),
        pagamento: z.enum(['pix', 'credit', 'debit', 'cash', 'boleto']).optional(), observacao: z.string().max(300).optional(),
      }),
      execute: async ({ itens, fechar, cliente_nome, documento, telefone_cliente, pagamento, observacao }) => {
        const orc = await orcarPrimeplush(itens);
        if ('erro' in orc) return orc;
        if (!fechar) return { orcamento: orc.resumo, proximo: 'Mostre ao dono e pergunte se fecha; para fechar precisa do nome e CPF/CNPJ do cliente.' };
        if (!cliente_nome || !documento) return { erro: 'Para fechar o pedido preciso do nome completo e do CPF ou CNPJ do cliente.' };
        const tel = (telefone_cliente ?? '').replace(/\D/g, '');
        const r = await fecharPedidoPrimeplush(orc, { nome: cliente_nome, documento, pagamento, observacao }, { instance: numeroVendedor(), telefone: tel.length >= 10 ? (tel.startsWith('55') ? tel : `55${tel}`) : undefined });
        return { ok: done(`${r.resumo}${r.pdf ? ` · ${r.pdf}` : ''}`) };
      },
    }),

    // ------------------------------------------------------------ maquinas: MachinePay, Machine Coin e CompactPay
    maquinas_listar: tool({
      description: 'Lista as máquinas da MachinePay, Machine Coin e/ou CompactPay com online/offline, cliente, vendas de hoje e última venda. Use para "quais máquinas estão offline?", "máquinas do cliente X", "quanto vendeu hoje na CompactPay".',
      inputSchema: z.object({ plataforma: z.enum(['machinepay', 'machinecoin', 'compactpay', 'todas']).default('todas'), filtro: z.enum(['offline', 'online', 'todas']).default('todas'), busca: z.string().optional() }),
      execute: async ({ plataforma, filtro, busca }) => {
        const ps = plataforma === 'todas' ? plataformasLigadas() : [plataforma as Plataforma];
        if (!ps.length) return { erro: 'Nenhuma plataforma configurada no Render ainda.' };
        const out: Record<string, unknown> = {};
        for (const p of ps) {
          try {
            let list = busca ? await acharMaquinas(busca, p) : await listarMaquinas(p);
            const total = list.length, off = list.filter((m) => !m.online).length;
            if (filtro !== 'todas') list = list.filter((m) => (filtro === 'online' ? m.online : !m.online));
            out[PLATAFORMAS[p]] = {
              total, offline: off, vendas_hoje: brl(list.reduce((s, m) => s + (m.vendasHoje ?? 0), 0)),
              maquinas: list.slice(0, 30).map((m) => `${m.nome} [${m.id}]${m.cliente ? ` · ${m.cliente}` : ''} · ${m.online ? 'online' : 'OFFLINE'}${m.vendasHoje != null ? ` · hoje ${brl(m.vendasHoje)}` : ''}${m.ultimaVenda ? ` · última venda ${m.ultimaVenda}` : ''}${m.extra ? ` · ${m.extra}` : ''}`),
            };
          } catch (e: any) { out[PLATAFORMAS[p]] = { erro: String(e.message).slice(0, 200) }; }
        }
        return out;
      },
    }),
    maquina_status: tool({
      description: 'Status ao vivo de uma máquina (online/offline, último sinal, última venda, faturamento de hoje). busca = nome, número do caixa/hardware ou cliente.',
      inputSchema: z.object({ busca: z.string().min(1), plataforma: z.enum(['machinepay', 'machinecoin', 'compactpay']).optional() }),
      execute: async ({ busca, plataforma }) => {
        const found = await acharMaquinas(busca, plataforma as Plataforma | undefined);
        if (!found.length) return { erro: 'Não achei essa máquina.' };
        if (found.length > 1) return { varias: found.slice(0, 10).map((m) => `${PLATAFORMAS[m.plataforma]} · ${m.nome} [${m.id}]${m.cliente ? ` · ${m.cliente}` : ''}`) };
        const m = found[0];
        const st = await statusMaquina(m);
        return { maquina: `${PLATAFORMAS[m.plataforma]} · ${m.nome} [${m.id}]${m.cliente ? ` · ${m.cliente}` : ''}`, ...st, faturamentoHoje: st.faturamentoHoje != null ? brl(st.faturamentoHoje) : undefined };
      },
    }),
    maquina_credito: tool({
      description: `Manda CRÉDITO REMOTO (valor em R$, vira jogadas/pulsos) para uma máquina da MachinePay, Machine Coin ou CompactPay.
Antes de mandar, confirme com o dono em uma linha: máquina (nome, número, plataforma) e valor. Só chame com confirmado=true depois que ele disser sim.
Ele pode pedir direto e já confirmado ("manda 5 reais na máquina 123, pode mandar"): aí confirmado=true.`,
      inputSchema: z.object({ busca: z.string().min(1), valor: z.number().positive(), plataforma: z.enum(['machinepay', 'machinecoin', 'compactpay']).optional(), confirmado: z.boolean().default(false) }),
      execute: async ({ busca, valor, plataforma, confirmado }) => {
        const found = await acharMaquinas(busca, plataforma as Plataforma | undefined);
        if (!found.length) return { erro: 'Não achei essa máquina.' };
        if (found.length > 1) return { varias: found.slice(0, 10).map((m) => `${PLATAFORMAS[m.plataforma]} · ${m.nome} [${m.id}]${m.cliente ? ` · ${m.cliente}` : ''}`), pedir: 'Pergunte qual delas.' };
        const m = found[0];
        const alvo = `${brl(valor)} na ${m.nome} [${m.id}] (${PLATAFORMAS[m.plataforma]}${m.cliente ? `, ${m.cliente}` : ''})${m.online ? '' : ' — ATENÇÃO: está offline'}`;
        if (!confirmado) return { confirmar: `Confirma mandar ${alvo}?` };
        const r = await enviarCredito(m, valor);
        return r.ok ? { ok: done(`crédito enviado: ${alvo} · ${r.detalhe}`) } : { erro: `não confirmou o envio: ${r.detalhe}` };
      },
    }),

    // ------------------------------------------------------------ extrato em PDF, fechamento e desfazer (MachinePay e Machine Coin)
    maquina_extrato_pdf: tool({
      description: 'Gera o PDF do extrato de uma máquina da MachinePay ou Machine Coin (pagamentos, bruto, taxas, líquido e comissão) e manda aqui no WhatsApp. desde = AAAA-MM-DD (padrão: últimos 30 dias, como o painel).',
      inputSchema: z.object({ busca: z.string().min(1), plataforma: z.enum(['machinepay', 'machinecoin']).optional(), desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }),
      execute: async ({ busca, plataforma, desde }) => {
        const m = await umaMaquina(busca, plataforma);
        if ('erro' in m || 'varias' in m) return m;
        const r = await mandarPdf(m, desde ?? diasAtras(30));
        return { ok: done(r) };
      },
    }),
    maquina_fechamento: tool({
      description: `Faz o FECHAMENTO de uma máquina da MachinePay ou Machine Coin (igual ao botão do painel): antes manda o PDF do extrato aqui no WhatsApp, depois fecha o período (desde, padrão últimos 30 dias, até agora). As vendas saem do bruto; dá para desfazer com maquina_desfazer_fechamento.
Confirme antes em uma linha (máquina, número, período). Só chame com confirmado=true depois do sim. Se ele já pediu confirmando ("fecha a máquina X, pode fazer"), confirmado=true.`,
      inputSchema: z.object({ busca: z.string().min(1), plataforma: z.enum(['machinepay', 'machinecoin']).optional(), desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), confirmado: z.boolean().default(false) }),
      execute: async ({ busca, plataforma, desde, confirmado }) => {
        const m = await umaMaquina(busca, plataforma);
        if ('erro' in m || 'varias' in m) return m;
        const ini = desde ?? diasAtras(30);
        const alvo = `${m.nome} [${m.id}] (${PLATAFORMAS[m.plataforma]}${m.cliente ? `, ${m.cliente}` : ''}) de ${ini.split('-').reverse().join('/')} até agora`;
        if (!confirmado) return { confirmar: `Confirma o fechamento da ${alvo}? Mando o PDF antes.` };
        const pdf = await mandarPdf(m, ini).catch((e) => `PDF não foi gerado (${String((e as Error).message ?? e).slice(0, 120)})`);
        const r = await fecharMaquina(m, ini);
        return r.ok
          ? { ok: done(`fechamento feito: ${alvo} · bruto antes ${r.bruto_antes ?? '-'} · comissão ${r.comissao} · ${pdf}`), desfazer: 'Se precisar, dá para desfazer com maquina_desfazer_fechamento (mesmo período).' }
          : { erro: `o painel não fechou: ${r.mensagem}`, pdf };
      },
    }),
    maquina_desfazer_fechamento: tool({
      description: 'DESFAZ o fechamento de uma máquina da MachinePay ou Machine Coin: as vendas do período voltam a contar no bruto. desde/ate = AAAA-MM-DD (use o mesmo início do fechamento; padrão últimos 30 dias até amanhã). Confirme antes; confirmado=true depois do sim.',
      inputSchema: z.object({ busca: z.string().min(1), plataforma: z.enum(['machinepay', 'machinecoin']).optional(), desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), ate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), confirmado: z.boolean().default(false) }),
      execute: async ({ busca, plataforma, desde, ate, confirmado }) => {
        const m = await umaMaquina(busca, plataforma);
        if ('erro' in m || 'varias' in m) return m;
        const ini = desde ?? diasAtras(30);
        if (!confirmado) return { confirmar: `Confirma desfazer o fechamento da ${m.nome} [${m.id}] desde ${ini.split('-').reverse().join('/')}?` };
        const r = await desfazerFechamento(m, ini, ate);
        return r.ok ? { ok: done(`fechamento desfeito: ${m.nome} [${m.id}] · ${r.reabertos} pagamentos voltaram a contar`) } : { erro: 'o painel não confirmou o desfazer' };
      },
    }),

    // ------------------------------------------------------------ AgarraMais: faturamento e lojas
    agarramais_faturamento: tool({
      description: 'Faturamento, lucro, custos, fichas, dinheiro e PIX da AgarraMais num período (todas as lojas ou uma). Datas AAAA-MM-DD; padrão: mês atual até hoje. Traz também ranking das lojas.',
      inputSchema: z.object({ inicio: z.string().optional(), fim: z.string().optional(), loja: z.string().optional() }),
      execute: async ({ inicio, fim, loja }) => {
        const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: env.TIMEZONE }).format(new Date());
        const di = inicio ?? `${hoje.slice(0, 8)}01`, df = fim ?? hoje;
        if (loja) {
          const ls = await acharLoja(loja);
          if (!ls.length) return { erro: 'Não achei essa loja.' };
          if (ls.length > 1) return { varias: ls.map((l) => l.nome) };
          const r: any = await agarramais(`/relatorios/dashboard?lojaId=${ls[0].id}&dataInicio=${di}&dataFim=${df}`);
          const t = r.totais ?? {};
          return { loja: ls[0].nome, periodo: `${di} a ${df}`, faturamento: brl(t.faturamento), lucro: brl(t.lucro), custo_total: brl(t.custoTotal), dinheiro: brl(t.dinheiro), pix: brl(t.pix), fichas: t.fichas, saidas: t.saidas,
            maquinas: (r.performanceMaquinas ?? []).slice(0, 10).map((m: any) => `${m.nome ?? m.maquina}: ${brl(m.faturamento ?? m.receita)}`) };
        }
        const [d, r]: any[] = await Promise.all([
          agarramais(`/relatorios/dashboard?dataInicio=${di}&dataFim=${df}`),
          agarramais(`/relatorios/todas-lojas?dataInicio=${di}&dataFim=${df}`).catch(() => ({})),
        ]);
        const t = d.totais ?? {};
        const num = (o: any) => Object.entries(o ?? {}).filter(([k, v]) => typeof v === 'number' && !/id$/i.test(k)).map(([k, v]) => `${k} ${/fichas|quantidade|qtd|saidas/i.test(k) ? v : brl(v as number)}`).join(', ');
        const rank = (r.graficos?.rankingLucroLojas ?? []) as any[];
        return {
          periodo: `${di} a ${df}`, faturamento: brl(t.faturamento), lucro: brl(t.lucro), custo_total: brl(t.custoTotal), custo_produtos: brl(t.custoProdutosTotal),
          taxa_cartao: brl(t.taxaDeCartao), dinheiro: brl(t.dinheiro), pix: brl(t.pix), fichas: t.fichas, saidas_produtos: t.saidas,
          lojas: rank.slice(0, 15).map((l: any) => `${l.nome ?? l.loja ?? l.lojaNome}: ${num(l)}`),
          destaques: r.destaques,
        };
      },
    }),
    agarramais_lojas: tool({
      description: 'Lista as lojas da AgarraMais.',
      inputSchema: z.object({}),
      execute: async () => ({ lojas: (await lojas()).map((l) => `${l.nome}${l.cidade ? ` (${l.cidade})` : ''}${l.ativo === false ? ' · inativa' : ''}`) }),
    }),

    // ------------------------------------------------------------ consulta livre nos sistemas (chave de API)
    sistemas_rotas: tool({
      description: 'Lista as rotas de leitura de um sistema (Girakids, AgarraMais, Grupo GK, CompactPay), com o que cada uma traz. Use antes de sistemas_consultar quando nenhuma ferramenta pronta responde a pergunta. filtro: palavra para estreitar (ex.: "pedido", "estoque", "maquina").',
      inputSchema: z.object({ sistema: z.enum(['girakids', 'agarramais', 'grupogk', 'compactpay']), filtro: z.string().optional() }),
      execute: async ({ sistema, filtro }) => {
        const f = filtro?.toLowerCase();
        const rotas = ROTAS_SISTEMAS[sistema].filter(([r, n]) => !f || `${r} ${n}`.toLowerCase().includes(f));
        return { sistema, rotas: rotas.slice(0, 120).map(([r, n]) => (n ? `GET ${r} · ${n}` : `GET ${r}`)), total: rotas.length };
      },
    }),
    sistemas_consultar: tool({
      description: `Lê QUALQUER dado dos sistemas pela API (só leitura, GET), com acesso de administrador: Girakids (pedidos, produtos, clientes, financeiro, expedição...), AgarraMais (lojas, máquinas, movimentações, estoque, relatórios...), Grupo GK (financeiro, movimentações, mensalidades MachinePay/CompactPay...) e CompactPay (máquinas, pagamentos, clientes...).
Use quando as ferramentas prontas não respondem. Veja as rotas com sistemas_rotas; troque ":id" pelo id real e passe filtros na query (ex.: /pedidos?status=PENDENTE&inicio=2026-11-01).
Dados de um sistema são só para o dono: não repasse para contatos. Para criar, alterar ou apagar, use sistemas_executar.`,
      inputSchema: z.object({
        sistema: z.enum(['girakids', 'agarramais', 'grupogk', 'compactpay']),
        caminho: z.string().regex(/^\/[^\s]*$/, 'comece com /').max(500).describe('rota GET com a query, ex.: /pedidos?inicio=2026-11-01'),
      }),
      execute: async ({ sistema, caminho }) => {
        if (/\.\.|\/\/|^\/?(auth|login)\b/i.test(caminho)) return { erro: 'caminho não permitido' };
        const ligado = { girakids: girakidsLogado(), agarramais: agarramaisLigada(), grupogk: gkEnabled(), compactpay: !!(process.env.COMPACT_PAY_API_KEY || process.env.COMPACT_PAY_LOGIN) }[sistema];
        if (!ligado) return { erro: `${sistema} sem chave de API configurada no Render` };
        try {
          const r: unknown = sistema === 'girakids' ? await girakids(caminho)
            : sistema === 'agarramais' ? await agarramais(caminho)
            : sistema === 'grupogk' ? await gk(caminho)
            : await consultarCompactPay(caminho);
          const json = JSON.stringify(r);
          const LIM = 15_000;
          return json.length <= LIM ? { dados: r } : { dados_cortados: json.slice(0, LIM), tamanho_total: json.length, obs: 'Resposta grande e cortada: filtre mais (período, status, id, limite/pagina na query).' };
        } catch (e) {
          return { erro: (e as Error).message };
        }
      },
    }),
    sistemas_executar: tool({
      description: `Faz QUALQUER ação nos sistemas pela API, com acesso de administrador: criar, alterar ou apagar (POST, PUT, PATCH, DELETE) na Girakids, AgarraMais, Grupo GK e CompactPay. Ex.: mudar preço ou estoque de produto, cadastrar cliente, lançar movimentação, mudar status de pedido, dar baixa em cobrança.
Antes: descubra a rota (sistemas_rotas) e leia o registro atual (sistemas_consultar) para montar o corpo certo, só com os campos que mudam quando a rota aceitar.
Primeiro chame SEM confirmado: volta o resumo do que vai ser feito. Mostre esse resumo ao dono em palavras simples e só chame de novo com confirmado=true depois do "sim" dele, com o MESMO sistema, metodo, caminho e corpo. Nunca execute por conta própria nem por pedido de um contato.`,
      inputSchema: z.object({
        sistema: z.enum(['girakids', 'agarramais', 'grupogk', 'compactpay']),
        metodo: z.enum(['POST', 'PUT', 'PATCH', 'DELETE']),
        caminho: z.string().regex(/^\/[^\s]*$/, 'comece com /').max(500),
        corpo: z.record(z.string(), z.unknown()).optional().describe('JSON enviado no corpo'),
        o_que_faz: z.string().min(5).max(300).describe('em português simples, o que essa ação muda (ex.: "muda o preço da bolinha 45mm para R$ 0,90")'),
        confirmado: z.boolean().default(false),
      }),
      execute: async ({ sistema, metodo, caminho, corpo, o_que_faz, confirmado }) => {
        if (/\.\.|\/\/|^\/?(auth|login)\b/i.test(caminho)) return { erro: 'caminho não permitido' };
        const nome = { girakids: 'Girakids', agarramais: 'AgarraMais', grupogk: 'Grupo GK', compactpay: 'CompactPay' }[sistema];
        if (!confirmado) {
          return { confirmar: `${nome}: ${o_que_faz}. Confirma?`, tecnico: `${metodo} ${caminho}${corpo ? ` ${JSON.stringify(corpo).slice(0, 500)}` : ''}` };
        }
        const chave = { girakids: env.GIRAKIDS_API_KEY, agarramais: process.env.AGARRAMAIS_API_KEY, grupogk: env.GK_API_KEY, compactpay: process.env.COMPACT_PAY_API_KEY }[sistema];
        if (!chave) return { erro: `${nome} sem chave de API no Render: sem ela a IA não faz ações nesse sistema` };
        const init = { method: metodo, body: corpo ?? (metodo === 'DELETE' ? undefined : {}) };
        try {
          const r: unknown = sistema === 'girakids' ? await girakids(caminho, init)
            : sistema === 'agarramais' ? await agarramais(caminho, init)
            : sistema === 'grupogk' ? await gk(caminho, init)
            : await consultarCompactPay(caminho, init);
          logger.info({ sistema, metodo, caminho, o_que_faz }, 'maestro: acao no sistema');
          const json = JSON.stringify(r ?? { ok: true });
          return { feito: true, resposta: json.length <= 4000 ? r ?? { ok: true } : `${json.slice(0, 4000)}…` };
        } catch (e) {
          return { erro: (e as Error).message };
        }
      },
    }),

    // ------------------------------------------------------------ agenda, tarefas e anotacoes
    agenda_criar: tool({
      description: `Marca um compromisso, cria uma tarefa ou guarda uma anotação na agenda de uma IA.
- compromisso: tem dia e hora (quando). Se a pessoa não disse dia/hora, não invente: crie como tarefa (fica pendente e entra no resumo diário).
- tarefa: algo a fazer; pode ter prazo (quando) ou não.
- anotacao: só guardar uma informação.
quando: data/hora LOCAL no formato AAAA-MM-DDTHH:MM (ou só AAAA-MM-DD se for o dia todo), calculada a partir de "agora".
avisar_antes_min: minutos antes para avisar (ex.: [1440, 60] = 1 dia e 1 hora antes; [30] = meia hora). Só passe se a pessoa pediu; o padrão é 1 dia e 1 hora antes.
ia: de quem é a agenda (nome da pessoa ou do número). Sem dizer, é a agenda de quem está falando.`,
      inputSchema: z.object({
        tipo: z.enum(['compromisso', 'tarefa', 'anotacao']),
        titulo: z.string().min(2).max(300),
        quando: z.string().optional(),
        detalhes: z.string().max(2000).optional(),
        avisar_antes_min: z.array(z.number().int().min(0).max(60 * 24 * 30)).optional(),
        ia: z.string().optional(),
      }),
      execute: async ({ tipo, titulo, quando, detalhes, avisar_antes_min, ia }) => {
        const inst = resolveInstance(ia, here);
        if (quando && !parseLocal(quando)) return { erro: 'Data inválida: use AAAA-MM-DDTHH:MM.' };
        const it = await addItem({ instance: inst, kind: tipo === 'compromisso' ? 'evento' : tipo === 'tarefa' ? 'tarefa' : 'nota', title: titulo, notes: detalhes, when: quando, reminders: avisar_antes_min, via: 'whatsapp' });
        const what = it.kind === 'evento' ? 'compromisso marcado' : it.kind === 'tarefa' ? (it.due_at ? 'tarefa com prazo criada' : 'tarefa pendente criada (sem data: entra no resumo diário)') : 'anotação guardada';
        return { ok: done(`${what}: #${it.id} ${it.title}${it.due_at ? ` · ${fmtWhen(it.due_at, it.all_day)}` : ''} · agenda de ${personaFor(inst).name}${it.kind !== 'nota' && it.due_at ? ` · aviso ${remindersText(it.remind_minutes)}` : ''}`) };
      },
    }),
    agenda_listar: tool({
      description: 'Lista compromissos, tarefas e anotações. Use para "o que tenho amanhã?", "minhas tarefas", "o que anotei sobre X". de/ate: AAAA-MM-DD (local).',
      inputSchema: z.object({ de: z.string().optional(), ate: z.string().optional(), tipo: z.enum(['compromisso', 'tarefa', 'anotacao']).optional(), ia: z.string().optional(), todas_as_ias: z.boolean().optional(), incluir_feitas: z.boolean().optional() }),
      execute: async ({ de, ate, tipo, ia, todas_as_ias, incluir_feitas }) => {
        const from = de ? parseLocal(`${de.slice(0, 10)}T00:00`)?.at : undefined;
        const to = ate ? parseLocal(`${ate.slice(0, 10)}T23:59`)?.at : undefined;
        const items = await listItems({ instance: todas_as_ias ? undefined : resolveInstance(ia, here), from, to, includeDone: incluir_feitas, kind: tipo === 'compromisso' ? 'evento' : tipo === 'tarefa' ? 'tarefa' : tipo === 'anotacao' ? 'nota' : undefined });
        if (!items.length) return { itens: 'nada encontrado' };
        return { itens: items.slice(0, 40).map((i) => `${itemLine(i)}${todas_as_ias ? ` (${personaFor(i.instance).name})` : ''}${i.notes ? ` — ${i.notes.slice(0, 120)}` : ''}`) };
      },
    }),
    agenda_alterar: tool({
      description: 'Muda um item da agenda pelo número (#id): data/hora (quando, AAAA-MM-DDTHH:MM; vazio tira a data), título, detalhes, avisos ou marca como feito.',
      inputSchema: z.object({ id: z.number().int(), quando: z.string().nullable().optional(), titulo: z.string().optional(), detalhes: z.string().optional(), avisar_antes_min: z.array(z.number().int().min(0)).optional(), feito: z.boolean().optional() }),
      execute: async ({ id, quando, titulo, detalhes, avisar_antes_min, feito }) => {
        if (quando && !parseLocal(quando)) return { erro: 'Data inválida: use AAAA-MM-DDTHH:MM.' };
        const it = await updateItem(id, { when: quando === undefined ? undefined : quando || null, title: titulo, notes: detalhes, reminders: avisar_antes_min, done: feito,
          ...(quando ? { kind: 'evento' as const } : {}) });
        if (!it) return { erro: 'Não achei esse item.' };
        return { ok: done(`atualizado: ${itemLine(it)}${it.due_at && !it.done_at ? ` · aviso ${remindersText(it.remind_minutes)}` : ''}`) };
      },
    }),
    agenda_apagar: tool({
      description: 'Apaga um item da agenda pelo número (#id). Só quando a pessoa pedir para apagar/cancelar.',
      inputSchema: z.object({ id: z.number().int() }),
      execute: async ({ id }) => { await removeItem(id); return { ok: done(`item #${id} apagado`) }; },
    }),
  };
}

/** Responde o dono. Retorna o texto enviado. */
/** Gabriel, Leo (numeros de pessoa) e o Maestro: tudo, as mesmas ferramentas. Outros numeros (Joao, Suporte): so a agenda deles. */
function allowedTools<T extends Record<string, unknown>>(all: T, full: boolean): T {
  if (full) return all;
  return Object.fromEntries(Object.entries(all).filter(([k]) => k.startsWith('agenda_'))) as T;
}

export async function answerOwner(text: string, where: Where): Promise<string | undefined> {
  const isCentral = where.instance === centralInstance();
  // pelo Maestro: age no numero de quem pediu (Gabriel ou Leo), com historico, agenda e nome dele
  const here = isCentral
    ? (where.owner ?? [...instanceRoles()].find(([n, r]) => r === 'GABRIEL' && n === 'gabriel')?.[0] ?? [...instanceRoles()].find(([, r]) => r === 'GABRIEL')?.[0] ?? where.instance)
    : where.instance;
  const historyKey = `${HISTORY_KEY}:${here}`;
  const history: ModelMessage[] = (await redis.lrange(historyKey, -16, -1)).map((h) => JSON.parse(h));
  const log: string[] = [];
  const owner = personaFor(here).name || 'Gabriel';
  try {
    const r = await withFallback('agent', ({ model }) =>
      generateText({
        model,
        system: fill(loadPrompt('central'), { OWNER: owner, TODAY: nowLabel(env.TIMEZONE) }),
        messages: [...history, { role: 'user', content: fence('mensagem_do_dono', text) }],
        tools: allowedTools(tools(log, here, where), isCentral || instanceRole(here) === 'GABRIEL'),
        stopWhen: stepCountIs(12),
        abortSignal: AbortSignal.timeout(120_000),
        maxRetries: 1,
        providerOptions: { openai: { reasoningEffort: env.LLM_REASONING_EFFORT } },
      }),
      () => log.length === 0,
    );
    await addCost(costUsd(r.modelSpec, r.totalUsage?.inputTokens ?? 0, r.totalUsage?.outputTokens ?? 0));
    const reply = stripEmojis(r.text.trim()) || (log.length ? log.join('\n') : 'Não consegui fazer isso agora. Me pede de novo?');
    await redis.multi()
      .rpush(historyKey, JSON.stringify({ role: 'user', content: text }), JSON.stringify({ role: 'assistant', content: reply }))
      .ltrim(historyKey, -30, -1).expire(historyKey, 3 * 86400).exec();
    for (const bubble of reply.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean).slice(0, 4)) await sendText(where.instance, where.to, bubble);
    return reply;
  } catch (e) {
    logger.error({ err: String(e) }, 'IA central falhou');
    await sendText(where.instance, where.to, 'nao consegui agora, tenta de novo em um minuto').catch(() => undefined);
    return undefined;
  }
}
