// Automatic product sitemap. The Firebase module is loaded inside the
// handler so configuration/import failures are caught and can never crash
// the Vercel Function before it sends a valid XML response.

const CANONICAL = 'https://www.herstepcollection.shop';

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

function emptyXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
</urlset>
`;
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

    const urls = snapshot.docs.map(doc => {
      const product = doc.data() || {};
      const loc = `${CANONICAL}/product/${encodeURIComponent(doc.id)}`;
      const lastmod = lastmodOf(product);
      return `  <url><loc>${xmlEscape(loc)}</loc>${lastmod ? `<lastmod>${xmlEscape(lastmod)}</lastmod>` : ''}</url>`;
    });

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join('\n')}
</urlset>
`;

    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    return res.status(200).send(xml);
  } catch (error) {
    console.error('[sitemap-products] failed:', error?.message || error);
    res.setHeader('Cache-Control', 'public, s-maxage=300');
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    return res.status(200).send(emptyXml());
  }
}
