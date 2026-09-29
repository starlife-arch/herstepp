import { dispatchRoute, lazyRoute } from './_lib/route-dispatch.js';

export default (req, res) => dispatchRoute(req, res, {
  'auth/sync-profile': lazyRoute(() => import('./_lib/routes/sync-profile.js')),
});
