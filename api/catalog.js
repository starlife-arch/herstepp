import { dispatchRoute, lazyRoute } from './_lib/route-dispatch.js';

export default (req, res) => dispatchRoute(req, res, {
  'firebase-config': lazyRoute(() => import('./_lib/routes/firebase-config.js')),
  health: lazyRoute(() => import('./_lib/routes/health.js')),
});
