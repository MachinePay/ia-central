/**
 * Aponta o webhook das instancias JA CONECTADAS da Evolution para a API nova e aplica as configuracoes
 * (nao marcar como lido, ignorar grupos...). Nao gera QR nem desconecta nada.
 *   npm run whatsapp:religar            -> mostra o que faria
 *   npm run whatsapp:religar -- --apply -> aplica
 */
import { fetchInstances, setSettings, setWebhook } from '../channels/whatsapp/evolution.js';
import { env, instanceRoles } from '../lib/env.js';

const apply = process.argv.includes('--apply');
const roles = instanceRoles();
const list = await fetchInstances();
console.log(`Webhook novo: ${env.WEBHOOK_BASE_URL}/webhooks/evolution/<instancia>`);
for (const i of list) {
  const role = roles.get(i.name) ?? 'OFF';
  console.log(`- ${i.name}: ${i.connectionStatus} (${i.ownerJid ?? 'sem numero'}) -> papel ${role}`);
  if (!apply || role === 'OFF') continue;
  await setWebhook(i.name);
  await setSettings(i.name, { rejectCall: role === 'ATENDIMENTO' }); // no numero pessoal nunca recusa ligacao
  console.log('  webhook e configuracoes aplicados');
}
if (!apply) console.log('\nNada mudou. Rode com --apply para apontar os webhooks para a API nova.');
process.exit(0); // a conexao do Redis (importada pelo cliente da Evolution) manteria o processo aberto
