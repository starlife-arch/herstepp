// Dispatch area file for /api/orders — ONE serverless function, routes by
// ?route=<name> (see vercel.json rewrites). Handlers live in
// api/_lib/routes/* so the layout stays readable and testable.
import { dispatchRoute, lazyRoute } from './_lib/route-dispatch.js';

export default (req, res) => dispatchRoute(req, res, {
  // GET /api/orders/track
  track: lazyRoute(() => import('./_lib/routes/orders-phase1.js').then(m => ({ default: m.track }))),
  // POST /api/orders/create + GET /api/orders/config
  create: lazyRoute(() => import('./_lib/routes/orders-create.js').then(m => ({ default: m.create }))),
  config: lazyRoute(() => import('./_lib/routes/orders-create.js').then(m => ({ default: m.config }))),
  // POST /api/promo/validate (rewritten here to keep promo logic near checkout)
  'promo/validate': lazyRoute(() => import('./_lib/routes/promo-validate.js')),
  // GET /api/invoices/download?orderDocumentId= (requireUser; owner or admin)
  'invoices/download': lazyRoute(() => import('./_lib/routes/invoices.js')),
});
