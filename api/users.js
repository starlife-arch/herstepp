import { dispatchRoute, lazyRoute } from './_lib/route-dispatch.js';

export default (req, res) => dispatchRoute(req, res, {
  'auth/sync-profile': lazyRoute(() => import('./_lib/routes/sync-profile.js')),
  'auth/verify/send': lazyRoute(() => import('./_lib/routes/email-verify.js').then(m => ({ default: m.verifySend }))),
  'auth/verify/confirm': lazyRoute(() => import('./_lib/routes/email-verify.js').then(m => ({ default: m.verifyConfirm }))),
  dashboard: lazyRoute(() => import('./_lib/routes/dashboard.js').then(m => ({ default: m.dashboard }))),
  notifications: lazyRoute(() => import('./_lib/routes/dashboard.js').then(m => ({ default: m.notifications }))),
  support: lazyRoute(() => import('./_lib/routes/support.js').then(m => ({ default: m.list }))),
  'support/create': lazyRoute(() => import('./_lib/routes/support.js').then(m => ({ default: m.create }))),
  'support/messages': lazyRoute(() => import('./_lib/routes/support.js').then(m => ({ default: m.message }))),
  'support/sign-upload': lazyRoute(() => import('./_lib/routes/support-sign-upload.js')),
  // POST /api/contact — public contact form (no login required)
  contact: lazyRoute(() => import('./_lib/routes/contact.js')),
});
