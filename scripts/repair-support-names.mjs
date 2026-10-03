// Repairs legacy admin sender names without exposing staff identity to customers.
// Dry-run by default. Run `node scripts/repair-support-names.mjs --apply` in a
// trusted server environment with Firebase Admin credentials.
import { adminDb } from '../api/_lib/firebase-admin.js';

const apply = process.argv.includes('--apply');
const tickets = await adminDb.collection('supportTickets').limit(500).get();
let changes = 0;
for (const ticket of tickets.docs) {
  const messages = await ticket.ref.collection('messages').where('senderRole', '==', 'ADMIN').get();
  for (const message of messages.docs) {
    if (message.data().senderName === 'HerStep Support') continue;
    changes += 1;
    console.log(`${apply ? 'repairing' : 'would repair'} ${ticket.id}/messages/${message.id}`);
    if (apply) await message.ref.update({ senderName: 'HerStep Support' });
  }
}
console.log(`${apply ? 'Repaired' : 'Would repair'} ${changes} admin support message name(s).`);
