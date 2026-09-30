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
