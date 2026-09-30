export function clientError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

export function methodNotAllowed(res, allowed) {
  res.setHeader('Allow', Array.isArray(allowed) ? allowed.join(', ') : allowed);
  return res.status(405).json({ error: 'Method not allowed.' });
}

// Every 5xx logs the FULL error (message + stack) plus the route name so Vercel
// logs are actionable. The client only ever sees a generic message.
export function sendError(res, error) {
  const statusCode = error?.statusCode || 500;
  let routeName = 'unknown';
  try {
    routeName = res?.locals?.route || 'unknown';
  } catch { /* minimal res objects without locals */ }

  if (statusCode >= 500) {
    console.error(`[api:${routeName}] ${error?.message ?? 'Unknown error'}`, error?.stack ?? error);
  }

  return res.status(statusCode).json({
    error: statusCode >= 500 ? 'We could not complete that request.' : error.message,
  });
}
