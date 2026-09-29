import { FieldValue } from 'firebase-admin/firestore';
import { adminAuth, adminDb } from '../api/_lib/firebase-admin.js';

const [email, role] = process.argv.slice(2);

if (!email || !['ADMIN', 'SUPER_ADMIN'].includes(role)) {
  console.error('Usage: node scripts/grant-admin.mjs <email> <ADMIN|SUPER_ADMIN>');
  process.exit(1);
}

const user = await adminAuth.getUserByEmail(email);
await adminDb.collection('users').doc(user.uid).set({
  role,
  updatedAt: FieldValue.serverTimestamp(),
}, { merge: true });

console.log(`Granted ${role} to ${user.email} (${user.uid}).`);
