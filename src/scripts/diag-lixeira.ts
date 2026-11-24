import { ImapFlow } from 'imapflow';
import { mailAccounts } from '../channels/mail/imap.js';
import { q } from '../lib/db.js';

/** Diagnostico (so leitura): acha na caixa os e-mails marcados "apagado" e mostra onde a conexao cai. */
const step = (s: string) => console.log(`[diag] ${s}`);
const accs = await mailAccounts();
for (const a of accs as any[]) {
  step(`conta ${a.email.replace(/^(.).*@/, '$1***@')}`);
  const { decryptForDiag } = await import('../channels/mail/imap.js') as any;
  const imap = new ImapFlow({ host: a.imap_host, port: a.imap_port, secure: a.imap_port === 993, auth: { user: a.username, pass: decryptForDiag(a.password_enc) }, logger: false, socketTimeout: 60_000 });
  imap.on('error', (e) => step(`evento error: ${e}`));
  imap.on('close', () => step('evento close'));
  await imap.connect(); step('conectou');
  const lock = await imap.getMailboxLock('INBOX'); step('INBOX aberta');
  try {
    const boxes = await imap.list(); step(`pastas: ${boxes.map((b) => `${b.path}${b.specialUse ? `(${b.specialUse})` : ''}`).join(', ')}`);
    const pend = await q<{ message_id: string }>(`SELECT message_id FROM app.emails WHERE account = $1 AND action = 'apagado' AND NOT trashed`, [a.email]);
    for (const p of pend) {
      const mid = p.message_id.replace(`mail:${a.email}:`, '');
      step(`procurando message-id ${mid.slice(0, 12)}...`);
      try { const r = await imap.search({ header: { 'message-id': mid } }, { uid: true }); step(`  achou uids ${JSON.stringify(r)}`); } catch (e) { step(`  search falhou: ${e} usable=${imap.usable}`); }
    }
    step(`usable no fim: ${imap.usable}`);
  } finally { lock.release(); await imap.logout().catch(() => undefined); }
}
process.exit(0);
