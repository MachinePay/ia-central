/**
 * Teste de leitura das integracoes (nao manda credito nem altera nada):
 * lista maquinas de cada plataforma e puxa o faturamento da AgarraMais. Mostra so contagens e erros.
 */
import { listarMaquinas, plataformaLigada, PLATAFORMAS, type Plataforma } from '../integrations/maquinas.js';
import { agarramais, agarramaisLigada, lojas } from '../integrations/agarramais.js';

for (const p of Object.keys(PLATAFORMAS) as Plataforma[]) {
  if (!plataformaLigada(p)) { console.log(`TESTE ${PLATAFORMAS[p]}: sem variaveis`); continue; }
  try {
    const list = await listarMaquinas(p, true);
    const off = list.filter((m) => !m.online).length;
    const hoje = list.reduce((s, m) => s + (m.vendasHoje ?? 0), 0);
    console.log(`TESTE ${PLATAFORMAS[p]}: ok, ${list.length} maquinas, ${off} offline, vendas hoje R$ ${hoje.toFixed(2)}; exemplo: ${list[0] ? `${list[0].nome} [${list[0].id}] ${list[0].online ? 'online' : 'offline'}` : '-'}`);
  } catch (e: any) {
    console.log(`TESTE ${PLATAFORMAS[p]}: ERRO ${String(e.message).slice(0, 200)}`);
  }
}

if (!agarramaisLigada()) console.log('TESTE AgarraMais: sem variaveis');
else {
  try {
    const ls = await lojas();
    const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
    const r: any = await agarramais(`/relatorios/todas-lojas?dataInicio=${hoje.slice(0, 8)}01&dataFim=${hoje}`);
    console.log(`TESTE AgarraMais: ok, ${ls.length} lojas, faturamento do mes R$ ${Number(r?.totais?.faturamento ?? 0).toFixed(2)}`);
    console.log(`TESTE AgarraMais formato: chaves ${Object.keys(r ?? {}).join(',')} | totais ${JSON.stringify(r?.totais ?? {}).slice(0, 400)}`);
    const d: any = await agarramais(`/relatorios/dashboard?dataInicio=${hoje.slice(0, 8)}01&dataFim=${hoje}`).catch((e) => ({ erro: e.message }));
    console.log(`TESTE AgarraMais dashboard: ${JSON.stringify(d?.totais ?? d).slice(0, 400)}`);
  } catch (e: any) {
    console.log(`TESTE AgarraMais: ERRO ${String(e.message).slice(0, 200)}`);
  }
}
process.exit(0);
