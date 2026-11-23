import { q } from '../lib/db.js';

export type Source = 'RENDER' | 'VERCEL' | 'URL' | 'SELF' | 'COST';
export type Status = 'OK' | 'WARN' | 'FAIL';
export type Severity = 'INFO' | 'WARNING' | 'CRITICAL';

export type Observation = {
  source: Source;
  resourceId: string;        // ex.: render:srv-xxx, vercel:prj_xxx, url:<id>, self:whatsapp:joao
  resourceName: string;
  kind: string;              // deploy_status, http_check, ssl_expiry, key_check, suspended...
  value?: number | null;
  status: Status;
  details?: Record<string, unknown>;
};

export async function saveObservation(o: Observation) {
  await q(
    `INSERT INTO sentinela.observations (source, resource_id, kind, value, status, details) VALUES ($1, $2, $3, $4, $5, $6)`,
    [o.source, o.resourceId, o.kind, o.value ?? null, o.status, JSON.stringify(o.details ?? {})],
  );
}

export async function upsertResource(r: {
  source: Source; externalId: string; name: string; kind?: string; url?: string | null; status: string; meta?: Record<string, unknown>;
}): Promise<{ previous: string | null }> {
  const prev = await q<{ status: string }>(`SELECT status FROM sentinela.resources WHERE source = $1 AND external_id = $2`, [r.source, r.externalId]);
  await q(
    `INSERT INTO sentinela.resources (source, external_id, name, kind, url, status, meta, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (source, external_id) DO UPDATE SET name = EXCLUDED.name, kind = EXCLUDED.kind, url = coalesce(EXCLUDED.url, sentinela.resources.url),
       status = EXCLUDED.status, meta = EXCLUDED.meta, last_seen_at = now()`,
    [r.source, r.externalId, r.name, r.kind ?? '', r.url ?? null, r.status, JSON.stringify(r.meta ?? {})],
  );
  return { previous: prev[0]?.status ?? null };
}

/** Mascara qualquer coisa parecida com chave antes de logar, mandar para a IA ou para o WhatsApp. */
export function redact(s: string): string {
  return s
    .replace(/\b(rnd_|vercel_|sk-|sk_|pk_|ghp_|xox[bp]-)[A-Za-z0-9_\-]{8,}/g, '***')
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer ***')
    .replace(/eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/g, '***');
}

export const SEVERITY_ICON: Record<Severity, string> = { CRITICAL: '🔴', WARNING: '🟡', INFO: '🔵' };
export const SEVERITY_LABEL: Record<Severity, string> = { CRITICAL: 'CRÍTICO', WARNING: 'AVISO', INFO: 'INFO' };
export const severityRank = (s: string) => (s === 'CRITICAL' ? 3 : s === 'WARNING' ? 2 : 1);
