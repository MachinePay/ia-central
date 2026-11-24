/** Teste so de leitura: gera o PDF do extrato da Gira kids machine (caixa 140297581) e mostra no log. */
import { acharMaquinas, pdfExtratoMaquina } from '../integrations/maquinas.js';

const [m] = await acharMaquinas('140297581', 'machinecoin');
if (!m) { console.log('[teste] maquina nao achada'); process.exit(1); }
console.log(`[teste] maquina ${m.nome} cliente ${m.usr ? 'ok' : 'SEM usr'}`);
const ini = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' }).format(new Date(Date.now() - 30 * 86400_000));
const { pdf, resumo } = await pdfExtratoMaquina(m, ini);
console.log(`[teste] ${resumo}`);
const s = pdf.toString('base64');
for (let i = 0; i < s.length; i += 1500) console.log(`[teste] PDF ${String(i / 1500).padStart(3, '0')} ${s.slice(i, i + 1500)}`);
process.exit(0);
