/**
 * Mensagem de encerramento ("valeu", "obrigado!", "ok 👍", "falou, tmj"): não pede resposta.
 * A conversa não fica "sem resposta" por causa dela e a IA não responde só para dizer "de nada".
 * ("sim", "pode", "isso" NAO entram: costumam ser resposta a uma oferta e pedem acao.)
 * Regra: sem pergunta, curta, e todas as palavras são de agradecimento/acordo/despedida (emoji sozinho também conta).
 */
const WORDS = new Set([
  // agradecimento
  'obrigado', 'obrigada', 'obrigadao', 'obrigadinho', 'obrigadinha', 'brigado', 'brigada', 'obg', 'obgd', 'obgda', 'brigadao',
  'valeu', 'vlw', 'valew', 'vlww', 'agradeco', 'grato', 'grata', 'gratidao', 'thanks', 'thx',
  // acordo / ciencia
  'ok', 'okay', 'okk', 'okok', 'blz', 'beleza', 'certo', 'certinho', 'combinado', 'fechado', 'fechou', 'perfeito', 'show', 'top',
  'entendi', 'entendido', 'anotado', 'otimo', 'otima', 'massa', 'joia', 'jóia', 'tranquilo', 'tranquila', 'suave',
  'ta', 'tá', 'bom', 'bem', 'demorou', 'dmr', 'fmz', 'firmeza', 'tmj', 'tamo', 'junto',
  'maravilha', 'excelente', 'legal', 'ah', 'aham', 'uhum', 'hum', 'opa', 'eba', 'kkk', 'kkkk', 'kkkkk', 'rs', 'rsrs', 'haha', 'hahaha',
  // despedida
  'falou', 'flw', 'tchau', 'xau', 'ate', 'mais', 'logo', 'amanha', 'abraco', 'abraços', 'abracos', 'abs', 'bjs', 'beijos', 'bj', 'fui',
  // enfeites que aparecem junto
  'muito', 'mt', 'mto', 'muitissimo', 'demais', 'mesmo', 'pela', 'pelo', 'ajuda', 'atencao', 'retorno', 'de', 'nada', 'por', 'tudo',
  'entao', 'aí', 'ai', 'mano', 'cara', 'irmao', 'amigo', 'amiga', 'querido', 'querida', 'chefe', 'patrao', 'meu', 'minha', 'e', 'a', 'o',
  'vc', 'voce', 'você', 'pra', 'para', 'vcs', 'voces', 'gente', 'senhor', 'senhora', 'sr', 'sra', 'dona', 'deus', 'abencoe',
]);

const strip = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function isClosingMessage(text: string | null | undefined, hasMedia = false): boolean {
  if (hasMedia) return false;
  const t = String(text ?? '').replace(/^⁣/, '').trim();
  if (!t) return false;
  if (t.includes('?')) return false;
  if (t.length > 80) return false;
  const letters = strip(t).replace(/[^a-z0-9\s]/g, ' ').trim();
  if (!letters) return true; // so emoji/sinal: 👍, 🙏, ❤️, "!!"
  const tokens = letters.split(/\s+/).filter(Boolean);
  if (tokens.length > 8) return false;
  return tokens.every((w) => WORDS.has(w) || WORDS.has(w.replace(/(.)\1+$/, '$1')) || /^k{3,}$/.test(w) || /^(ha)+h?$/.test(w));
}
