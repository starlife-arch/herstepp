// Dispatch area file for /api/admin — ONE serverless function, routes by
// ?route=<name> (see vercel.json rewrites). All handlers require an ADMIN
// token inside api/_lib/routes/*.
import { dispatchRoute, lazyRoute } from './_lib/route-dispatch.js';

export default (req, res) => dispatchRoute(req, res, {
  // GET/POST /api/admin/products
  products: lazyRoute(() => import('./_lib/routes/admin-products.js').then(m => ({ default: m.products }))),
  // PUT /api/admin/products/:id
  'product-update': lazyRoute(() => import('./_lib/routes/admin-products.js').then(m => ({ default: m.productUpdate }))),
  // POST /api/admin/products/:id/archive
  'product-archive': lazyRoute(() => import('./_lib/routes/admin-products.js').then(m => ({ default: m.productArchive }))),
  // GET /api/admin/customers
  customers: lazyRoute(() => import('./_lib/routes/admin-products.js').then(m => ({ default: m.customers }))),
  // /api/admin/categories
  categories: lazyRoute(() => import('./_lib/routes/admin-categories.js')),
  // POST /api/media/sign-upload
  'media/sign-upload': lazyRoute(() => import('./_lib/routes/admin-media.js')),
  // GET/PATCH /api/admin/orders
  orders: lazyRoute(() => import('./_lib/routes/orders-phase1.js').then(m => ({ default: m.adminOrders }))),
  // GET /api/admin/notifications — email/Telegram config status + outbox stats.
  'notifications': lazyRoute(() => import('./_lib/routes/admin-notifications.js').then(m => ({ default: m.notificationStatus }))),
  // POST /api/admin/notifications/test — {channel:'email'|'telegram', to?}
  'notifications/test': lazyRoute(() => import('./_lib/routes/admin-notifications.js').then(m => ({ default: m.notificationTest }))),
  // POST /api/admin/notifications/retry — retry PENDING outbox emails
  'notifications/retry': lazyRoute(() => import('./_lib/routes/admin-notifications.js').then(m => ({ default: m.notificationRetry }))),
  // GET/PATCH /api/admin/delivery
  delivery: lazyRoute(() => import('./_lib/routes/admin-delivery.js')),
});
