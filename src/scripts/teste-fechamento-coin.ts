/**
 * Teste autorizado pelo dono na Machine Coin, caixa 140297581 (Gira kids machine):
 * 1) le o extrato e gera o PDF; 2) faz o fechamento; 3) desfaz (alterar_situacao.php); 4) confere se voltou igual.
 * Uso: node dist/src/scripts/teste-fechamento-coin.js --confirmar
 */
import PDFDocument from 'pdfkit';
import * as mc from '../integrations/plataformas/machineCoinService.js';

const POS = '140297581';
const INICIO = '2026-10-01';
const log = (s: string) => console.log(`[teste] ${s}`);
if (!process.argv.includes('--confirmar')) { log('falta --confirmar'); process.exit(1); }

const base = (process.env.MACHINE_COIN_LOGIN_URL || '').replace(/[#?].*$/, '').replace(/\/?$/, '/');
const { cookies } = await (mc as any).loginMachinePay();
const H = { Cookie: cookies, Referer: base, 'X-Requested-With': 'XMLHttpRequest' };
const get = async (p: string) => (await fetch(base + p, { headers: H })).text();
const b64 = (s: string) => Buffer.from(s).toString('base64');
const agora = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()).replace(' ', 'T');
const amanha = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' }).format(new Date(Date.now() + 86400_000));
const texto = (h: string) => h.replace(/<script[\s\S]*?<\/script>/gi, (m) => m.replace(/<[^>]+>/g, ' ')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const retrato = async (rotulo: string) => {
  const t = await mc.consultarTransacoesMachinePay({ posId: POS, inicio: INICIO, fim: agora });
  const s: any = await mc.consultarFechamentoMachinePay({ posId: POS, inicio: INICIO, fim: agora }).catch((e: any) => ({ erro: String(e) }));
  const statsHtml = await get(`maquinas.php?acao=stats&posid=${POS}&dataini=${encodeURIComponent(b64(INICIO))}&datafim=${encodeURIComponent(b64(agora))}&chave=${encodeURIComponent(process.env.MACHINE_COIN_CHAVE || '')}`);
  const cms = statsHtml.match(/id=["']vl_cms["'][^>]*>([^<]*)</)?.[1]?.trim() ?? '';
  log(`${rotulo}: ${t.quantidade} pagamentos, soma R$ ${t.total.toFixed(2)} · bruto ${s.brutoComTaxasMp ?? s.erro} · liquido ${s.liquido ?? '-'} · comissao no painel "${cms}"`);
  return { t, s, cms };
};

// 1) antes + PDF
const antes = await retrato('ANTES');
const pdf: Buffer = await new Promise((resolve, reject) => {
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  const parts: Buffer[] = [];
  doc.on('data', (c: Buffer) => parts.push(c)); doc.on('end', () => resolve(Buffer.concat(parts))); doc.on('error', reject);
  doc.font('Helvetica-Bold').fontSize(16).text('Extrato Machine Coin · Gira kids machine (caixa 140297581)');
  doc.font('Helvetica').fontSize(10).text(`Período: ${INICIO} até ${agora.replace('T', ' ')} · ${antes.t.quantidade} pagamentos · soma R$ ${antes.t.total.toFixed(2).replace('.', ',')}`);
  if (antes.s?.brutoComTaxasMp != null) doc.text(`PIX R$ ${antes.s.pix} · Débito R$ ${antes.s.debito} · Crédito R$ ${antes.s.credito} · Taxas R$ ${antes.s.taxas} · Líquido R$ ${antes.s.liquido} · Comissão ${antes.cms}`);
  doc.moveDown();
  for (const x of antes.t.transacoes) doc.fontSize(9).text(`${String(x.data ?? '').replace('T', ' ').slice(0, 19)}  ·  ${x.tipo}  ·  ${x.status}  ·  R$ ${Number(x.valor || 0).toFixed(2).replace('.', ',')}${x.taxa ? `  · taxa ${x.taxa}` : ''}`);
  doc.end();
});
const pdf64 = pdf.toString('base64');
for (let i = 0; i < pdf64.length; i += 1500) log(`PDF ${String(i / 1500).padStart(3, '0')} ${pdf64.slice(i, i + 1500)}`);
log(`PDF pronto (${pdf.length} bytes)`);

// 2) fechamento (como o botao "Processar fechamento")
const clientes = [...new Set([...(await get('usuarios.php')).matchAll(/copiarDadosCadastro\((\d+)\)/g)].map((m) => m[1]))];
let usr = '';
for (const c of clientes) { if ((await get(`maquinas.php?acao=maquinas&usr=${c}`)).includes(POS)) { usr = c; break; } }
log(`cliente da maquina: ${usr ? 'achado' : 'NAO achado'}`);
if (!usr) process.exit(1);
const valor = antes.cms || 'R$ 0,00';
const rFech = await get(`maquinas.php?acao=fechamento&tipo=maq&dataini=${encodeURIComponent(b64(INICIO))}&datafim=${encodeURIComponent(b64(agora))}&valor=${encodeURIComponent(b64(valor))}&id=${usr}&pos_id=${POS}`);
log(`FECHAMENTO resposta: ${texto(rFech).slice(0, 400)}`);
const depois = await retrato('DEPOIS DO FECHAMENTO');

// 3) desfazer
const body = new URLSearchParams({ pos_id: POS, data_ini: INICIO, data_fim: amanha });
const rDesf = await fetch(base + 'alterar_situacao.php', { method: 'POST', headers: { ...H, 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' }, body });
log(`DESFAZER resposta (${rDesf.status}): ${(await rDesf.text()).slice(0, 300)}`);
const final = await retrato('DEPOIS DE DESFAZER');

// 4) conferencia
const igual = final.t.quantidade === antes.t.quantidade && Math.abs(final.t.total - antes.t.total) < 0.01;
log(`CONFERENCIA: ${igual ? 'voltou igual ao de antes' : 'DIFERENTE do de antes'} (antes ${antes.t.quantidade}/R$ ${antes.t.total.toFixed(2)}, fechado ${depois.t.quantidade}/R$ ${depois.t.total.toFixed(2)}, final ${final.t.quantidade}/R$ ${final.t.total.toFixed(2)})`);
process.exit(0);
