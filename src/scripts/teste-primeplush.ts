import { catalogoPrimeplush, orcarPrimeplush, primeplushAdmin, produtosPrimeplush, relatorioPrimeplush } from '../integrations/primeplush.js';

/** Teste so de leitura da PrimePlush: catalogo, orcamento (sem criar pedido) e relatorio do mes. */
const ok = (s: string) => console.log(`[teste] ${s}`);
try {
  const all = await produtosPrimeplush();
  ok(`catalogo: ${all.length} produtos`);
  ok(`busca "pokemon": ${(await catalogoPrimeplush('pokemon')).length}`);
  const o = await orcarPrimeplush([{ produto: all[0].name, quantidade: 2 }]);
  ok(`orcamento: ${'erro' in o ? o.erro : o.resumo}`);
} catch (e) { ok(`catalogo falhou: ${e}`); }

ok(`senha de admin configurada: ${primeplushAdmin()}`);
try {
  const now = new Date();
  const r = await relatorioPrimeplush(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 3)), now);
  ok(`relatorio do mes: ${JSON.stringify(r)}`);
} catch (e) { ok(`relatorio falhou: ${e}`); }
process.exit(0);
