/**
 * Teste da Machine Coin (autorizado pelo dono): mostra como o painel traz as vendas de hoje
 * e manda R$ 1 de credito na maquina de teste (testecoin2.0, caixa 141111255).
 * Uso: node dist/src/scripts/teste-coin.js [--credito]
 */
import * as mc from '../integrations/plataformas/machineCoinService.js';
import { parsearPainelMaquinas } from '../integrations/plataformas/machinePayPainelParser.js';
import { enviarCredito, listarMaquinas } from '../integrations/maquinas.js';

const POS_TESTE = '141111255';
const base = (process.env.MACHINE_COIN_LOGIN_URL || '').replace(/[#?].*$/, '').replace(/\/?$/, '/');
const { cookies } = await (mc as any).loginMachinePay();
const get = async (p: string) => (await fetch(base + p, { headers: { Cookie: cookies, Referer: base, 'X-Requested-With': 'XMLHttpRequest' } })).text();

// 1) onde estao as vendas de hoje no HTML da lista
const clientes = [...(await get('usuarios.php')).matchAll(/copiarDadosCadastro\((\d+)\)/g)].map((m) => m[1]);
console.log('COIN clientes', [...new Set(clientes)].length);
for (const usr of [...new Set(clientes)]) {
  const html = await get(`maquinas.php?acao=maquinas&usr=${usr}`);
  if (!html.includes(POS_TESTE) && !html.includes('140297581')) continue;
  const rows: any[] = parsearPainelMaquinas(html) ?? [];
  for (const r of rows.slice(0, 3)) console.log('COIN parse', JSON.stringify({ posId: r.posId, nome: r.nomePonto, online: r.online, vendasHojeValor: r.vendasHojeValor, vendasHojeQtd: r.vendasHojeQtd, totalValor: r.totalValor, totalQtd: r.totalQtd, ultimaVendaHoje: r.ultimaVendaHoje }));
  for (const key of ['Vendeu Hoje', 'Quant. Vendas', 'Total R$']) {
    const i = html.indexOf(key);
    if (i >= 0) console.log(`COIN html[${key}]`, html.slice(Math.max(0, i - 250), i + 200).replace(/\s+/g, ' '));
  }
  break;
}

// 2) credito de teste
if (process.argv.includes('--credito')) {
  const list = await listarMaquinas('machinecoin', true);
  const m = list.find((x) => x.id === POS_TESTE);
  if (!m) console.log('COIN credito: maquina de teste nao encontrada');
  else {
    const r = await enviarCredito(m, 1);
    console.log('COIN credito', JSON.stringify(r), 'maquina', m.nome, m.online ? 'online' : 'offline');
  }
}
process.exit(0);
