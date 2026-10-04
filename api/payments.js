// Dispatch area file for /api/payments — ONE serverless function, routes by
// ?route=<name> (see vercel.json rewrites). Every route name listed here must
// have a matching rewrite; every rewrite must point to a name registered here.
import { dispatchRoute, lazyRoute } from './_lib/route-dispatch.js';

export default (req, res) => dispatchRoute(req, res, {
  // POST /api/payments/stk/initiate
  'stk/initiate': lazyRoute(() => import('./_lib/routes/payments.js').then(m => ({ default: m.initiate }))),
  // GET /api/payments/status
  status: lazyRoute(() => import('./_lib/routes/payments.js').then(m => ({ default: m.status }))),
  // POST /api/payments/cancel — customer says "I cancelled / no prompt"
  cancel: lazyRoute(() => import('./_lib/routes/payments.js').then(m => ({ default: m.cancel }))),
  // POST /api/payments/mpesa/callback — public PrintPay webhook
  'mpesa/callback': lazyRoute(() => import('./_lib/routes/payments.js').then(m => ({ default: m.mpesaCallback }))),
  // GET /api/payments/receipt — owner only, PAID only
  receipt: lazyRoute(() => import('./_lib/routes/payments.js').then(m => ({ default: m.receipt }))),
  // ---- In-app tipping (tips are NOT orders; see api/_lib/tip-core.js) ----
  // POST /api/tips/create
  'tips/create': lazyRoute(() => import('./_lib/routes/tips.js').then(m => ({ default: m.tipsCreate }))),
  // GET /api/tips/status?tipId=
  'tips/status': lazyRoute(() => import('./_lib/routes/tips.js').then(m => ({ default: m.tipsStatus }))),
  // POST /api/tips/cancel {tipId}
  'tips/cancel': lazyRoute(() => import('./_lib/routes/tips.js').then(m => ({ default: m.tipsCancel }))),
  // GET /api/tips — the signed-in user's own tips
  'tips/list': lazyRoute(() => import('./_lib/routes/tips.js').then(m => ({ default: m.tipsList }))),
});
