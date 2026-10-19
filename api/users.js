import { dispatchRoute, lazyRoute } from './_lib/route-dispatch.js';

export default (req, res) => dispatchRoute(req, res, {
  'sellers/application': lazyRoute(() => import('./_lib/routes/seller-application.js')),
  'sellers/dashboard': lazyRoute(() => import('./_lib/routes/seller-dashboard.js')),
  'sellers/subscription': lazyRoute(() => import('./_lib/routes/seller-subscription.js')),
  'auth/sync-profile': lazyRoute(() => import('./_lib/routes/sync-profile.js')),
  'marketing/unsubscribe': lazyRoute(() => import('./_lib/routes/admin-email-campaigns.js').then(m => ({ default: m.marketingUnsubscribe }))),
  'marketing/sms-unsubscribe': lazyRoute(() => import('./_lib/routes/admin-sms-campaigns.js').then(m => ({ default: m.smsMarketingUnsubscribe }))),
  'auth/verify/send': lazyRoute(() => import('./_lib/routes/email-verify.js').then(m => ({ default: m.verifySend }))),
  'auth/verify/confirm': lazyRoute(() => import('./_lib/routes/email-verify.js').then(m => ({ default: m.verifyConfirm }))),
  refunds: lazyRoute(() => import('./_lib/routes/customer-refunds.js').then(m => ({ default: m.customerRefunds }))),
  'refunds/sign-upload': lazyRoute(() => import('./_lib/routes/refund-sign-upload.js')),
  dashboard: lazyRoute(() => import('./_lib/routes/dashboard.js').then(m => ({ default: m.dashboard }))),
  notifications: lazyRoute(() => import('./_lib/routes/dashboard.js').then(m => ({ default: m.notifications }))),
  reviews: lazyRoute(() => import('./_lib/routes/reviews.js')),
  'reviews/sign-upload': lazyRoute(() => import('./_lib/routes/review-sign-upload.js')),
  'restock-alerts': lazyRoute(() => import('./_lib/routes/restock-alerts.js')),
  wishlist: lazyRoute(() => import('./_lib/routes/wishlist.js')),
  'abandoned-cart/snapshot': lazyRoute(() => import('./_lib/routes/abandoned-cart.js').then(m => ({ default: m.snapshot }))),
  support: lazyRoute(() => import('./_lib/routes/support.js').then(m => ({ default: m.list }))),
  'support/create': lazyRoute(() => import('./_lib/routes/support.js').then(m => ({ default: m.create }))),
  'support/messages': lazyRoute(() => import('./_lib/routes/support.js').then(m => ({ default: m.message }))),
  'support/sign-upload': lazyRoute(() => import('./_lib/routes/support-sign-upload.js')),
  // POST /api/contact — public contact form (no login required)
  contact: lazyRoute(() => import('./_lib/routes/contact.js')),
});
