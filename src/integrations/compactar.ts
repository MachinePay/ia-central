/**
 * Enxuga a resposta de um sistema antes de passar para o Maestro: cada caractere vira token e,
 * numa conversa com varias ferramentas, o mesmo resultado e reenviado a cada passo.
 * Tira o que nao ajuda a responder (vazios, imagens, senhas, campos internos), corta listas e
 * textos longos e limita o tamanho final.
 */
const CAMPOS_FORA = /^(imagem\w*|image\w*|foto\w*|thumbnail|logo\w*|avatar|base64|senha\w*|password\w*|hashed_password|token\w*|secret\w*|rawBody|__v|deletedAt|legadoId|sv)$/i;
const MAX_TEXTO = 300;

function limpar(v: unknown, MAX_ITENS: number, prof = 0): unknown {
  if (v === null || v === undefined || v === '') return undefined;
  if (typeof v === 'string') {
    if (/^data:[^;]+;base64,/.test(v)) return undefined;
    return v.length > MAX_TEXTO ? `${v.slice(0, MAX_TEXTO)}…` : v;
  }
  if (typeof v !== 'object') return v;
  if (prof > 6) return '…';
  if (Array.isArray(v)) {
    const itens = v.slice(0, MAX_ITENS).map((x) => limpar(x, MAX_ITENS, prof + 1)).filter((x) => x !== undefined);
    if (!itens.length) return undefined;
    return v.length > MAX_ITENS ? [...itens, `… e mais ${v.length - MAX_ITENS} (filtre na query para ver os outros)`] : itens;
  }
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (CAMPOS_FORA.test(k)) continue;
    const y = limpar(x, MAX_ITENS, prof + 1);
    if (y === undefined || (typeof y === 'object' && y !== null && !Array.isArray(y) && !Object.keys(y).length)) continue;
    out[k] = y;
  }
  return out;
}

/** Resultado pronto para a ferramenta devolver ao modelo. */
export function compactar(dados: unknown, limite = 6000): Record<string, unknown> {
  // listas encolhem antes de cortar: o Maestro recebe registros inteiros e o aviso de quantos ficaram de fora
  let json = '';
  for (const maxItens of [20, 10, 5, 3]) {
    const limpo = limpar(dados, maxItens) ?? null;
    json = JSON.stringify(limpo);
    if (json.length <= limite) return { dados: limpo };
  }
  return {
    dados_cortados: json.slice(0, limite),
    obs: 'Resposta grande e cortada: filtre mais (período, status, id, busca, limite/pagina na query) para ver o resto.',
  };
}
