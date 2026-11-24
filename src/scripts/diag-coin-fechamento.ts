/**
 * Diagnostico so de leitura (nao fecha nada): como o painel da Machine Coin faz o fechamento,
 * exporta PDF e se tem como desfazer, olhando a maquina de teste (caixa 141111255).
 */
import * as mc from '../integrations/plataformas/machineCoinService.js';

const POS = '141111255';
const base = (process.env.MACHINE_COIN_LOGIN_URL || '').replace(/[#?].*$/, '').replace(/\/?$/, '/');
const { cookies } = await (mc as any).loginMachinePay();
const get = async (p: string) => (await fetch(p.startsWith('http') ? p : base + p, { headers: { Cookie: cookies, Referer: base, 'X-Requested-With': 'XMLHttpRequest' } })).text();
const show = (t: string, s: string) => console.log(`[diag] ${t}: ${s.replace(/\s+/g, ' ').slice(0, 1500)}`);
const grab = (html: string, re: RegExp) => [...new Set([...html.matchAll(re)].map((m) => m[0]))];
const RE = /.{0,140}(fech|desfaz|reabr|estorn|cancel|pdf|export|imprim|print|historic).{0,140}/gi;

const clientes = [...new Set([...(await get('usuarios.php')).matchAll(/copiarDadosCadastro\((\d+)\)/g)].map((m) => m[1]))];
let linha = '';
for (const usr of clientes) {
  const html = await get(`maquinas.php?acao=maquinas&usr=${usr}`);
  const i = html.indexOf(POS);
  if (i < 0) continue;
  linha = html.split(/<tr[\s>]/i).find((l) => l.includes(POS)) ?? '';
  show('usr da maquina de teste', usr);
  break;
}
show('acoes na linha da maquina', grab(linha, /(acao=[a-z_]+[^"' ]*|on[a-z]+="[^"]{0,160}")/gi).join(' | '));

// pagina principal e scripts do painel: funcoes de fechamento / pdf / desfazer
const page = await get('maquinas.php');
const scripts = grab(page, /src="([^"]+\.js[^"]*)"/gi).map((s) => s.replace(/^src="|"$/g, ''));
show('scripts', scripts.join(', '));
for (const s of scripts.filter((x) => !/jquery|bootstrap|cdn|google|font/i.test(x))) {
  const js = await get(s.startsWith('http') ? s : base + s.replace(/^\.?\//, '')).catch(() => '');
  for (const m of grab(js, RE).slice(0, 25)) show(`js ${s}`, m);
}
for (const m of grab(page, RE).slice(0, 25)) show('maquinas.php', m);

// tela do extrato (stats) dos ultimos 30 dias
const fmt = (d: Date) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(d);
const b64 = (s: string) => Buffer.from(s).toString('base64');
const ini = fmt(new Date(Date.now() - 30 * 86400_000)).slice(0, 10) + ' 00:00:00';
const fim = fmt(new Date()).slice(0, 10) + ' 23:59:59';
const stats = await get(`maquinas.php?acao=stats&posid=${POS}&dataini=${encodeURIComponent(b64(ini))}&datafim=${encodeURIComponent(b64(fim))}&chave=${encodeURIComponent(process.env.MACHINE_COIN_CHAVE || '')}`);
show('stats tamanho', String(stats.length));
for (const m of grab(stats, RE).slice(0, 30)) show('stats', m);
show('stats acoes', grab(stats, /(acao=[a-z_]+|on[a-z]+="[^"]{0,160}")/gi).slice(0, 40).join(' | '));
process.exit(0);
