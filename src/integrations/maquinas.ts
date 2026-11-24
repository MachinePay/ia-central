import * as cp from './plataformas/compactPayService.js';
import * as mc from './plataformas/machineCoinService.js';
import * as mp from './plataformas/machinePayService.js';
import { parsearPainelMaquinas } from './plataformas/machinePayPainelParser.js';

/**
 * Maquinas das plataformas de pagamento (MachinePay, Machine Coin e CompactPay): lista, status e credito remoto.
 * Os clientes vieram do backend da AgarraMais (que ja faz isso) e usam as mesmas variaveis de ambiente.
 */
export type Plataforma = 'machinepay' | 'machinecoin' | 'compactpay';
export const PLATAFORMAS: Record<Plataforma, string> = { machinepay: 'MachinePay', machinecoin: 'Machine Coin', compactpay: 'CompactPay' };

export const plataformaLigada = (p: Plataforma) =>
  p === 'compactpay' ? !!(process.env.COMPACT_PAY_LOGIN && process.env.COMPACT_PAY_PASSWORD)
  : p === 'machinepay' ? !!(process.env.MACHINE_PAY_LOGIN && process.env.MACHINE_PAY_PASSWORD)
  : !!(process.env.MACHINE_COIN_LOGIN_URL && process.env.MACHINE_COIN_LOGIN && process.env.MACHINE_COIN_PASSWORD);

export const plataformasLigadas = () => (Object.keys(PLATAFORMAS) as Plataforma[]).filter(plataformaLigada);

export type Maquina = {
  plataforma: Plataforma; id: string; nome: string; cliente: string | null; online: boolean;
  vendasHoje: number | null; ultimaVenda: string | null; extra?: string; usr?: string;
};

const cache = new Map<Plataforma, { at: number; list: Maquina[] }>();

// ------------------------------------------------------------------ painel MachinePay / Machine Coin (cyberpix)
const painelBase = (p: Plataforma) => {
  const u = (p === 'machinepay' ? (process.env.MACHINE_PAY_LOGIN_URL || 'https://www.cyberpix.com.br/pix-adesivo-clientes/') : (process.env.MACHINE_COIN_LOGIN_URL || '')).replace(/[#?].*$/, '');
  return u.endsWith('/') ? u : `${u}/`;
};

/** Tela "Clientes" (usuarios.php): o ID e o nome de cada cliente da conta (como o Grupo GK le). */
function parsearClientes(html: string): Array<{ usrId: string; nome: string }> {
  const out = new Map<string, { usrId: string; nome: string }>();
  for (const linha of String(html).split(/<tr[\s>]/i).slice(1)) {
    const usrId = linha.match(/copiarDadosCadastro\((\d+)\)/)?.[1];
    if (!usrId || out.has(usrId)) continue;
    const nome = linha.match(/cliente-empresa\.png[^>]*>\s*<strong>([\s\S]*?)<\/strong>/)?.[1];
    out.set(usrId, { usrId, nome: String(nome ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || `Cliente ${usrId}` });
  }
  return [...out.values()];
}

/**
 * Layout novo do painel (Machine Coin): a coluna de vendas traz "Vendeu Hoje: R$ 5,00 (15:01)" e "Venda Antiga: R$ 5,00 (19/11 13:28)".
 * O leitor da MachinePay nao pega esse bloco: completa a ultima venda por maquina a partir do HTML de cada linha.
 */
function comVendaDeHoje(html: string, rows: any[]): any[] {
  const porCaixa = new Map<string, { hoje?: { valor: number; hora: string }; antiga?: string }>();
  for (const linha of html.split(/<tr[\s>]/i).slice(1)) {
    const pos = linha.match(/Caixa:\s*(\d+)/)?.[1] ?? linha.match(/stats\((\d+)\)/)?.[1];
    if (!pos) continue;
    const h = linha.match(/Vendeu Hoje:\s*R\$\s*([\d.,]+)\s*\((\d{1,2}:\d{2})\)/);
    const a = linha.match(/Venda Antiga:\s*R\$\s*[\d.,]+\s*\(([^)]+)\)/);
    porCaixa.set(pos, { hoje: h ? { valor: Number(h[1].replace(/\./g, '').replace(',', '.')), hora: h[2] } : undefined, antiga: a?.[1] });
  }
  return rows.map((r) => {
    const v = porCaixa.get(String(r.posId));
    if (!v) return r;
    return {
      ...r,
      ultimaVendaHoje: r.ultimaVendaHoje ?? (v.hoje ? { valor: v.hoje.valor, hora: v.hoje.hora } : null),
      ultimaVendaAntiga: v.antiga,
      vendasHojeValor: r.vendasHojeValor || null, // o painel novo nao mostra o total do dia, so a ultima venda
    };
  });
}

/** Entra uma vez e le as maquinas de todos os clientes (5 por vez). Sem clientes, le as maquinas da propria conta. */
async function lerPainelCompleto(p: Plataforma): Promise<any[]> {
  const svc: any = p === 'machinepay' ? mp : mc;
  const { cookies } = await svc.loginMachinePay();
  const base = painelBase(p);
  const get = async (path: string) => {
    const r = await fetch(`${base}${path}`, { headers: { Cookie: cookies, Referer: base, 'X-Requested-With': 'XMLHttpRequest' }, signal: AbortSignal.timeout(60_000) });
    if (!r.ok) throw new Error(`painel respondeu ${r.status} em ${path.split('?')[0]}`);
    return r.text();
  };
  const clientes = parsearClientes(await get('usuarios.php').catch(() => ''));
  if (!clientes.length) return (parsearPainelMaquinas(await get('maquinas.php?acao=maquinas')) ?? []) as any[];
  const all: any[] = [];
  for (let i = 0; i < clientes.length; i += 5) {
    const lote = clientes.slice(i, i + 5);
    const res = await Promise.all(lote.map((c) => get(`maquinas.php?acao=maquinas&usr=${encodeURIComponent(c.usrId)}`).then((h) => comVendaDeHoje(h, (parsearPainelMaquinas(h) ?? []) as any[])).catch(() => [] as any[])));
    res.forEach((rows, k) => rows.forEach((m) => all.push({ ...m, clienteNome: lote[k].nome, usrId: m.usrId ?? lote[k].usrId, clienteUsr: lote[k].usrId })));
  }
  return all;
}

export async function listarMaquinas(p: Plataforma, fresh = false): Promise<Maquina[]> {
  const hit = cache.get(p);
  if (!fresh && hit && Date.now() - hit.at < (p === 'compactpay' ? 2 : 5) * 60_000) return hit.list;
  let list: Maquina[];
  if (p === 'compactpay') {
    const rows: any[] = await cp.listarResumoDiaCompactPay();
    list = rows.map((m) => ({
      plataforma: p, id: String(m.id_hardware), nome: m.nome || `Máquina ${m.id_hardware}`, cliente: m.cliente_nome ?? null,
      online: !!m.status_online, vendasHoje: m.faturamento != null ? Number(m.faturamento) : null,
      ultimaVenda: m.ultimo_pagamento_em ? cp.normalizarDataUtc(m.ultimo_pagamento_em) : null,
      extra: m.status_operacional ? String(m.status_operacional) : undefined,
    }));
  } else {
    const rows = await lerPainelCompleto(p);
    list = rows.map((m) => ({
      plataforma: p, id: String(m.posId ?? m.idPainel ?? ''), nome: m.nomePonto || `Caixa ${m.posId}`, cliente: m.clienteNome ?? m.cliente ?? null,
      online: !!m.online, vendasHoje: m.vendasHojeValor != null ? Number(m.vendasHojeValor) : null,
      ultimaVenda: m.ultimaVendaHoje?.hora ? `hoje ${m.ultimaVendaHoje.hora}${m.ultimaVendaHoje.valor ? ` (R$ ${Number(m.ultimaVendaHoje.valor).toFixed(2).replace('.', ',')})` : ''}`
        : m.ultimaVendaOntem?.hora ? `ontem ${m.ultimaVendaOntem.hora}` : m.ultimaVendaAntiga ? `${m.ultimaVendaAntiga}` : null,
      extra: m.quedasHoje ? `${m.quedasHoje} quedas hoje` : undefined, usr: m.clienteUsr ?? (m.usrId ? String(m.usrId) : undefined),
    }));
  }
  cache.set(p, { at: Date.now(), list });
  return list;
}

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

/** Acha maquinas por id (posId / id_hardware), nome ou cliente, nas plataformas ligadas (ou so na pedida). */
export async function acharMaquinas(busca: string, plataforma?: Plataforma): Promise<Maquina[]> {
  const ps = plataforma ? [plataforma] : plataformasLigadas();
  const all = (await Promise.all(ps.map((p) => listarMaquinas(p).catch(() => [] as Maquina[])))).flat();
  const b = norm(busca);
  const exact = all.filter((m) => m.id === busca.trim() || norm(m.nome) === b);
  if (exact.length) return exact;
  return all.filter((m) => norm(m.nome).includes(b) || norm(m.cliente ?? '').includes(b) || m.id.includes(busca.trim()));
}

/** Status ao vivo de uma maquina. */
export async function statusMaquina(m: Maquina) {
  if (m.plataforma === 'compactpay') {
    const [st, ping] = await Promise.all([cp.consultarStatusCompactPay({ compactPayId: m.id }), cp.verificarOnlineCompactPay({ compactPayId: m.id }).catch(() => undefined)]);
    return { online: ping?.online ?? st.online, ultimoSinal: st.ultimoSinal, ultimaVenda: st.ultimaTransacaoEm, faturamentoHoje: st.faturamentoHoje, status: st.statusOperacional, wifi: st.wifiQualidade };
  }
  const svc = m.plataforma === 'machinepay' ? mp : mc;
  const st: any = await svc.consultarStatusMachinePay({ posId: m.id, usrId: undefined });
  return { online: !!st.online, status: st.status, ultimaVenda: m.ultimaVenda, faturamentoHoje: m.vendasHoje };
}

export const CREDITO_MAX = () => Number(process.env.CREDITO_REMOTO_MAX_REAIS || 50);

/** Credito remoto em R$ (a plataforma converte em pulsos/jogadas). */
export async function enviarCredito(m: Maquina, valor: number) {
  if (!(valor > 0)) throw new Error('Valor precisa ser maior que zero.');
  if (valor > CREDITO_MAX()) throw new Error(`Acima do limite de R$ ${CREDITO_MAX()} por envio (CREDITO_REMOTO_MAX_REAIS).`);
  if (m.plataforma === 'compactpay') {
    const r: any = await cp.enviarCreditoCompactPay({ compactPayId: m.id, valor });
    return { ok: !!r?.ok, detalhe: `${r?.pulsos ?? '?'} pulsos, comando ${r?.command_status ?? 'enviado'}` };
  }
  const svc = m.plataforma === 'machinepay' ? mp : mc;
  const r: any = await svc.enviarCreditosMqttMachinePay({ posId: m.id, creditos: valor });
  return { ok: !!(r?.sucesso ?? r?.ok), detalhe: r?.mensagem ?? (r?.sucesso ? 'enviado' : 'falhou') };
}

// ------------------------------------------------------------------ extrato, PDF, fechamento e desfazer (MachinePay e Machine Coin)
const agoraBr = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()).replace(' ', 'T');
const diaBr = (offsetDias = 0) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' }).format(new Date(Date.now() + offsetDias * 86400_000));
const b64 = (s: string) => encodeURIComponent(Buffer.from(s).toString('base64'));
const brl = (n: number) => `R$ ${Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function soPainel(m: Maquina) {
  if (m.plataforma === 'compactpay') throw new Error('Na CompactPay o fechamento e o extrato não passam por aqui (só MachinePay e Machine Coin).');
}

async function sessaoPainel(p: Plataforma) {
  const svc: any = p === 'machinepay' ? mp : mc;
  const { cookies } = await svc.loginMachinePay();
  const base = painelBase(p);
  const H = { Cookie: cookies, Referer: base, 'X-Requested-With': 'XMLHttpRequest' };
  return { base, H, get: async (path: string) => (await fetch(base + path, { headers: H, signal: AbortSignal.timeout(60_000) })).text() };
}

/** Extrato da maquina desde `inicio` (AAAA-MM-DD) ate agora: pagamentos, totais do painel e a comissao do periodo. */
export async function extratoMaquina(m: Maquina, inicio: string) {
  soPainel(m);
  const svc: any = m.plataforma === 'machinepay' ? mp : mc;
  const fim = agoraBr();
  const [t, s] = await Promise.all([
    svc.consultarTransacoesMachinePay({ posId: m.id, inicio, fim }),
    svc.consultarFechamentoMachinePay({ posId: m.id, inicio, fim }).catch(() => null),
  ]);
  const ses = await sessaoPainel(m.plataforma);
  const chave = process.env[m.plataforma === 'machinepay' ? 'MACHINE_PAY_CHAVE' : 'MACHINE_COIN_CHAVE'] || '';
  const html = await ses.get(`maquinas.php?acao=stats&posid=${m.id}&dataini=${b64(inicio)}&datafim=${b64(fim)}&chave=${encodeURIComponent(chave)}`);
  const comissao = html.match(/id=["']vl_cms["'][^>]*>([^<]*)</)?.[1]?.trim() || 'R$ 0,00';
  return { inicio, fim, transacoes: t.transacoes as any[], quantidade: t.quantidade as number, total: t.total as number, totais: s as any, comissao };
}

/** PDF do extrato (gerado aqui: o painel so imprime pelo navegador). */
export async function pdfExtratoMaquina(m: Maquina, inicio: string): Promise<{ pdf: Buffer; resumo: string }> {
  const e = await extratoMaquina(m, inicio);
  const { default: PDFDocument } = await import('pdfkit');
  const pdf: Buffer = await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const parts: Buffer[] = [];
    doc.on('data', (c: Buffer) => parts.push(c)); doc.on('end', () => resolve(Buffer.concat(parts))); doc.on('error', reject);
    doc.font('Helvetica-Bold').fontSize(16).text(`Extrato ${PLATAFORMAS[m.plataforma]} · ${m.nome}`);
    doc.font('Helvetica').fontSize(10).fillColor('#444').text(`Caixa ${m.id}${m.cliente ? ` · ${m.cliente}` : ''} · de ${e.inicio.split('-').reverse().join('/')} até ${e.fim.slice(0, 10).split('-').reverse().join('/')} ${e.fim.slice(11)}`);
    if (e.totais) doc.text(`PIX ${brl(e.totais.pix)} · Débito ${brl(e.totais.debito)} · Crédito ${brl(e.totais.credito)} · Bruto ${brl(e.totais.brutoComTaxasMp)} · Taxas ${brl(e.totais.taxas)} · Líquido ${brl(e.totais.liquido)} · Comissão ${e.comissao}`);
    doc.moveDown(0.8).fillColor('#111');
    const reais = e.transacoes.filter((x) => x.pagamentoReal);
    doc.font('Courier-Bold').fontSize(7.5).text('Data e hora            Situação                     Meio                        Valor        Taxa        Líquido');
    doc.font('Courier');
    for (const x of reais) {
      const d = x.data ? new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'medium' }).format(new Date(x.data)) : '-';
      doc.text(`${d.padEnd(22)} ${String(x.status || '-').padEnd(28).slice(0, 28)} ${String(x.tipo || '-').slice(0, 24).padEnd(24)} ${brl(x.valor).padStart(11)} ${brl(x.taxa).padStart(10)} ${brl(x.liquido).padStart(11)}`);
    }
    const testes = e.transacoes.length - reais.length;
    doc.moveDown(0.6).font('Helvetica').fontSize(9).fillColor('#666').text(`${reais.length} pagamentos reais · ${testes} créditos manuais ou de teste (fora da soma). Gerado pelo Maestro.`);
    doc.end();
  });
  const resumo = `${m.nome} [${m.id}] de ${e.inicio.split('-').reverse().join('/')} até agora: ${e.totais ? `bruto ${brl(e.totais.brutoComTaxasMp)}, líquido ${brl(e.totais.liquido)}` : `${e.quantidade} pagamentos`}, comissão ${e.comissao}`;
  return { pdf, resumo };
}

/** Fechamento do periodo (igual ao botao "Processar fechamento" do painel). Some do bruto; da para desfazer. */
export async function fecharMaquina(m: Maquina, inicio: string) {
  soPainel(m);
  if (!m.usr) throw new Error('Não achei o cliente dessa máquina no painel.');
  const e = await extratoMaquina(m, inicio);
  const ses = await sessaoPainel(m.plataforma);
  const html = await ses.get(`maquinas.php?acao=fechamento&tipo=maq&dataini=${b64(inicio)}&datafim=${b64(e.fim)}&valor=${b64(e.comissao)}&id=${m.usr}&pos_id=${m.id}`);
  const txt = html.replace(/<[^>]+>/g, ' ');
  const msg = txt.match(/alert\('([^']+)'\)/)?.[1] ?? txt.replace(/\s+/g, ' ').trim().slice(0, 200);
  cache.delete(m.plataforma);
  return { ok: /fechamento\s+conclu/i.test(txt), mensagem: msg, bruto_antes: e.totais ? brl(e.totais.brutoComTaxasMp) : undefined, comissao: e.comissao, periodo: `${inicio} até ${e.fim.replace('T', ' ')}` };
}

/** Desfaz o fechamento do periodo (alterar_situacao.php do painel): as vendas voltam a contar. */
export async function desfazerFechamento(m: Maquina, inicio: string, fim?: string) {
  soPainel(m);
  const ses = await sessaoPainel(m.plataforma);
  const r = await fetch(ses.base + 'alterar_situacao.php', {
    method: 'POST', signal: AbortSignal.timeout(60_000),
    headers: { ...ses.H, 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: new URLSearchParams({ pos_id: m.id, data_ini: inicio, data_fim: fim || diaBr(1) }),
  });
  const j: any = await r.json().catch(() => ({}));
  cache.delete(m.plataforma);
  return { ok: !!j.ok, reabertos: Number(j.afetadas ?? 0) };
}
