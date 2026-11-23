/** Normaliza para E.164 sem simbolos. Numeros brasileiros: garante o 55 e o nono digito em celulares. */
export function normalizePhone(raw: string): string {
  let d = String(raw ?? '').split('@')[0].split(':')[0].replace(/\D/g, '');
  if (!d) return '';
  if (d.length === 10 || d.length === 11) d = '55' + d;
  // 55 + DDD + 8 digitos comecando com 6-9 = celular antigo sem o nono digito
  if (d.startsWith('55') && d.length === 12 && /[6-9]/.test(d[4])) d = d.slice(0, 4) + '9' + d.slice(4);
  return d;
}

/** As duas formas (com e sem o nono digito) para achar contatos antigos. */
export function phoneVariants(p: string): string[] {
  const n = normalizePhone(p);
  if (n.startsWith('55') && n.length === 13 && n[4] === '9') return [n, n.slice(0, 4) + n.slice(5)];
  return [n];
}
