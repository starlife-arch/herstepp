// Repair inconsistent terminal orders/payments. Dry-run unless --apply is supplied.
import { adminDb } from '../api/_lib/firebase-admin.js';
import { FieldValue } from 'firebase-admin/firestore';
const apply=process.argv.includes('--apply'), cutoff=Date.now()-10*60_000;let changes=0;
const ms=v=>v?.toMillis?v.toMillis():Date.parse(String(v||''));
const payments=await adminDb.collection('payments').where('status','==','PENDING').limit(500).get();
for(const snap of payments.docs){const p=snap.data(),order=await adminDb.collection('orders').doc(p.orderDocumentId).get();if(!order.exists)continue;const o=order.data();let status=null,reason=null,orderStatus=null;if(o.orderStatus==='CANCELLED'){status='CANCELLED';reason='Order cancelled.';orderStatus='CANCELLED';}else if(Number.isFinite(ms(p.initiatedAt))&&ms(p.initiatedAt)<cutoff){status='TIMEOUT';reason='The M-Pesa request timed out or was cancelled.';orderStatus=o.paymentStatus==='PENDING'?'TIMEOUT':null;}if(!status)continue;changes++;console.log(`${apply?'repairing':'would repair'} ${snap.id}: ${status}`);if(apply)await adminDb.runTransaction(async tx=>{tx.update(snap.ref,{status,failureReason:reason,completedAt:FieldValue.serverTimestamp(),updatedAt:FieldValue.serverTimestamp()});if(orderStatus)tx.update(order.ref,{paymentStatus:orderStatus,activePaymentId:null,updatedAt:FieldValue.serverTimestamp()});});}
console.log(`${apply?'Applied':'Dry run'}: ${changes} payment repair(s).`);
