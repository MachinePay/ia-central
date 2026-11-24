import { sendText } from '../channels/whatsapp/evolution.js';
import { saveOutbound, upsertContact, upsertThread } from '../domain/repo.js';
import type { InboundEvent } from '../domain/types.js';
import { q } from '../lib/db.js';
import { normalizePhone } from '../lib/phone.js';
import { notifyGabriel } from '../delivery.js';
import { instanceRoles, personaFor, setting } from '../lib/env.js';
import { acharProduto, criarOrcamento, gerarPedido, resumoPedido, type ClientePedido, type ItemPedido, type PedidoResumo } from './girakids.js';

/**
 * Vendas da Girakids: monta orcamento a partir do catalogo e, com o sim, vira pedido e avisa o comercial.
 * Quem vende e o Joao (numero da Girakids); o orquestrador tambem pode, a pedido do Gabriel ou do Leo.
 */
export type Entrega = 'RETIRAR_LOCAL' | 'TRANSPORTADORA' | 'PAC' | 'SEDEX';
export type Pagamento = 'PIX_ONLINE' | 'CREDITO_LINK' | 'BOLETO' | 'TRANSFERENCIA' | 'A_DEFINIR';

export async function montarOrcamento(o: { itens: ItemPedido[]; cliente: ClientePedido; entrega?: Entrega; pagamento?: Pagamento; observacoes?: string; via: string }):
  Promise<{ erro: string; opcoes?: string[] } | { orcamento: PedidoResumo; resumo: string }> {
  const itens: Array<{ produtoId: string; quantidade: number }> = [];
  for (const it of o.itens) {
    const p = await acharProduto(it.produto);
    if (!p) return { erro: `Não achei "${it.produto}" no catálogo da Girakids. Confirme o nome ou o SKU.` };
    if ('varios' in p) return { erro: `"${it.produto}" bate com vários produtos; qual deles?`, opcoes: p.varios };
    if (!p.disponivel) return { erro: `${p.nome} está esgotado.` };
    itens.push({ produtoId: p.id, quantidade: it.pacotes });
  }
  const orcamento = await criarOrcamento({
    itens, cliente: o.cliente, metodoEnvio: o.entrega, formaPagamento: o.pagamento,
    observacoes: `${o.observacoes ? `${o.observacoes} · ` : ''}feito pela IA (${o.via})`,
  });
  return { orcamento, resumo: resumoPedido(orcamento) };
}

/** Numero do vendedor da Girakids (o Joao): o que tem persona Joao, ou a instancia "joao". */
export function numeroVendedor(): string | undefined {
  const roles = [...instanceRoles()].filter(([, r]) => r !== 'OFF' && r !== 'CENTRAL').map(([n]) => n);
  return roles.find((n) => /jo[aã]o/i.test(personaFor(n).name)) ?? roles.find((n) => n === 'joao');
}

/** Orcamento -> pedido e aviso no WhatsApp configurado (ou no "Voce" do numero de quem vendeu). */
export async function fecharPedido(orcamentoId: string, quem: { cliente?: string; instance?: string }): Promise<{ pedido: PedidoResumo; resumo: string }> {
  const pedido = await gerarPedido(orcamentoId);
  const resumo = resumoPedido(pedido);
  const texto = `Pedido novo pela IA${quem.cliente ? ` (${quem.cliente})` : ''}: ${resumo}`;
  const aviso = setting('GIRAKIDS_AVISO_PEDIDOS').replace(/\D/g, '');
  const via = quem.instance ?? numeroVendedor();
  if (aviso && via) await sendText(via, aviso, texto).catch(() => notifyGabriel(texto, via));
  else await notifyGabriel(texto, via);
  return { pedido, resumo };
}

/**
 * Manda o orcamento ao cliente pelo WhatsApp do vendedor e deixa registrado na conversa dele com o cliente
 * (historico + qual e o orcamento), para o Joao fechar quando o cliente responder "pode fechar".
 */
export async function mandarOrcamentoAoCliente(o: { vendedor: string; telefone: string; nome: string; resumo: string; orcamentoId: string }) {
  const phone = normalizePhone(o.telefone);
  const jid = `${phone}@s.whatsapp.net`;
  const text = `Oi ${o.nome.split(' ')[0]}, segue o orçamento: ${o.resumo}. Posso fechar o pedido?`;
  const ev = { channel: 'WHATSAPP', instance: o.vendedor, externalMessageId: `orc:${o.orcamentoId}`, externalThreadId: jid, sender: { phone, jid, name: o.nome }, content: '', media: [], needsMedia: false, metadata: {}, receivedAt: new Date().toISOString() } as InboundEvent;
  const contact = await upsertContact(ev);
  const thread = await upsertThread(ev, contact.id);
  await sendText(o.vendedor, phone, text);
  await saveOutbound(thread.id, text, 'JOAO', 'SENT', {}, `orc:${o.orcamentoId}`);
  await q(`UPDATE app.threads SET facts = jsonb_set(coalesce(facts, '{}'), '{orcamento_girakids}', to_jsonb($2::text)), ai_enabled = true WHERE id = $1`, [thread.id, o.orcamentoId]);
  return thread.id;
}
