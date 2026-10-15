// Automatic product sitemap. Never return an empty sitemap with HTTP 200:
// Google can cache it as a successfully fetched sitemap and report a missing
// <url> element. A temporary database failure should instead invite a retry.

const CANONICAL = 'https://www.herstepcollection.shop';

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function slugifyProductName(name) {
  return String(name || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100).replace(/-+$/g, '');
}

function lastmodOf(product) {
  const value = product?.updatedAt || product?.createdAt;
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function unavailable(res, reason) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  return res.status(503).send(reason);
}

export default async function productSitemap(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).send('Method not allowed.');
  }

  try {
    const { adminDb } = await import('./_lib/firebase-admin.js');
    const snapshot = await adminDb
      .collection('products')
      .where('status', '==', 'ACTIVE')
      .limit(5000)
      .get();

    const seen = new Set();
    const urls = [];
    for (const doc of snapshot.docs) {
      const product = doc.data() || {};
      const slug = slugifyProductName(product.name);
      if (!slug) continue;
      const loc = `${CANONICAL}/product/${encodeURIComponent(slug)}`;
      if (seen.has(loc)) continue;
      seen.add(loc);
      const lastmod = lastmodOf(product);
      urls.push(`  <url><loc>${xmlEscape(loc)}</loc>${lastmod ? `<lastmod>${xmlEscape(lastmod)}</lastmod>` : ''}</url>`);
    }

    if (urls.length === 0) {
      console.error('[sitemap-products] no active named products were returned');
      return unavailable(res, 'Product sitemap is temporarily unavailable. Please retry shortly.');
    }

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join('\n')}
</urlset>
`;

    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    return res.status(200).send(xml);
  } catch (error) {
    console.error('[sitemap-products] failed:', error?.message || error);
    return unavailable(res, 'Product sitemap is temporarily unavailable. Please retry shortly.');
  }
}
