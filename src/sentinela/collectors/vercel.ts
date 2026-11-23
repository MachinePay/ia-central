import { env } from '../../lib/env.js';
import { saveObservation, upsertResource } from '../core.js';
import { clear, raise } from '../incidents.js';

/** Somente leitura: este modulo so faz GET. */
async function get<T = any>(path: string): Promise<{ status: number; data: T }> {
  const u = new URL(`https://api.vercel.com${path}`);
  if (env.VERCEL_TEAM_ID) u.searchParams.set('teamId', env.VERCEL_TEAM_ID);
  const r = await fetch(u, { headers: { authorization: `Bearer ${env.VERCEL_TOKEN}` }, signal: AbortSignal.timeout(20_000) });
  const text = await r.text();
  return { status: r.status, data: (text ? JSON.parse(text) : null) as T };
}

export async function collectVercel() {
  if (!env.VERCEL_TOKEN) return;
  const res = await get<{ projects: any[] }>('/v9/projects?limit=100');
  if (res.status === 401 || res.status === 403) {
    await raise({ ruleId: 'vercel-key', source: 'VERCEL', resourceId: 'vercel:key', severity: 'CRITICAL', title: 'Chave da Vercel inválida ou sem permissão', detail: `A API respondeu ${res.status}. Gere um token novo e atualize VERCEL_TOKEN.` });
    return;
  }
  if (res.status !== 200) return;
  await clear('vercel-key', 'vercel:key');

  for (const p of res.data.projects ?? []) {
    const prod = p.targets?.production;
    const state: string | undefined = prod?.readyState;
    const resourceId = `vercel:${p.id}`;
    const domain = (prod?.alias ?? []).find((a: string) => !a.endsWith('.vercel.app')) ?? prod?.alias?.[0];
    await upsertResource({
      source: 'VERCEL', externalId: p.id, name: p.name, kind: p.framework ?? 'project',
      url: domain ? `https://${domain}` : null,
      status: state === 'ERROR' ? 'FAIL' : state === 'BUILDING' || state === 'QUEUED' ? 'DEPLOYING' : state ? 'OK' : 'UNKNOWN',
      meta: {
        framework: p.framework, rootDirectory: p.rootDirectory,
        production: prod ? { id: prod.id, state, createdAt: prod.createdAt, commit: prod.meta?.githubCommitMessage?.slice(0, 120), commitSha: prod.meta?.githubCommitSha?.slice(0, 7), author: prod.meta?.githubCommitAuthorName } : null,
        latest: p.latestDeployments?.[0] ? { state: p.latestDeployments[0].readyState, target: p.latestDeployments[0].target, createdAt: p.latestDeployments[0].createdAt } : null,
      },
    });
    if (!state) continue;
    await saveObservation({ source: 'VERCEL', resourceId, resourceName: p.name, kind: 'deploy_status', status: state === 'ERROR' ? 'FAIL' : 'OK', details: { state } });
    if (state === 'ERROR') {
      await raise({
        ruleId: 'vercel-prod-error', source: 'VERCEL', resourceId, severity: 'CRITICAL',
        title: `Deploy de produção do ${p.name} (Vercel) com erro`,
        detail: `Commit ${prod.meta?.githubCommitSha?.slice(0, 7) ?? '?'} "${prod.meta?.githubCommitMessage?.split('\n')[0]?.slice(0, 80) ?? ''}"${prod.meta?.githubCommitAuthorName ? ` de ${prod.meta.githubCommitAuthorName}` : ''}.`,
      });
    } else if (state === 'READY') {
      await clear('vercel-prod-error', resourceId);
    }
  }
}
