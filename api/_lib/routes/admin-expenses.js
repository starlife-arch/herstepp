import { FieldValue } from 'firebase-admin/firestore';
import { adminDb, requireAdmin } from '../firebase-admin.js';
import { clientError, methodNotAllowed } from '../http.js';

const categories = new Set(['DELIVERY', 'PACKAGING', 'ADVERTISING', 'RENT', 'UTILITIES', 'FEES', 'SUPPLIES', 'OTHER']);
function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value + 'T00:00:00Z'));
}
export async function expenses(req, res) {
  const admin = await requireAdmin(req);
  const ref = adminDb.collection('businessExpenses');
  if (req.method === 'GET') {
    const snapshot = await ref.orderBy('expenseDate', 'desc').limit(300).get();
    return res.status(200).json(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
  }
  if (req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const amount = Number(body.amount);
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  const category = typeof body.category === 'string' ? body.category.toUpperCase() : '';
  if (!Number.isInteger(amount) || amount <= 0 || amount > 1000000000) throw clientError('Enter a positive whole KSh expense amount.');
  if (!description || description.length > 240) throw clientError('Enter an expense description of 240 characters or fewer.');
  if (!categories.has(category)) throw clientError('Choose a valid expense category.');
  if (!validDate(body.expenseDate)) throw clientError('Choose a valid expense date.');
  const record = {
    amount, description, category, expenseDate: body.expenseDate,
    reference: typeof body.reference === 'string' ? body.reference.trim().slice(0, 120) : '',
    createdBy: admin.uid, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
  };
  const doc = await ref.add(record);
  return res.status(201).json({ id: doc.id });
}
