import { generateText } from 'ai';
import type { Agent, Channel } from '../domain/types.js';
import { addCost, costUsd, withFallback } from '../lib/llm.js';
import { fence } from '../lib/util.js';
import { SENSITIVE_RE } from './mask.js';
import { INTIMATE_RE } from '../memory/persona.js';
import { wordsOf } from '../memory/style.js';

export type OutputCheck = { text: string; issues: string[]; blocked: boolean };

const CLAIMS_HUMAN = /\b(sou (uma |um )?(pessoa|humano|humana|gente de verdade)|n[aã]o sou (um |uma )?(rob[oô]|bot|ia|intelig[eê]ncia artificial))\b/i;
const MONEY = /R\$\s?\d[\d.,]*|\b\d{1,3}(?:[.,]\d+)?\s?%/g;
const DEADLINE = /\b(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|em (até )?\d+\s?(dias|horas|semanas)( úteis)?)\b/gi;
// especificacao tecnica com unidade (110/220V, 50 W, 4 GB, 30 cm...): tambem precisa vir de fonte
const SPECS = /\b\d+(?:[.,/]\d+)*\s?(?:V|W|kW|A|GB|MB|Mbps|cm|mm|m|kg|g|pol(?:egadas)?|")(?![a-zA-Z])/g;
const WA_MAX_CHARS = 1800;
/** "vou liberar", "ja reinicio", "te mando agora", "ja estornei"... (averiguar/ver/checar continuam permitidos) */
const ACTION_VERBS = '(liber|reinici|reset|ajust|corrig|resolv|estorn|reembols|credit|recredit|envi|mand|transfer|desbloque|troc|configur|instal|deslig|lig)';
const PROMISES_ACTION = new RegExp(
  `\\b(vou|vamos|irei|ja|já|agora mesmo|te|a gente vai)\\s+(te\\s+|lhe\\s+|ja\\s+|já\\s+)?${ACTION_VERBS}\\w*` +
  `|\\b${ACTION_VERBS}u?ei\\b`,
  'i',
);
const SELF_AS_BOT =/\b(assistente (do|da|de|virtual)|sou (o|a|um|uma) (assistente|bot|rob[oô]|ia)|atendimento autom[aá]tico|agente virtual)\b/i;
export const ASKS_BOT = /\b(rob[oô]|bot|\bia\b|intelig[eê]ncia artificial|chat ?gpt|autom[aá]tic|é (uma )?pessoa|é gente|é humano)\b/i;
/** Cumprimento ou mensagem curta sem pedido ("oi", "blz", "iai dboa?"). */
export const isSmallTalk = (t: string) =>
  t.trim().length <= 40 && /^(oi+|ol[aá]|opa|e a[ií]|iai|eai|fala|bom dia|boa tarde|boa noite|tudo (bem|certo|bom)|blz|beleza|dboa|de boa|tranquilo|salve|ok|obrigad|valeu|vlw|tmj|👍|🙏)/i.test(t.trim());

const norm = (s: string) => s.replace(/\s/g, '').replace(',', '.').toLowerCase();

/** Valores/prazos que nao aparecem em nenhuma saida de tool nem nos fatos registrados. */
function unsupportedFigures(text: string, evidence: string): string[] {
  const ev = norm(evidence);
  const found = [...(text.match(MONEY) ?? []), ...(text.match(DEADLINE) ?? []), ...(text.match(SPECS) ?? [])];
  return found.filter((f) => {
    const digits = f.replace(/[^\d,.]/g, '').replace(/[.,]$/, '');
    return digits && !ev.includes(norm(digits));
  });
}

/**
 * Checagem antes de enviar: regras primeiro (sem custo); o modelo pequeno so reescreve quando algo foi sinalizado.
 */
export async function checkOutput(o: {
  text: string; channel: Channel; agent: Agent; evidence: string[]; facts: unknown; kbConsulted: boolean;
  clientAskedBot?: boolean; shortClient?: boolean;
  /** o jeito com este contato (ou o historico) ja tem esse tipo de carinho/apelido */
  intimateAllowed?: boolean;
  /** conversa pessoal: curto e so com palavras que o dono do numero ja usou */
  personal?: boolean; vocab?: Set<string>;
}): Promise<OutputCheck> {
  const issues: string[] = [];
  const evidence = o.evidence.join('\n') + JSON.stringify(o.facts ?? {});
  if (SENSITIVE_RE.some((r) => r.test(o.text))) issues.push('contém dado sensível (CPF/CNPJ/senha/token): remova');
  if (CLAIMS_HUMAN.test(o.text)) issues.push('nega ser IA: se perguntaram, diga com leveza que usa um assistente para responder rápido e que a pessoa acompanha tudo');
  // humano substituto: so fala de "assistente" quando o cliente perguntou se e robo
  if (!o.clientAskedBot && SELF_AS_BOT.test(o.text)) issues.push('se apresenta como assistente/robô sem o cliente perguntar: escreva em primeira pessoa como a própria pessoa, sem mencionar assistente');
  if (PROMISES_ACTION.test(o.text)) issues.push('promete ou diz que fez uma ação (liberar, reiniciar, enviar, estornar...): troque por acalmar e dizer que vai averiguar, ex.: "vou dar uma averiguada, so um instante"');
  if (/\b(olhada remota|acesso remoto|remotamente|conex[aã]o remota|reinici(o|ar) remot)/i.test(o.text)) issues.push('oferece acesso/olhada remota, que você não consegue fazer: troque por "vou ver aqui e te falo"');
  if (!o.intimateAllowed && INTIMATE_RE.test(o.text)) issues.push('usa apelido ou carinho (amor, bb...) com quem você não trata assim: fale do seu jeito geral, sem apelidos');
  if (o.channel === 'WHATSAPP' && /^\s*[•\-*]\s/m.test(o.text)) issues.push('tem lista com marcadores: escreva em frases normais, como no WhatsApp');
  if (o.shortClient && o.text.length > 280) issues.push('o cliente só cumprimentou ou mandou algo curto: responda curto (1 bolha) e não puxe assuntos antigos');
  if (o.personal) {
    if (o.text.length > 220) issues.push('conversa pessoal: está longo demais. Deixe em 1 ou 2 mensagens curtas, como você escreve para essa pessoa, sem conselho nem instrução');
    const strange = o.vocab?.size ? [...new Set(wordsOf(o.text))].filter((w) => w.length >= 5 && !o.vocab!.has(w)) : [];
    if (strange.length) issues.push(`usa palavras que você nunca usa (${strange.slice(0, 8).join(', ')}): troque por palavras simples do seu dia a dia ou tire a frase`);
  }
  const figs = unsupportedFigures(o.text, evidence);
  if (figs.length) issues.push(`cita valores, prazos ou especificações que não vieram de ferramenta nem de aprovação (${figs.join(', ')}): remova e diga que vai confirmar`);
  if (o.agent === 'CLARA' && !o.kbConsulted && /(\n\s*\d+[.)]\s|clique em|acesse o menu|v[aá] em configura)/i.test(o.text)) {
    issues.push('passa procedimento sem ter consultado a base: troque por perguntas de diagnóstico ou diga que vai verificar com a engenharia');
  }
  if (o.channel === 'WHATSAPP' && o.text.length > WA_MAX_CHARS) issues.push(`longo demais para WhatsApp: no máximo ${WA_MAX_CHARS} caracteres`);
  if (!issues.length) return { text: o.text, issues, blocked: false };

  try {
    const r = await withFallback('small', ({ model }) =>
      generateText({
        model,
        system: 'Você revisa uma mensagem de WhatsApp antes do envio. Reescreva corrigindo APENAS os problemas listados, mantendo tom, idioma (pt-BR), abreviações e o jeito simples de quem escreveu. Use palavras simples do dia a dia, sem reticências nem barra. Mensagens separadas por linha em branco. Devolva só o texto final, sem comentários.',
        prompt: `${fence('problemas', issues.map((i) => `- ${i}`).join('\n'))}\n${fence('resposta', o.text)}\n${fence('dados_confirmados', evidence.slice(0, 6000))}`,
        maxRetries: 1,
      }),
    );
    await addCost(costUsd(r.modelSpec, r.usage.inputTokens, r.usage.outputTokens));
    const fixed = r.text.trim();
    // segunda passada so com regras: se ainda tem dado sensivel ou afirma ser humano, bloqueia
    if (!fixed || SENSITIVE_RE.some((x) => x.test(fixed)) || CLAIMS_HUMAN.test(fixed)) return { text: o.text, issues, blocked: true };
    return { text: fixed, issues, blocked: false };
  } catch {
    return { text: o.text, issues, blocked: true };
  }
}
