import { env } from '../../lib/env.js';
import { saveObservation, upsertResource } from '../core.js';
import { clear, raise } from '../incidents.js';

const BASE = 'https://api.render.com/v1';

/** Somente leitura: este modulo so faz GET. */
async function get<T = any>(path: string): Promise<{ status: number; data: T }> {
  const r = await fetch(`${BASE}${path}`, {
    headers: { authorization: `Bearer ${env.RENDER_API_KEY}`, accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await r.text();
  return { status: r.status, data: (text ? JSON.parse(text) : null) as T };
}

async function listAll<T>(path: string, field: string): Promise<T[]> {
  const out: T[] = [];
  let cursor = '';
  for (let i = 0; i < 20; i++) {
    const { status, data } = await get<any[]>(`${path}${path.includes('?') ? '&' : '?'}limit=100${cursor ? `&cursor=${cursor}` : ''}`);
    if (status !== 200) throw Object.assign(new Error(`Render ${status}`), { status });
    for (const row of data) out.push(row[field]);
    if (data.length < 100) break;
    cursor = data[data.length - 1].cursor;
  }
  return out;
}

const FAILED = new Set(['build_failed', 'update_failed', 'pre_deploy_failed']);
const IN_PROGRESS = new Set(['created', 'build_in_progress', 'update_in_progress', 'pre_deploy_in_progress']);

export async function collectRender() {
  if (!env.RENDER_API_KEY) return;
  let services: any[];
  try {
    services = await listAll<any>('/services', 'service');
    await clear('render-key', 'render:key');
  } catch (e: any) {
    if (e.status === 401 || e.status === 403) {
      await raise({ ruleId: 'render-key', source: 'RENDER', resourceId: 'render:key', severity: 'CRITICAL', title: 'Chave da Render inválida ou revogada', detail: `A API respondeu ${e.status}. Gere uma chave nova e atualize RENDER_API_KEY.` });
    }
    return; // 429 ou rede: tenta na proxima rodada
  }

  for (const s of services) {
    const suspended = s.suspended === 'suspended';
    const resourceId = `render:${s.id}`;
    const deployRes = suspended ? undefined : await get<any[]>(`/services/${s.id}/deploys?limit=1`).catch(() => undefined);
    const deploy = deployRes?.status === 200 ? deployRes.data?.[0]?.deploy : undefined;
    const deployStatus: string | undefined = deploy?.status;
    const status = suspended ? 'SUSPENDED' : deployStatus && FAILED.has(deployStatus) ? 'FAIL' : deployStatus && IN_PROGRESS.has(deployStatus) ? 'DEPLOYING' : 'OK';
    const { previous } = await upsertResource({
      source: 'RENDER', externalId: s.id, name: s.name, kind: s.type, url: s.serviceDetails?.url ?? null, status,
      meta: {
        plan: s.serviceDetails?.plan, region: s.serviceDetails?.region, dashboardUrl: s.dashboardUrl, branch: s.branch,
        lastDeploy: deploy ? { id: deploy.id, status: deploy.status, commit: deploy.commit?.message?.slice(0, 120), commitId: deploy.commit?.id?.slice(0, 7), finishedAt: deploy.finishedAt, createdAt: deploy.createdAt } : null,
      },
    });

    // servico que estava no ar e foi suspenso
    if (suspended) {
      if (previous && previous !== 'SUSPENDED' && previous !== 'UNKNOWN') {
        await raise({ ruleId: 'render-suspended', source: 'RENDER', resourceId, severity: 'WARNING', title: `${s.name} (Render) foi suspenso`, detail: 'O serviço estava no ar e agora está suspenso.' });
      }
      continue;
    }
    await clear('render-suspended', resourceId);
    if (!deploy) continue;

    await saveObservation({ source: 'RENDER', resourceId, resourceName: s.name, kind: 'deploy_status', status: FAILED.has(deploy.status) ? 'FAIL' : 'OK', details: { status: deploy.status, deployId: deploy.id } });
    if (FAILED.has(deploy.status)) {
      await raise({
        ruleId: 'render-deploy-failed', source: 'RENDER', resourceId, severity: 'CRITICAL',
        title: `Deploy do ${s.name} (Render) falhou`,
        detail: `Status ${deploy.status} · commit ${deploy.commit?.id?.slice(0, 7) ?? '?'} "${deploy.commit?.message?.split('\n')[0]?.slice(0, 80) ?? ''}". A versão anterior continua no ar.`,
      });
    } else if (deploy.status === 'live' || deploy.status === 'deactivated') {
      await clear('render-deploy-failed', resourceId, `deploy ${deploy.id} no ar`);
    }
    const minutes = (Date.now() - new Date(deploy.createdAt).getTime()) / 60_000;
    if (IN_PROGRESS.has(deploy.status) && minutes > 30) {
      await raise({ ruleId: 'render-deploy-stuck', source: 'RENDER', resourceId, severity: 'WARNING', title: `Deploy do ${s.name} (Render) travado há ${Math.round(minutes)} min` });
    } else {
      await clear('render-deploy-stuck', resourceId);
    }
  }

  // bancos gerenciados
  const pgs = await listAll<any>('/postgres', 'postgres').catch(() => []);
  for (const p of pgs) {
    const resourceId = `render:${p.id}`;
    await upsertResource({ source: 'RENDER', externalId: p.id, name: p.name, kind: 'postgres', status: p.status === 'available' ? 'OK' : p.suspended === 'suspended' ? 'SUSPENDED' : 'WARN', meta: { plan: p.plan, status: p.status, dashboardUrl: p.dashboardUrl } });
    if (p.status && p.status !== 'available' && p.suspended !== 'suspended') {
      await raise({ ruleId: 'render-postgres', source: 'RENDER', resourceId, severity: 'CRITICAL', title: `Banco ${p.name} (Render) com status ${p.status}` });
    } else {
      await clear('render-postgres', resourceId);
    }
  }
}
