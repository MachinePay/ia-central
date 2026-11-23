import { q } from './db.js';
import { EDITABLE_SETTINGS, setOverrides, type EditableSetting } from './env.js';
import { logger } from './logger.js';

export async function refreshSettings() {
  try {
    const rows = await q<{ key: EditableSetting; value: string }>(`SELECT key, value FROM app.settings WHERE key = ANY($1)`, [EDITABLE_SETTINGS]);
    setOverrides(Object.fromEntries(rows.map((r) => [r.key, r.value])));
  } catch (e) {
    logger.warn({ err: String(e) }, 'ajustes do painel nao carregados (usando variaveis de ambiente)');
  }
}

export function startSettingsRefresh() {
  void refreshSettings();
  setInterval(() => void refreshSettings(), 30_000).unref();
}

export async function saveSetting(key: EditableSetting, value: string, by: string) {
  await q(
    `INSERT INTO app.settings (key, value, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [key, value, by],
  );
  await refreshSettings();
}
