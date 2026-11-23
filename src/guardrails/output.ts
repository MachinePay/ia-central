import { generateText } from 'ai';
import type { Agent, Channel } from '../domain/types.js';
import { addCost, costUsd, withFallback } from '../lib/llm.js';
import { fence } from '../lib/util.js';
import { SENSITIVE_RE } from './mask.js';

export type OutputCheck = { text: string; issues: string[]; blocked: boolean };

const CLAIMS_HUMAN = /\b(sou (uma |um )?(pessoa|humano|humana|gente de verdade)|n[aã]o sou (um |uma )?(rob[oô]|bot|ia|intelig[eê]ncia artificial))\b/i;
const MONEY = /R\$\s?\d[\d.,]*|\b\d{1,3}(?:[.,]\d+)?\s?%/g;
const DEADLINE = /\b(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|em (até )?\d+\s?(dias|horas|semanas)( úteis)?)\b/gi;
// especificacao tecnica com unidade (110/220V, 50 W, 4 GB, 30 cm...): tambem precisa vir de fonte
const SPECS = /\b\d+(?:[.,/]\d+)*\s?(?:V|W|kW|A|GB|MB|Mbps|cm|mm|m|kg|g|pol(?:egadas)?|")(?![a-zA-Z])/g;
const WA_MAX_CHARS = 1800;

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
}): Promise<OutputCheck> {
  const issues: string[] = [];
  const evidence = o.evidence.join('\n') + JSON.stringify(o.facts ?? {});
  if (SENSITIVE_RE.some((r) => r.test(o.text))) issues.push('contém dado sensível (CPF/CNPJ/senha/token): remova');
  if (CLAIMS_HUMAN.test(o.text)) issues.push('diz ser humano: diga que é o assistente virtual e que o Gabriel acompanha');
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
        system: 'Você revisa uma resposta de atendimento antes do envio. Reescreva corrigindo APENAS os problemas listados, mantendo tom, idioma (pt-BR) e o restante do conteúdo. Devolva só o texto final, sem comentários.',
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
