// ONE site URL for every link that leaves the backend (emails, PDFs).
// Reads SITE_URL per call so a redeploy with new env takes effect instantly.
// Never put a hardcoded deployment URL in any other file — import this.
export const SITE_URL_DEFAULT = 'https://herstepcollection.shop';

export function siteUrl(env = globalThis.process?.env || {}) {
  return String(env.SITE_URL || SITE_URL_DEFAULT).trim().replace(/\/+$/, '');
}
