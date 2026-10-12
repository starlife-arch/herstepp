import { FieldValue } from 'firebase-admin/firestore';
import { adminDb, requireAdmin } from '../firebase-admin.js';
import { clientError, methodNotAllowed } from '../http.js';
import { buildAdminFallbackAnswer, classifyAdminQuestion, summarizeAdminData } from './admin-ai-core.js';

const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 12;
const requests = new Map();

function checkRateLimit(uid, now = Date.now()) {
  const current = requests.get(uid);
  if (!current || now - current.startedAt >= RATE_WINDOW_MS) {
    requests.set(uid, { startedAt: now, count: 1 });
    return;
  }
  if (current.count >= RATE_LIMIT) throw clientError('You’ve reached the Admin AI request limit. Please wait a minute and try again.', 429);
  current.count += 1;
}

async function safeDocs(query, label) {
  try {
    const snapshot = await query.get();
    return snapshot.docs.map(doc => doc.data());
  } catch (error) {
    console.error('[admin-ai] Could not load ' + label + ':', error?.message || error);
    return [];
  }
}

async function loadReportData() {
  const [orders, products, tickets, tips] = await Promise.all([
    safeDocs(adminDb.collection('orders').orderBy('createdAt', 'desc').limit(500), 'orders'),
    safeDocs(adminDb.collection('products').limit(500), 'products'),
    safeDocs(adminDb.collection('supportTickets').orderBy('updatedAt', 'desc').limit(200), 'support tickets'),
    safeDocs(adminDb.collection('tips').orderBy('createdAt', 'desc').limit(200), 'tips'),
  ]);
  return summarizeAdminData({ orders, products, tickets, tips });
}

async function askModel(message, intent, report) {
  const key = String(process.env.GROQ_API_KEY || '').trim();
  if (!key) return buildAdminFallbackAnswer(intent, report);
  const prompt = [
    'You are the private, read-only Admin AI for HerStep Collection, a Kenyan online footwear store.',
    'Answer the administrator question using only the aggregate report JSON supplied below.',
    'Never invent facts, dates, totals, costs, profit, or causes. State that figures reflect the bounded report sample where relevant.',
    'Profit: only discuss gross profit if knownGrossProfit is a number and knownCostPaidOrderCount equals paidOrderCount. Never call gross profit net profit. If cost coverage is incomplete, say it cannot be reliably calculated.',
    'Do not request, reveal, or infer customer passwords, authentication tokens, M-Pesa PINs, full phone numbers, private customer messages, or other personal data.',
    'This phase is strictly read-only. Do not claim to have changed an order, stock, payment, ticket, invoice, or customer record. Explain that operational actions must be done in the existing admin tools.',
    'Keep the answer concise, practical, and in KSh where money is shown.',
    'Report JSON: ' + JSON.stringify(report),
  ].join('\n');
  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: String(process.env.GROQ_CHAT_MODEL || 'qwen/qwen3.8-27b').trim(),
        temperature: 0.1,
        max_tokens: 450,
        messages: [{ role: 'system', content: prompt }, { role: 'user', content: message }],
      }),
      signal: AbortSignal.timeout(12_000),
    });
    if (response.ok) {
      const data = await response.json();
      const answer = String(data?.choices?.[0]?.message?.content || '').trim();
      if (answer) return answer.slice(0, 4000);
    } else {
      console.error('[admin-ai] Model request failed:', response.status);
    }
  } catch (error) {
    console.error('[admin-ai] Model request failed:', error?.message || error);
  }
  return buildAdminFallbackAnswer(intent, report);
}

export default async function adminAI(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
  const admin = await requireAdmin(req);
  checkRateLimit(admin.uid);
  const message = typeof req.body?.message === 'string' ? req.body.message.trim().slice(0, 1000) : '';
  if (!message) throw clientError('Enter a question for Admin AI.');
  const intent = classifyAdminQuestion(message);
  const report = await loadReportData();
  const answer = await askModel(message, intent, report);
  // Audit only the actor, intent and length; never store the raw prompt or report.
  try {
    await adminDb.collection('adminAiAudit').add({
      actorUid: admin.uid,
      intent,
      messageLength: message.length,
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (error) {
    console.error('[admin-ai] Audit write failed:', error?.message || error);
  }
  return res.status(200).json({ answer, intent, report, readOnly: true });
}
