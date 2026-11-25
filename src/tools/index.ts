import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { requestApproval, NEUTRAL_REPLY, type ApprovalAction } from '../approvals/approvals.js';
import { notifyGabriel } from '../delivery.js';
import { recentMessages, saveOutbound, setThread } from '../domain/repo.js';
import { sendText } from '../channels/whatsapp/evolution.js';
import type { Agent, Contact, Specialist, Thread } from '../domain/types.js';
import { one, q } from '../lib/db.js';
import { env, setting } from '../lib/env.js';
import { clip } from '../lib/util.js';
import type { Company } from '../memory/context.js';
import { historyText } from '../memory/context.js';
import { searchKnowledge } from '../memory/kb.js';
import { buscarContaCliente, catalogo, COMO_PEDIR, contaLinha, cotarFrete, criarContaCliente, enderecoPorCep, LOJA_URL, loginDe, produtoLinha, type ContaGirakids } from '../integrations/girakids.js';
import { fecharPedido, fecharPedidoPrimeplush, montarOrcamento } from '../integrations/vendas.js';
import { catalogoPrimeplush, orcarPrimeplush, produtoLinhaPp, type OrcamentoPp } from '../integrations/primeplush.js';
import { brl, clienteLinha, dia, gkHistorico, gkPorTelefone, type GkProduto } from '../integrations/gk.js';

/**
 * Contexto da execucao. Identidade (contato, thread) vem SEMPRE daqui, nunca de argumento do modelo:
 * nenhuma tool consegue ler ou alterar dados de outro contato.
 */
export type ToolCtx = {
  thread: Thread;
  contact: Contact;
  agent: Agent;
  companies: Company[];
  log: Array<{ tool: string; input: unknown; output: unknown }>;
  /** textos devolvidos por tools: o verificador de saida aceita valores que aparecem aqui */
  evidence: string[];
  kbConsulted: boolean;
  approvalRequested?: string;
  handoff?: { to: Specialist; reason: string; summary: string };
};

function wrap<I, O>(ctx: ToolCtx, name: string, fn: (input: I) => Promise<O>) {
  return async (input: I): Promise<O | { error: string }> => {
    try {
      const out = await fn(input);
      ctx.log.push({ tool: name, input, output: out });
      ctx.evidence.push(JSON.stringify(out));
      return out;
    } catch (e) {
      const err = { error: `Falha na ferramenta: ${String((e as Error).message ?? e).slice(0, 200)}` };
      ctx.log.push({ tool: name, input, output: err });
      return err;
    }
  };
}

async function approval(ctx: ToolCtx, action: ApprovalAction, payload: Record<string, unknown>, draft: string) {
  const r = await requestApproval({
    threadId: ctx.thread.id, agent: ctx.agent, action, payload, draftReply: draft,
    context: ctx.thread.summary ?? clip(historyText(await recentMessages(ctx.thread.id, 6)), 400),
  });
  ctx.approvalRequested = r.code;
  return { ...r, instruction: `NÃO confirme nada ao cliente. Diga algo neutro e verdadeiro como: "${NEUTRAL_REPLY}"` };
}

const company = (ctx: ToolCtx, slug?: string | null) =>
  ctx.companies.find((c) => c.slug === (slug ?? ctx.thread.company_slug)) ?? (ctx.companies.length === 1 ? ctx.companies[0] : undefined);

// ------------------------------------------------------------------ tools compartilhadas
function shared(ctx: ToolCtx): ToolSet {
  return {
    catalogo_girakids: tool({
      description: 'Catálogo da Girakids AGORA (brinquedos e insumos no atacado para máquinas de grua e vending): produtos, preço por unidade e por pacote, estoque, categorias, e como fazer o pedido. Única fonte válida de preço da Girakids. Sem busca, lista as categorias.',
      inputSchema: z.object({ busca: z.string().max(120).optional(), categoria: z.string().max(100).optional() }),
      execute: wrap(ctx, 'catalogo_girakids', async ({ busca, categoria }) => {
        const r = await catalogo({ busca, categoria });
        return {
          produtos: r.produtos.slice(0, 15).map(produtoLinha),
          total: r.total,
          categorias: !busca && !categoria ? (r.categorias ?? []).map((c: any) => c.nome ?? c.categoria) : undefined,
          loja: `${LOJA_URL}/catalogo`,
          como_pedir: COMO_PEDIR,
          regra: 'Use só estes preços. Fale preço por unidade e o total do pacote. Se o produto não aparecer, diga que vai confirmar com o comercial.',
        };
      }),
    }),
    minha_mensalidade: tool({
      description: 'Situação da mensalidade/cobrança da MachinePay ou CompactPay DESTE cliente (o contato desta conversa, pelo telefone dele): valor, vencimento, se está em dia ou atrasado e o PIX da cobrança em aberto. Nunca serve para consultar outra pessoa.',
      inputSchema: z.object({}),
      execute: wrap(ctx, 'minha_mensalidade', async () => {
        if (!ctx.contact.phone) return { erro: 'Sem telefone deste contato.' };
        const found = await gkPorTelefone(ctx.contact.phone);
        if (!found.length) return { encontrado: false, orientacao: 'Não achei cadastro com este número. Pergunte o nome da empresa ou o CNPJ e use avisar_dono para alguém verificar.' };
        const out = [];
        for (const c of found.slice(0, 2)) {
          const h = await gkHistorico(c.produto as GkProduto, c.id).catch(() => undefined);
          const abertas = (h?.cobrancas ?? []).filter((x) => x.situacao === 'PENDENTE' || x.situacao === 'ATRASADO').slice(0, 3)
            .map((x) => ({ competencia: x.competencia, valor: brl(x.valorMes ?? x.valor), vencimento: dia(x.vencimento), situacao: x.situacao, pix_copia_e_cola: x.pixCopiaCola ?? undefined }));
          out.push({ resumo: clienteLinha(c), em_aberto: abertas });
        }
        return { encontrado: true, clientes: out, regra: 'Informe só a situação deste cliente. Não prometa baixa, desconto nem prazo; se ele disser que já pagou, agradeça e use avisar_dono.' };
      }),
    }),
    request_handoff: tool({
      description: 'Passa a conversa para outro especialista quando o assunto sai da sua alçada. O outro agente assume já nesta resposta.',
      inputSchema: z.object({
        to: z.enum(['JOAO', 'CLARA', 'GABRIEL']),
        reason: z.string().max(200),
        summary: z.string().max(600).describe('o que o próximo agente precisa saber, incluindo o que não perguntar de novo'),
      }),
      execute: wrap(ctx, 'request_handoff', async ({ to, reason, summary }) => {
        if (to === ctx.agent) return { ok: false, note: 'Você já é esse agente; continue atendendo.' };
        ctx.handoff = { to, reason, summary };
        return { ok: true, note: 'Encerre seu turno sem escrever nada ao cliente; o próximo agente se apresenta.' };
      }),
    }),
    report_knowledge_gap: tool({
      description: 'Registra uma pergunta do cliente que a base não responde, para a equipe responder e virar conhecimento.',
      inputSchema: z.object({ question: z.string().max(400) }),
      execute: wrap(ctx, 'report_knowledge_gap', async ({ question }) => {
        await q(`INSERT INTO knowledge_gaps (company_slug, question, thread_id, instance) VALUES ($1, $2, $3, $4)`, [ctx.thread.company_slug, question, ctx.thread.id, ctx.thread.instance]);
        return { ok: true };
      }),
    }),
    avisar_dono: tool({
      description: 'Avisa a pessoa de verdade (dono do número) que este contato precisa de algo que só ela pode fazer: liberar, reiniciar, estornar, verificar uma máquina, mandar algo, decidir. Use sempre que o cliente pedir uma ação. Depois diga ao cliente só que vai averiguar.',
      inputSchema: z.object({
        what: z.string().max(400).describe('o que o contato precisa, em uma frase, com os dados que ele já passou'),
        urgency: z.enum(['LOW', 'MEDIUM', 'HIGH']).default('MEDIUM'),
      }),
      execute: wrap(ctx, 'avisar_dono', async ({ what, urgency }) => {
        // uma vez por conversa a cada 20 min, para nao virar spam
        const key = `avisar-dono:${ctx.thread.id}`;
        const { redis } = await import('../lib/redis.js');
        if (!(await redis.set(key, '1', 'EX', 1200, 'NX'))) return { ok: true, note: 'Já avisado há pouco. Só tranquilize o cliente.' };
        const who = ctx.contact.name ?? ctx.contact.phone ?? ctx.contact.email;
        await notifyGabriel(`${urgency === 'HIGH' ? '🚨' : '🙋'} ${who} (número ${ctx.thread.instance}) precisa de você: ${what}`, ctx.thread.instance).catch(() => undefined);
        return { ok: true, note: 'Avisado. Diga ao cliente só que vai averiguar (sem prometer o que vai ser feito).' };
      }),
    }),
  };
}

// ------------------------------------------------------------------ JOAO
function catalogTool(ctx: ToolCtx) {
  return tool({
    description: 'Consulta produtos, planos, preços de tabela e especificações AGORA. Única fonte válida de preço.',
    inputSchema: z.object({ query: z.string().max(200), company_slug: z.string().nullable().optional() }),
    execute: wrap(ctx, 'get_product_catalog', async ({ query, company_slug }) => {
      const c = company(ctx, company_slug);
      if (c?.catalog_url) {
        const url = new URL(c.catalog_url);
        url.searchParams.set('q', query);
        const token = c.catalog_token_env ? process.env[c.catalog_token_env] : undefined;
        const r = await fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(10_000) });
        if (!r.ok) return { error: `Catálogo indisponível (${r.status}). Não informe preço; ofereça confirmar com a equipe.` };
        const data = await r.json();
        return { fonte: `catálogo ${c.name} (tempo real)`, itens: data };
      }
      const chunks = await searchKnowledge(query, c?.slug ?? null, 6, ['produto', 'politica'], ctx.thread.instance);
      if (!chunks.length) return { itens: [], note: `Sem catálogo para ${c?.name ?? 'esta empresa'}. NÃO informe preço; ${c?.site ? `mande o site ${c.site} ou ` : ''}ofereça confirmar com a equipe.` };
      return { fonte: 'tabela cadastrada', itens: chunks.map((x) => ({ titulo: x.title, conteudo: x.content })) };
    }),
  });
}

function joaoTools(ctx: ToolCtx): ToolSet {
  const facts = () => ((ctx.thread.facts ?? {}) as Record<string, any>);
  const setFact = async (k: string, v: unknown) => {
    ctx.thread.facts = { ...facts(), [k]: v } as any;
    await q(`UPDATE threads SET facts = jsonb_set(coalesce(facts, '{}'), $2::text[], $3::jsonb) WHERE id = $1`, [ctx.thread.id, [k], JSON.stringify(v)]);
  };
  const salvarLogin = async (sistema: 'girakids' | 'primeplush', v: Record<string, unknown>) => {
    ctx.contact.logins = { ...(ctx.contact.logins ?? {}), [sistema]: v } as any;
    await q(`UPDATE contacts SET logins = jsonb_set(coalesce(logins, '{}'), $2::text[], $3::jsonb) WHERE id = $1`, [ctx.contact.id, [sistema], JSON.stringify(v)]);
  };
  return {
    girakids_criar_conta: tool({
      description: `Cria a conta (login) do cliente no site da Girakids quando ele não tem cadastro. Chame com o que já souber da conversa (não peça de novo).
Precisa: nome completo, e-mail, CPF ou CNPJ, CEP e número. Rua, bairro, cidade e estado saem do CEP sozinhos; o telefone é o desta conversa.
Se faltar algo, a ferramenta devolve só o que falta: peça tudo isso numa mensagem só. Depois de criar, o login já fica salvo e confirmado: mande ao cliente o login e a senha provisória.`,
      inputSchema: z.object({ nome: z.string().optional(), email: z.string().optional(), documento: z.string().optional(), cep: z.string().optional(), numero: z.string().optional(), complemento: z.string().optional(), rua: z.string().optional(), bairro: z.string().optional(), cidade: z.string().optional(), estado: z.string().optional() }),
      execute: wrap(ctx, 'girakids_criar_conta', async (d) => {
        const end = d.cep ? await enderecoPorCep(d.cep) : undefined;
        const dados = {
          nome: (d.nome ?? '').trim(), email: (d.email ?? '').trim(), documento: (d.documento ?? '').replace(/\D/g, ''),
          telefone: (ctx.contact.phone ?? '').replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, ''),
          cep: (d.cep ?? '').replace(/\D/g, ''), numero: (d.numero ?? '').trim(), complemento: d.complemento,
          rua: d.rua || end?.rua || '', bairro: d.bairro || end?.bairro || '', cidade: d.cidade || end?.cidade || '', estado: d.estado || end?.estado || '',
        };
        const faltam = [
          !dados.nome.includes(' ') && 'nome completo',
          !/^\S+@\S+\.\S+$/.test(dados.email) && 'e-mail',
          dados.documento.length !== 11 && dados.documento.length !== 14 && 'CPF ou CNPJ',
          dados.cep.length !== 8 && 'CEP',
          !dados.numero && 'número da casa ou empresa',
          dados.cep.length === 8 && !dados.rua && 'rua',
          dados.cep.length === 8 && !dados.bairro && 'bairro',
        ].filter(Boolean);
        if (faltam.length) return { faltam, pergunte: `Peça numa mensagem só: ${faltam.join(', ')}. Não peça o que já tem.` };
        const existentes = await buscarContaCliente(dados.email).catch(() => [] as ContaGirakids[]);
        if (existentes.length) return { erro: `Já existe conta com esse e-mail: ${contaLinha(existentes[0])}. Pergunte se é dele e confirme com login_cliente.`, cliente_id: existentes[0].id };
        const { conta, senha } = await criarContaCliente(dados as any);
        await salvarLogin('girakids', { id: conta.id, email: conta.email, nome: conta.nome, documento: conta.documento ?? null });
        await setFact('login_confirmado_girakids', conta.id);
        // login e senha saem direto pelo sistema (a IA nao escreve senha); no historico a senha fica omitida
        let enviado = false;
        if (ctx.thread.channel === 'WHATSAPP' && ctx.contact.phone) {
          const txt = (s: string) => `Prontinho, criei seu cadastro na Girakids.
Login: ${conta.email}
Senha provisória: ${s}
Dá para trocar a senha no site depois.`;
          await sendText(ctx.thread.instance, ctx.contact.phone, txt(senha)).then(() => { enviado = true; }).catch(() => undefined);
          if (enviado) await saveOutbound(ctx.thread.id, txt('[omitida]'), 'JOAO', 'SENT', {}, `conta:${conta.id}`);
        }
        return { ok: true, conta: contaLinha(conta), login: conta.email, credenciais: enviado ? 'login e senha provisória JÁ FORAM ENVIADOS ao cliente nesta conversa (não repita a senha)' : 'não consegui enviar a senha: avise que o comercial manda o acesso', proximo: 'Siga com o orçamento.' };
      }),
    }),
    login_cliente: tool({
      description: `Login (conta) do cliente no sistema de venda. SEMPRE antes de tirar um pedido:
- acao=ver: mostra o login salvo deste contato. Se tiver, pergunte ao cliente "seu login é X?" antes de fechar o pedido. Se não tiver, já procura a conta pelo telefone desta conversa.
- acao=buscar (girakids): procura a conta por e-mail, CPF/CNPJ ou nome (busca).
- acao=confirmar: quando o cliente confirmar ("sim, é esse"), salva o login. Girakids: cliente_id de uma conta mostrada. PrimePlush: documento (CPF ou CNPJ) e nome.`,
      inputSchema: z.object({ sistema: z.enum(['girakids', 'primeplush']), acao: z.enum(['ver', 'buscar', 'confirmar']), busca: z.string().optional(), cliente_id: z.string().optional(), documento: z.string().optional(), nome: z.string().optional() }),
      execute: wrap(ctx, 'login_cliente', async ({ sistema, acao, busca, cliente_id, documento, nome }) => {
        const salvo = (ctx.contact.logins as any)?.[sistema];
        if (sistema === 'primeplush') {
          if (acao === 'confirmar') {
            const doc = (documento ?? salvo?.documento ?? '').replace(/\D/g, '');
            if (doc.length !== 11 && doc.length !== 14) return { erro: 'Preciso do CPF ou CNPJ do cliente.' };
            await salvarLogin('primeplush', { documento: doc, nome: nome ?? salvo?.nome ?? ctx.contact.name ?? '' });
            await setFact('login_confirmado_primeplush', doc);
            return { ok: true, salvo: `CPF/CNPJ final ${doc.slice(-4)}`, proximo: 'Login confirmado. Pode fechar o pedido.' };
          }
          return salvo
            ? { salvo: `CPF/CNPJ final ${salvo.documento.slice(-4)} (${salvo.nome})`, pergunte: `Antes de fechar, pergunte: "seu login é o ${salvo.documento.length === 14 ? 'CNPJ' : 'CPF'} terminado em ${salvo.documento.slice(-4)}?"` }
            : { salvo: null, pergunte: 'Peça o CPF ou CNPJ e o nome completo do cliente: é o login dele na PrimePlush.' };
        }
        if (acao === 'confirmar') {
          const contas: ContaGirakids[] = facts().contas_girakids ?? [];
          const c = contas.find((x) => x.id === String(cliente_id)) ?? (salvo && (!cliente_id || salvo.id === String(cliente_id)) ? salvo : undefined);
          if (!c) return { erro: 'Essa conta não está entre as encontradas. Busque de novo (acao=buscar).' };
          await salvarLogin('girakids', { id: c.id, email: c.email, nome: c.nome, documento: c.documento ?? null });
          await setFact('login_confirmado_girakids', c.id);
          return { ok: true, salvo: contaLinha(c as ContaGirakids), proximo: 'Login confirmado. Pode montar o orçamento ou fechar o pedido.' };
        }
        if (acao === 'ver' && salvo) return { salvo: contaLinha(salvo), pergunte: `Antes de tirar o pedido, pergunte: "seu login é ${loginDe(salvo)}?" Quando ele confirmar, chame acao=confirmar.` };
        const termo = acao === 'buscar' ? (busca ?? '') : (ctx.contact.phone ?? '').replace(/\D/g, '').slice(-9);
        const contas = termo ? await buscarContaCliente(termo) : [];
        await setFact('contas_girakids', contas.slice(0, 8));
        if (!contas.length) return acao === 'buscar'
          ? { contas: [], resultado: `NÃO EXISTE conta com "${busca}" no site. Não peça esse dado de novo. Diga ao cliente que não achou cadastro e ofereça criar a conta agora: use girakids_criar_conta com o que já tem e peça numa mensagem só o que faltar.` }
          : { contas: [], pergunte: 'Não achei conta pelo telefone. Peça o e-mail de login ou o CPF/CNPJ do cadastro no site (uma vez só) e busque com acao=buscar.' };
        if (contas.length === 1 && acao === 'buscar') return { contas: contas.map(contaLinha), cliente_id: contas[0].id, pergunte: `Achei. Pergunte: "seu cadastro é ${contas[0].nome} (${loginDe(contas[0])})?" Com o sim, chame acao=confirmar com este cliente_id.` };
        return { contas: contas.slice(0, 8).map(contaLinha), pergunte: contas.length === 1 ? `Pergunte: "seu cadastro é ${contas[0].nome} (${loginDe(contas[0])})?"` : 'Pergunte qual é o cadastro dele, mostrando o nome e o login de cada um.' };
      }),
    }),
    girakids_frete: tool({
      description: 'Calcula o frete da Girakids AGORA (PAC, SEDEX, Braspress, retirada grátis na loja) para o CEP e os itens (produto = SKU ou nome do catálogo, pacotes = quantidade de pacotes). Use assim que tiver o CEP; não peça rua e número para cotar.',
      inputSchema: z.object({ cep: z.string().min(8), itens: z.array(z.object({ produto: z.string().min(1), pacotes: z.number().int().min(1) })).min(1) }),
      execute: wrap(ctx, 'girakids_frete', async ({ cep, itens }) => cotarFrete(cep, itens)),
    }),
    girakids_orcamento: tool({
      description: `Monta um ORÇAMENTO no sistema da Girakids (não é pedido ainda). Use quando o cliente (ou o dono) quiser comprar ou pedir preço fechado.
Itens: produto = SKU ou nome exato do catálogo (consulte catalogo_girakids antes) e pacotes = quantidade de PACOTES.
Cliente: nome; telefone (sem dizer, usa o desta conversa); CPF/CNPJ e endereço se já tiver (para virar pedido o CPF/CNPJ é obrigatório).
entrega: RETIRAR_LOCAL, TRANSPORTADORA, PAC ou SEDEX. pagamento: PIX_ONLINE, CREDITO_LINK, BOLETO, TRANSFERENCIA, A_DEFINIR (combinar).
Depois mande ao cliente o resumo (itens, total) e pergunte se aprova. Só gere o pedido com girakids_aprovar_orcamento depois de um "sim/pode fechar/aprovado" claro.`,
      inputSchema: z.object({
        itens: z.array(z.object({ produto: z.string().min(1), pacotes: z.number().int().min(1) })).min(1),
        cliente: z.object({ nome: z.string().min(2), telefone: z.string().optional(), documento: z.string().optional(), email: z.string().optional(), cep: z.string().optional(), rua: z.string().optional(), numero: z.string().optional(), complemento: z.string().optional(), bairro: z.string().optional(), cidade: z.string().optional(), estado: z.string().optional() }),
        entrega: z.enum(['RETIRAR_LOCAL', 'TRANSPORTADORA', 'PAC', 'SEDEX']).optional(),
        pagamento: z.enum(['PIX_ONLINE', 'CREDITO_LINK', 'BOLETO', 'TRANSFERENCIA', 'A_DEFINIR']).optional(),
        observacoes: z.string().max(500).optional(),
      }),
      execute: wrap(ctx, 'girakids_orcamento', async ({ itens, cliente, entrega, pagamento, observacoes }) => {
        const conta = (ctx.contact.logins as any)?.girakids;
        if (!conta) return { erro: 'Antes do orçamento identifique o login do cliente: use login_cliente (sistema girakids, acao ver).' };
        if (!facts().login_confirmado_girakids) return { erro: `Antes do orçamento confirme o cadastro: pergunte "seu login é ${loginDe(conta)}?" e chame login_cliente acao confirmar.` };
        // nome, documento e e-mail vem da conta confirmada (nunca de outra pessoa citada na conversa); endereco pode ser o novo que o cliente passou
        const r = await montarOrcamento({
          itens, entrega, pagamento, observacoes, via: `WhatsApp ${ctx.thread.instance}`, clienteId: conta.id,
          cliente: { ...cliente, nome: conta.nome, documento: conta.documento ?? undefined, email: conta.email && !/sememail/i.test(conta.email) ? conta.email : undefined, telefone: cliente.telefone ?? ctx.contact.phone ?? undefined },
        });
        if ('erro' in r) return r;
        await setFact('orcamento_girakids', r.orcamento.id);
        await setFact('orcamento_girakids_conta', conta.id);
        return { ok: true, orcamento_id: r.orcamento.id, resumo: r.resumo, proximo_passo: 'Mande o resumo ao cliente e pergunte se aprova. Se aprovar, use girakids_aprovar_orcamento.' };
      }),
    }),
    girakids_aprovar_orcamento: tool({
      description: 'Transforma o orçamento da Girakids em PEDIDO e avisa o comercial. Só use depois que o cliente aprovou claramente o resumo nesta conversa. Sem orcamento_id usa o último orçamento desta conversa.',
      inputSchema: z.object({ orcamento_id: z.string().optional() }),
      execute: wrap(ctx, 'girakids_aprovar_orcamento', async ({ orcamento_id }) => {
        const id = orcamento_id ?? (ctx.thread.facts as any)?.orcamento_girakids;
        if (!id) return { erro: 'Não há orçamento nesta conversa. Monte um com girakids_orcamento.' };
        if (!facts().login_confirmado_girakids) { const c = (ctx.contact.logins as any)?.girakids; return { erro: `Antes de tirar o pedido pergunte "seu login é ${c ? loginDe(c) : '(peça o login)'}?" e confirme com login_cliente (acao confirmar).` }; }
        if (!orcamento_id && facts().orcamento_girakids_conta && facts().orcamento_girakids_conta !== facts().login_confirmado_girakids) return { erro: 'Esse orçamento foi feito em outro cadastro. Monte o orçamento de novo (girakids_orcamento) com o login confirmado.' };
        const r = await fecharPedido(id, { cliente: (ctx.contact.logins as any)?.girakids?.nome ?? ctx.contact.name ?? ctx.contact.phone ?? undefined, instance: ctx.thread.instance, telefone: ctx.thread.channel === 'WHATSAPP' ? ctx.contact.phone ?? undefined : undefined });
        await setFact('login_confirmado_girakids', null); // proximo pedido: pergunta o login de novo
        return { ok: true, pedido: r.resumo, pdf: r.pdf, orientacao: `Confirme ao cliente o número do pedido${r.pdf?.startsWith('PDF do pedido enviado') ? ' e diga que mandou o PDF' : ''} e que o comercial segue com pagamento e entrega.` };
      }),
    }),
    catalogo_primeplush: tool({
      description: 'Catálogo da PrimePlush (loja de pelúcias): nome, categoria, preço por unidade e estoque. Busque pelo nome (ex.: "urso", "stitch") ou categoria.',
      inputSchema: z.object({ busca: z.string().optional(), categoria: z.string().optional() }),
      execute: wrap(ctx, 'catalogo_primeplush', async ({ busca, categoria }) => {
        const r = await catalogoPrimeplush(busca, categoria);
        return { total: r.length, produtos: r.slice(0, 25).map(produtoLinhaPp) };
      }),
    }),
    primeplush_orcamento: tool({
      description: `Monta o ORÇAMENTO da PrimePlush com os preços do catálogo (produto = nome do catálogo, quantidade = unidades). Confere o estoque.
Mande ao cliente o resumo com o total e pergunte uma vez "posso fechar o pedido?". A PrimePlush não calcula frete: entrega e pagamento a loja combina.`,
      inputSchema: z.object({ itens: z.array(z.object({ produto: z.string().min(1), quantidade: z.number().int().min(1) })).min(1) }),
      execute: wrap(ctx, 'primeplush_orcamento', async ({ itens }) => {
        const r = await orcarPrimeplush(itens);
        if ('erro' in r) return r;
        await q(`UPDATE threads SET facts = jsonb_set(coalesce(facts, '{}'), '{orcamento_primeplush}', $2::jsonb) WHERE id = $1`, [ctx.thread.id, JSON.stringify(r)]);
        return { ok: true, resumo: r.resumo, proximo_passo: 'Mande o resumo e pergunte se pode fechar. Para fechar precisa do nome completo e CPF ou CNPJ; depois use primeplush_fechar_pedido.' };
      }),
    }),
    primeplush_fechar_pedido: tool({
      description: 'Fecha o PEDIDO na PrimePlush com o último orçamento desta conversa (primeplush_orcamento), avisa a loja e manda o PDF do pedido ao cliente. Só depois de um "sim/pode fechar" claro. Precisa do nome completo e CPF ou CNPJ.',
      inputSchema: z.object({ nome: z.string().min(3), documento: z.string().min(11), pagamento: z.enum(['pix', 'credit', 'debit', 'cash', 'boleto']).optional(), observacao: z.string().max(300).optional() }),
      execute: wrap(ctx, 'primeplush_fechar_pedido', async ({ nome, documento, pagamento, observacao }) => {
        const orc = (ctx.thread.facts as any)?.orcamento_primeplush as OrcamentoPp | undefined;
        if (!orc?.itens?.length) return { erro: 'Não há orçamento da PrimePlush nesta conversa. Monte com primeplush_orcamento.' };
        if (!facts().login_confirmado_primeplush) { const c = (ctx.contact.logins as any)?.primeplush; return { erro: c ? `Antes de fechar pergunte "seu login é o CPF/CNPJ terminado em ${c.documento.slice(-4)}?" e confirme com login_cliente.` : 'Peça CPF ou CNPJ e nome e confirme com login_cliente (sistema primeplush, acao confirmar).' }; }
        const r = await fecharPedidoPrimeplush(orc, { nome, documento, pagamento, observacao }, { instance: ctx.thread.instance, telefone: ctx.thread.channel === 'WHATSAPP' ? ctx.contact.phone ?? undefined : undefined });
        await q(`UPDATE threads SET facts = facts - 'orcamento_primeplush' - 'login_confirmado_primeplush' WHERE id = $1`, [ctx.thread.id]);
        return { ok: true, pedido: r.resumo, pdf: r.pdf, orientacao: `Confirme o pedido ao cliente${r.pdf?.startsWith('PDF do pedido enviado') ? ' e diga que mandou o PDF' : ''}; pagamento e entrega a loja combina.` };
      }),
    }),
    get_product_catalog: catalogTool(ctx),
    create_or_update_lead: tool({
      description: 'Registra o que já se sabe do lead (qualificação). Chame sempre que descobrir algo novo.',
      inputSchema: z.object({
        name: z.string().optional(), company: z.string().optional(), business: z.string().optional(), volume: z.string().optional(),
        pain: z.string().optional(), deadline: z.string().optional(), decision_maker: z.string().optional(), interest: z.string().optional(),
        stage: z.enum(['QUALIFIED', 'PROPOSAL', 'NEGOTIATION']).optional(),
      }),
      execute: wrap(ctx, 'create_or_update_lead', async (i) => {
        await q(
          `INSERT INTO leads (contact_id, business, volume, pain, deadline, decision_maker, interest) VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (contact_id) DO UPDATE SET business = coalesce($2, leads.business), volume = coalesce($3, leads.volume),
             pain = coalesce($4, leads.pain), deadline = coalesce($5, leads.deadline), decision_maker = coalesce($6, leads.decision_maker),
             interest = coalesce($7, leads.interest), updated_at = now()`,
          [ctx.contact.id, i.business ?? null, i.volume ?? null, i.pain ?? null, i.deadline ?? null, i.decision_maker ?? null, i.interest ?? null],
        );
        const order = ['NEW', 'QUALIFIED', 'PROPOSAL', 'NEGOTIATION'];
        const stage = i.stage && order.indexOf(i.stage) > order.indexOf(ctx.contact.crm_stage) ? i.stage : null;
        await q(
          `UPDATE contacts SET name = coalesce(name, $2), company = coalesce($3, company), crm_stage = coalesce($4::app.crm_stage, crm_stage), updated_at = now() WHERE id = $1`,
          [ctx.contact.id, i.name ?? null, i.company ?? null, stage],
        );
        return { ok: true };
      }),
    }),
    schedule_meeting: tool({
      description: 'Pede uma demonstração/reunião. O horário é confirmado pela equipe; não prometa horário fechado.',
      inputSchema: z.object({ topic: z.string().max(200), preferred: z.string().max(200).describe('preferência de dia/horário do cliente') }),
      execute: wrap(ctx, 'schedule_meeting', async ({ topic, preferred }) => {
        await q(`INSERT INTO meetings (contact_id, thread_id, topic, preferred) VALUES ($1, $2, $3, $4)`, [ctx.contact.id, ctx.thread.id, topic, preferred]);
        await notifyGabriel(`📅 Pedido de reunião: ${ctx.contact.name ?? ctx.contact.phone ?? ctx.contact.email} — ${topic} (prefere: ${preferred})`, ctx.thread.instance).catch(() => undefined);
        return { ok: true, note: 'Pedido registrado. Diga que a equipe confirma o horário em breve.' };
      }),
    }),
    create_payment_link: tool({
      description: 'Fecha o pedido. Sempre passa pela aprovação do Gabriel antes de qualquer cobrança.',
      inputSchema: z.object({
        items: z.array(z.object({ description: z.string(), quantity: z.number().int().positive() })).min(1),
        draft_reply: z.string().max(800).describe('mensagem ao cliente se aprovado'),
      }),
      execute: wrap(ctx, 'create_payment_link', async ({ items, draft_reply }) => approval(ctx, 'PAYMENT_LINK', { items }, draft_reply)),
    }),
    apply_discount: tool({
      description: `Aplica desconto. Até ${Number(setting('MAX_AUTO_DISCOUNT_PERCENT'))}% passa direto; acima, vira pedido de aprovação automaticamente.`,
      inputSchema: z.object({
        percent: z.number().min(0).max(100),
        scope: z.string().max(200).describe('sobre o que é o desconto (plano, quantidade)'),
        reason: z.string().max(300),
        draft_reply: z.string().max(800).describe('mensagem ao cliente se aprovado'),
      }),
      execute: wrap(ctx, 'apply_discount', async ({ percent, scope, reason, draft_reply }) => {
        if (percent <= Number(setting('MAX_AUTO_DISCOUNT_PERCENT'))) {
          const facts = { ...(ctx.thread.facts as any) };
          facts.decisoes = [...(facts.decisoes ?? []), { o_que: `desconto de ${percent}% em ${scope}`, quando: new Date().toISOString().slice(0, 10), por: ctx.agent }];
          await setThread(ctx.thread.id, { facts });
          return { applied: true, percent, scope };
        }
        return approval(ctx, 'DISCOUNT', { percent, scope, reason, limite_automatico: Number(setting('MAX_AUTO_DISCOUNT_PERCENT')) }, draft_reply);
      }),
    }),
  };
}

// ------------------------------------------------------------------ CLARA
function claraTools(ctx: ToolCtx): ToolSet {
  return {
    search_knowledge_base: tool({
      description: 'Busca nos manuais, FAQ e procedimentos. Responda SOMENTE com o que os trechos dizem.',
      inputSchema: z.object({ query: z.string().max(300) }),
      execute: wrap(ctx, 'search_knowledge_base', async ({ query }) => {
        ctx.kbConsulted = true;
        const chunks = await searchKnowledge(query, ctx.thread.company_slug, 5, undefined, ctx.thread.instance);
        if (!chunks.length) return { trechos: [], note: 'Nada na base cobre isso. Não invente: diga que vai verificar com a engenharia.' };
        return { trechos: chunks.map((c) => ({ titulo: c.title, origem: c.source, conteudo: c.content })) };
      }),
    }),
    check_customer_status: tool({
      description: 'Situação do cliente desta conversa: cadastro, equipamentos conhecidos, chamados abertos.',
      inputSchema: z.object({}),
      execute: wrap(ctx, 'check_customer_status', async () => {
        const tickets = await q(`SELECT priority, category, summary, status, created_at FROM tickets WHERE contact_id = $1 ORDER BY created_at DESC LIMIT 5`, [ctx.contact.id]);
        return {
          nome: ctx.contact.name, empresa: ctx.contact.company, papel: ctx.contact.role, estagio: ctx.contact.crm_stage, tags: ctx.contact.tags,
          equipamentos: (ctx.thread.facts as any)?.equipamentos ?? [], chamados: tickets,
        };
      }),
    }),
    create_support_ticket: tool({
      description: 'Abre (ou resolve) um chamado com o que já foi testado.',
      inputSchema: z.object({
        priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
        category: z.enum(['HARDWARE', 'SOFTWARE', 'PAGAMENTO', 'ENTREGA']),
        summary: z.string().max(800),
        tested_steps: z.array(z.string()).default([]),
        status: z.enum(['OPEN', 'RESOLVED']).default('OPEN'),
      }),
      execute: wrap(ctx, 'create_support_ticket', async (i) => {
        const t = await one<{ id: string }>(
          `INSERT INTO tickets (contact_id, thread_id, priority, category, summary, tested_steps, status) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [ctx.contact.id, ctx.thread.id, i.priority, i.category, i.summary, JSON.stringify(i.tested_steps), i.status],
        );
        if (i.status === 'OPEN' && (i.priority === 'HIGH' || i.priority === 'CRITICAL')) {
          await notifyGabriel(`🛠️ Chamado ${i.priority} (${i.category}) — ${ctx.contact.name ?? ctx.contact.phone ?? ctx.contact.email}: ${clip(i.summary, 300)}`, ctx.thread.instance).catch(() => undefined);
        }
        return { ok: true, ticket: t?.id.slice(0, 8) };
      }),
    }),
    get_invoice_copy: tool({
      description: 'Segunda via de boleto ou nota fiscal.',
      inputSchema: z.object({ what: z.string().max(200) }),
      execute: wrap(ctx, 'get_invoice_copy', async ({ what }) => {
        await notifyGabriel(`🧾 ${ctx.contact.name ?? ctx.contact.phone ?? ctx.contact.email} pediu segunda via: ${what}`, ctx.thread.instance).catch(() => undefined);
        return { available: false, note: 'Ainda não há integração com o financeiro. Diga que vai averiguar e já te retorna por aqui, sem prometer prazo.' };
      }),
    }),
    request_refund: tool({
      description: 'Reembolso, cancelamento ou troca: sempre vira pedido de aprovação.',
      inputSchema: z.object({ kind: z.enum(['REEMBOLSO', 'CANCELAMENTO', 'TROCA']), details: z.string().max(500), draft_reply: z.string().max(800) }),
      execute: wrap(ctx, 'request_refund', async ({ kind, details, draft_reply }) => approval(ctx, 'REFUND', { kind, details }, draft_reply)),
    }),
  };
}

// ------------------------------------------------------------------ GABRIEL (IA)
function gabrielTools(ctx: ToolCtx): ToolSet {
  return {
    get_full_thread_context: tool({
      description: 'Resumo, fatos, últimas 30 mensagens, chamados e aprovações desta conversa.',
      inputSchema: z.object({}),
      execute: wrap(ctx, 'get_full_thread_context', async () => ({
        resumo: ctx.thread.summary,
        fatos: ctx.thread.facts,
        historico: historyText(await recentMessages(ctx.thread.id, 30)),
        chamados: await q(`SELECT priority, category, summary, status FROM tickets WHERE contact_id = $1 ORDER BY created_at DESC LIMIT 5`, [ctx.contact.id]),
        aprovacoes: await q(`SELECT code, action, status, payload FROM pending_approvals WHERE thread_id = $1 ORDER BY created_at DESC LIMIT 5`, [ctx.thread.id]),
      })),
    }),
    approve_special_condition: tool({
      description: 'Condição especial, prazo de desenvolvimento, contrato ou escopo fechado: cria aprovação pendente para o Gabriel real.',
      inputSchema: z.object({
        type: z.enum(['CUSTOM_TERM', 'CONTRACT', 'DEADLINE', 'DISCOUNT']),
        description: z.string().max(600),
        draft_reply: z.string().max(1000),
      }),
      execute: wrap(ctx, 'approve_special_condition', async ({ type, description, draft_reply }) => approval(ctx, type, { description }, draft_reply)),
    }),
    notify_real_gabriel: tool({
      description: 'Chama o Gabriel em pessoa (cliente estratégico irritado, incidente grave, proposta grande, pedido explícito).',
      inputSchema: z.object({ urgency: z.enum(['LOW', 'MEDIUM', 'HIGH']), summary: z.string().max(600) }),
      execute: wrap(ctx, 'notify_real_gabriel', async ({ urgency, summary }) => {
        await notifyGabriel(`${urgency === 'HIGH' ? '🚨' : '👋'} ${ctx.contact.name ?? ctx.contact.phone ?? ctx.contact.email} precisa de você (${urgency}): ${summary}`, ctx.thread.instance);
        return { ok: true, note: 'Gabriel avisado. Diga que ele vai falar pessoalmente assim que possível, sem prometer horário.' };
      }),
    }),
    schedule_meeting: joaoTools(ctx).schedule_meeting,
    create_support_ticket: claraTools(ctx).create_support_ticket,
    search_knowledge_base: claraTools(ctx).search_knowledge_base,
    get_product_catalog: catalogTool(ctx),
  };
}

export function toolsFor(agent: Specialist, ctx: ToolCtx): ToolSet {
  const specific = agent === 'JOAO' ? joaoTools(ctx) : agent === 'CLARA' ? claraTools(ctx) : gabrielTools(ctx);
  return { ...specific, ...shared(ctx) };
}
