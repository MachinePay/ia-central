import tls from 'node:tls';
import { q } from '../../lib/db.js';
import { publish } from '../../lib/events.js';
import { saveObservation } from '../core.js';
import { clear, raise } from '../incidents.js';

export type Monitor = {
  id: string; name: string; url: string; method: string; expect_status: number[]; max_latency_ms: number;
  must_contain: string[]; must_not_contain: string[]; interval_sec: number; failures_to_alert: number;
  enabled: boolean; silenced_until: Date | null; consecutive_fail: number; last_status: string;
  last_checked_at: Date | null; ssl_expires_at: Date | null;
};

const UA = 'SelfMachine-Sentinela/1.0';

export type CheckResult = { status: 'OK' | 'WARN' | 'FAIL'; httpStatus?: number; latencyMs?: number; problems: string[]; title?: string };

/** Camadas 1 e 3: disponibilidade, tempo de resposta e conteudo esperado. */
export async function checkUrl(m: Pick<Monitor, 'url' | 'method' | 'expect_status' | 'max_latency_ms' | 'must_contain' | 'must_not_contain'>): Promise<CheckResult> {
  const started = Date.now();
  try {
    const r = await fetch(m.url, {
      method: m.method, redirect: 'follow', headers: { 'user-agent': UA },
      signal: AbortSignal.timeout(Math.max(10_000, m.max_latency_ms * 3)),
    });
    const body = await r.text();
    const latencyMs = Date.now() - started;
    const problems: string[] = [];
    if (!m.expect_status.includes(r.status)) problems.push(`respondeu ${r.status} (esperado ${m.expect_status.join('/')})`);
    for (const t of m.must_contain) if (!body.includes(t)) problems.push(`sem o texto "${t}"`);
    for (const t of m.must_not_contain) if (body.includes(t)) problems.push(`apareceu "${t}"`);
    const title = body.match(/<title[^>]*>([^<]{0,120})/i)?.[1]?.trim();
    if (problems.length) return { status: 'FAIL', httpStatus: r.status, latencyMs, problems, title };
    if (latencyMs > m.max_latency_ms) return { status: 'WARN', httpStatus: r.status, latencyMs, problems: [`lento: ${(latencyMs / 1000).toFixed(1)} s (limite ${(m.max_latency_ms / 1000).toFixed(1)} s)`], title };
    return { status: 'OK', httpStatus: r.status, latencyMs, problems: [], title };
  } catch (e: any) {
    const msg = String(e?.cause?.code ?? e?.name ?? e?.message ?? e);
    return { status: 'FAIL', latencyMs: Date.now() - started, problems: [/Timeout|Abort/i.test(msg) ? 'sem resposta (tempo esgotado)' : `erro de conexão: ${msg}`] };
  }
}

/** Checagem de controle: se nem um site neutro responde, o problema e a rede do Sentinela, nao o alvo. */
async function networkOk(): Promise<boolean> {
  try {
    const r = await fetch('https://www.google.com/generate_204', { signal: AbortSignal.timeout(5000) });
    return r.status < 500;
  } catch {
    return false;
  }
}

export function sslExpiry(url: string): Promise<Date | undefined> {
  return new Promise((resolve) => {
    let host: string;
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:') return resolve(undefined);
      host = u.hostname;
    } catch {
      return resolve(undefined);
    }
    const s = tls.connect({ host, port: 443, servername: host, timeout: 8000 }, () => {
      const c = s.getPeerCertificate();
      s.end();
      resolve(c?.valid_to ? new Date(c.valid_to) : undefined);
    });
    s.on('error', () => resolve(undefined));
    s.on('timeout', () => { s.destroy(); resolve(undefined); });
  });
}

export async function collectUrls() {
  const due = await q<Monitor>(
    `SELECT * FROM sentinela.monitors WHERE enabled AND (silenced_until IS NULL OR silenced_until < now())
       AND (last_checked_at IS NULL OR last_checked_at < now() - make_interval(secs => interval_sec - 5))`,
  );
  if (!due.length) return;
  let net: boolean | undefined;
  await Promise.all(due.map(async (m) => {
    const res = await checkUrl(m);
    if (res.status === 'FAIL' && !res.httpStatus) {
      net ??= await networkOk();
      if (!net) return; // rede do proprio Sentinela fora: nao culpa o site
    }
    const resourceId = `url:${m.id}`;
    const fails = res.status === 'FAIL' ? m.consecutive_fail + 1 : 0;
    await q(
      `UPDATE sentinela.monitors SET consecutive_fail = $2, last_status = $3, last_latency_ms = $4, last_checked_at = now() WHERE id = $1`,
      [m.id, fails, res.status, res.latencyMs ?? null],
    );
    await saveObservation({ source: 'URL', resourceId, resourceName: m.name, kind: 'http_check', value: res.latencyMs ?? null, status: res.status, details: { httpStatus: res.httpStatus, problems: res.problems } });
    if (m.last_status !== res.status) await publish('resource.updated', { kind: 'monitor', id: m.id, status: res.status });

    if (res.status === 'FAIL' && fails >= m.failures_to_alert) {
      await raise({ ruleId: 'url-down', source: 'URL', resourceId, severity: 'CRITICAL', title: `${m.name} fora do ar`, detail: `${m.url} ${res.problems.join('; ')} há ${fails} checagens seguidas.` });
    } else if (res.status === 'OK') {
      await clear('url-down', resourceId);
    }

    // lento: so avisa depois de N checagens lentas seguidas
    const slowKey = `url-slow:${m.id}`;
    if (res.status === 'WARN') {
      const { redis } = await import('../../lib/redis.js');
      const n = await redis.incr(slowKey);
      await redis.expire(slowKey, 3600);
      if (n >= m.failures_to_alert) await raise({ ruleId: 'url-slow', source: 'URL', resourceId, severity: 'WARNING', title: `${m.name} lento`, detail: res.problems.join('; ') });
    } else if (res.status === 'OK') {
      const { redis } = await import('../../lib/redis.js');
      await redis.del(slowKey);
      await clear('url-slow', resourceId);
    }
  }));
}

/** Camada 2: certificado SSL (a cada 6 h). */
export async function collectSsl() {
  const monitors = await q<Monitor>(`SELECT * FROM sentinela.monitors WHERE enabled AND url LIKE 'https://%'`);
  for (const m of monitors) {
    const exp = await sslExpiry(m.url);
    if (!exp) continue;
    await q(`UPDATE sentinela.monitors SET ssl_expires_at = $2 WHERE id = $1`, [m.id, exp]);
    const days = (exp.getTime() - Date.now()) / 86_400_000;
    const resourceId = `url:${m.id}`;
    if (days < 14) {
      await raise({ ruleId: 'ssl-expiry', source: 'URL', resourceId, severity: days < 3 ? 'CRITICAL' : 'WARNING', title: `Certificado de ${new URL(m.url).hostname} vence em ${Math.max(0, Math.floor(days))} dia(s)` });
    } else {
      await clear('ssl-expiry', resourceId);
    }
  }
}
