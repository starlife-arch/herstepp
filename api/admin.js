// Dispatch area file for /api/admin — ONE serverless function, routes by
// ?route=<name> (see vercel.json rewrites). All handlers require an ADMIN
// token inside api/_lib/routes/*.
import { dispatchRoute, lazyRoute } from './_lib/route-dispatch.js';

export default (req, res) => dispatchRoute(req, res, {
  products: lazyRoute(() => import('./_lib/routes/admin-products.js').then(m => ({ default: m.products }))),
  'product-update': lazyRoute(() => import('./_lib/routes/admin-products.js').then(m => ({ default: m.productUpdate }))),
  'product-archive': lazyRoute(() => import('./_lib/routes/admin-products.js').then(m => ({ default: m.productArchive }))),
  customers: lazyRoute(() => import('./_lib/routes/admin-products.js').then(m => ({ default: m.customers }))),
  categories: lazyRoute(() => import('./_lib/routes/admin-categories.js')),
  'media/sign-upload': lazyRoute(() => import('./_lib/routes/admin-media.js')),
  'bulk-shoes/analyze': lazyRoute(() => import('./_lib/routes/admin-bulk-shoe-ai.js')),
  orders: lazyRoute(() => import('./_lib/routes/orders-phase1.js').then(m => ({ default: m.adminOrders }))),
  'promo-codes': lazyRoute(() => import('./_lib/routes/admin-promo-codes.js')),
  support: lazyRoute(() => import('./_lib/routes/support.js').then(m => ({ default: m.adminList }))),
  'support/status': lazyRoute(() => import('./_lib/routes/support.js').then(m => ({ default: m.adminStatus }))),
  'support/read': lazyRoute(() => import('./_lib/routes/support.js').then(m => ({ default: m.adminRead }))),
  'support/messages': lazyRoute(() => import('./_lib/routes/support.js').then(m => ({ default: m.adminMessage }))),
  'support/notes': lazyRoute(() => import('./_lib/routes/support.js').then(m => ({ default: m.adminNotes }))),
  hero: lazyRoute(() => import('./_lib/routes/admin-storefront.js').then(m => ({ default: m.adminHero }))),
  announcement: lazyRoute(() => import('./_lib/routes/admin-storefront.js').then(m => ({ default: m.adminAnnouncement }))),
  'contact-messages': lazyRoute(() => import('./_lib/routes/admin-contact.js').then(m => ({ default: m.adminList }))),
  'contact-messages/status': lazyRoute(() => import('./_lib/routes/admin-contact.js').then(m => ({ default: m.adminStatus }))),
  'contact-messages/reply': lazyRoute(() => import('./_lib/routes/admin-contact.js').then(m => ({ default: m.adminReply }))),
  notifications: lazyRoute(() => import('./_lib/routes/admin-notifications.js').then(m => ({ default: m.notificationStatus }))),
  'notifications/test': lazyRoute(() => import('./_lib/routes/admin-notifications.js').then(m => ({ default: m.notificationTest }))),
  'notifications/retry': lazyRoute(() => import('./_lib/routes/admin-notifications.js').then(m => ({ default: m.notificationRetry }))),
  delivery: lazyRoute(() => import('./_lib/routes/admin-delivery.js')),
  tips: lazyRoute(() => import('./_lib/routes/tips-admin.js')),
  'invoices/resend': lazyRoute(() => import('./_lib/routes/invoice-resend.js')),
});
