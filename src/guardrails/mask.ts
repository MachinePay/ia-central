/** Mascara CPF, CNPJ, cartao e chaves antes de mandar para o LLM ou guardar descricoes (minimizacao LGPD). */
export function maskSensitive(text: string): string {
  return text
    .replace(/\b(\d{3})[.\s]?(\d{3})[.\s]?(\d{3})[-\s]?(\d{2})\b/g, '***.$2.$3-**')                 // CPF
    .replace(/\b(\d{2})[.\s]?(\d{3})[.\s]?(\d{3})[/\s]?(\d{4})[-\s]?(\d{2})\b/g, '**.$2.$3/****-**') // CNPJ
    .replace(/\b(?:\d[ -]?){13,19}\b/g, (m) => (luhn(m.replace(/\D/g, '')) ? '[cartão omitido]' : m))
    .replace(/\b(sk|pk|rk)[-_][A-Za-z0-9_-]{16,}\b/g, '[chave omitida]')
    .replace(/\b(senha|password)\s*[:=]\s*\S+/gi, '$1: [omitida]');
}

function luhn(d: string): boolean {
  if (d.length < 13) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = +d[d.length - 1 - i];
    if (i % 2) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
  }
  return sum % 10 === 0;
}

export const SENSITIVE_RE = [
  /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/,           // CPF
  /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/,    // CNPJ
  /\b(senha|password|token|api[_ -]?key)\b\s*[:=]/i,
];
