import { q } from '../lib/db.js';
import { normalizePhone } from '../lib/phone.js';

/** Guarda o nome da agenda (por numero). Ignora quando o "nome" e so o telefone. */
export async function saveAgendaNames(instance: string, list: Array<{ jid: string; name: string }>) {
  for (const c of list) {
    if (!c.jid.endsWith('@s.whatsapp.net')) continue; // grupos e @lid ficam de fora
    const phone = normalizePhone(c.jid);
    const name = c.name.trim();
    if (!phone || !name || name.replace(/\D/g, '') === phone.replace(/\D/g, '') || name === c.jid.split('@')[0]) continue;
    await q(
      `INSERT INTO app.contact_names (instance, phone, name) VALUES ($1, $2, $3)
       ON CONFLICT (instance, phone) DO UPDATE SET name = EXCLUDED.name, updated_at = now()`,
      [instance, phone, name.slice(0, 120)],
    );
  }
}
