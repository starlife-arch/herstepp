import { clientError, sendError } from './http.js';

export function lazyRoute(load) {
  return { load };
}

export async function dispatchRoute(req, res, routes) {
  const requestedRoute = Array.isArray(req.query?.route) ? req.query.route[0] : req.query?.route;
  const route = typeof requestedRoute === 'string' ? routes[requestedRoute] : undefined;

  if (!route) {
    return res.status(404).json({ error: 'Endpoint not found.' });
  }

  // sendError logs the route name with every 5xx — make it available.
  try {
    if (res.locals) res.locals.route = requestedRoute;
  } catch { /* some minimal res objects have no locals */ }

  // CACHE POLICY (Firestore read-quota guard): every response starts as
  // "private, no-store" so authenticated/admin data is NEVER cached by a CDN
  // or browser. Public read-only routes opt into shared caching by calling
  // setPublicCache(res) in their handler (catalog-products, checkout config…).
  try {
    res.setHeader('Cache-Control', 'private, no-store');
  } catch { /* minimal res objects without setHeader */ }

  try {
    const module = await route.load();
    if (typeof module.default !== 'function') {
      throw clientError('Endpoint not found.', 404);
    }
    return await module.default(req, res);
  } catch (error) {
    return sendError(res, error);
  }
}

// Mark a PUBLIC GET response cacheable at the edge for 60 s with a 300 s
// stale-while-revalidate window. Call this BEFORE sending the body. It also
// overrides the dispatcher's default "private, no-store".
export function setPublicCache(res) {
  try {
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
  } catch { /* minimal res objects without setHeader */ }
}
