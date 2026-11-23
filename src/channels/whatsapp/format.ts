const MAX_BUBBLE = 600;
const MAX_BUBBLES = 4;

/** Markdown -> formatacao do WhatsApp; remove titulos e tabelas. */
export function toWhatsapp(md: string): string {
  return md
    .replace(/\r/g, '')
    .replace(/^#{1,6}\s*(.+)$/gm, '*$1*')
    .replace(/^\|.*\|$/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/__(.+?)__/g, '_$1_')
    .replace(/~~(.+?)~~/g, '~$1~')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '$1: $2')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Quebra em ate 3 bolhas por paragrafo, no maximo 600 caracteres cada. */
export function toBubbles(text: string): string[] {
  const paragraphs = toWhatsapp(text).split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const bubbles: string[] = [];
  for (const p of paragraphs) {
    if (p.length <= MAX_BUBBLE) {
      bubbles.push(p);
      continue;
    }
    let rest = p;
    while (rest.length > MAX_BUBBLE) {
      const cut = Math.max(rest.lastIndexOf('. ', MAX_BUBBLE), rest.lastIndexOf('\n', MAX_BUBBLE), rest.lastIndexOf(' ', MAX_BUBBLE));
      const at = cut > MAX_BUBBLE / 2 ? cut + 1 : MAX_BUBBLE;
      bubbles.push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
    }
    if (rest) bubbles.push(rest);
  }
  if (bubbles.length <= MAX_BUBBLES) return bubbles;
  // junta o excedente nas ultimas bolhas sem passar do limite total
  const head = bubbles.slice(0, MAX_BUBBLES - 1);
  head.push(bubbles.slice(MAX_BUBBLES - 1).join('\n\n'));
  return head;
}

/** "digitando" proporcional ao tamanho: 30 ms por caractere, entre 1,5 e 6 s. */
/** "digitando" proporcional ao tamanho (como alguem digitando no celular), com variacao para nao parecer robo. */
export const typingMs = (text: string) => Math.round(Math.min(7000, Math.max(1200, text.length * 45)) * (0.85 + Math.random() * 0.3));
