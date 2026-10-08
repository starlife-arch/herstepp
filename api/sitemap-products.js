// Public automatic product sitemap.
// Uses the existing public /api/products endpoint so this sitemap does not
// depend directly on the Firebase Admin module. New ACTIVE products are
// therefore picked up automatically.
import { siteUrl } from './_lib/site-url.js';

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function lastmodOf(product) {
  const value = product?.updatedAt || product?.createdAt;
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function requestOrigin(req) {
  const host = req?.headers?.host;
  if (!host) return siteUrl();
  const proto = String(req?.headers?.['x-forwarded-proto'] || 'https').split(',')[0].trim();
  return `${proto || 'https'}://${host}`;
}

export default async function productSitemap(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).send('Method not allowed.');
  }

  try {
    const origin = requestOrigin(req);
    const response = await fetch(`${origin}/api/products`, {
      headers: { 'user-agent': 'herstep-sitemap/1.0' },
    });

    if (!response.ok) {
      throw new Error(`/api/products returned ${response.status}`);
    }

    const products = await response.json();
    const base = siteUrl();
    const items = Array.isArray(products) ? products.slice(0, 5000) : [];

    const urls = items.map(product => {
      const loc = `${base}/product/${encodeURIComponent(String(product.id || ''))}`;
      const lastmod = lastmodOf(product);
      return `  <url><loc>${xmlEscape(loc)}</loc>${lastmod ? `<lastmod>${xmlEscape(lastmod)}</lastmod>` : ''}</url>`;
    });

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join('\n')}
</urlset>
`;

    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).type('application/xml').send(xml);
  } catch (error) {
    console.error('[sitemap-products] failed:', error?.message || error);

    // Return valid XML even if the product API is temporarily unavailable.
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
</urlset>
`;

    res.setHeader('Cache-Control', 'public, s-maxage=300');
    return res.status(200).type('application/xml').send(xml);
  }
}
