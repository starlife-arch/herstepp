// SEO routes (registered in api/catalog.js): sitemap.xml and server-rendered
// product-page <head> meta so crawlers/social unfurlers see per-product data
// even though the site is a Vite SPA. Read-only; never 500s — any failure
// falls back to plain index.html with status 200.
import { adminDb } from '../firebase-admin.js';
import { methodNotAllowed } from '../http.js';
import { siteUrl } from '../site-url.js';

// Firestore Timestamps expose toDate(); the fake DB returns ISO strings and
// real Dates can arrive through test seeding. Accept all three shapes.
const toIso = (v) => {
  if (!v) return null;
  if (typeof v === 'string' || typeof v === 'number') return new Date(v).toISOString();
  if (v.toDate) return v.toDate().toISOString();
  if (v instanceof Date) return v.toISOString();
  return null;
};
const iso = v => toIso(v);
function serialize(value) {
  if (value?.toDate) return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(serialize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, serialize(v)]));
  return value;
}

// --- shared cached catalogue loader ----------------------------------------
// Same 60 s in-process TTL pattern as catalog-products.js: the sitemap and the
// product pages reuse these lists, so they add almost no extra Firestore reads.
const ttlMs = 60_000;
const cache = new Map(); // key -> { value, expiresAt }

async function cached(key, loader) {
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  const value = await loader();
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

export function invalidateSeoCache() {
  cache.clear();
}

async function loadActiveProducts() {
  return cached(`seo:products@${siteUrl()}`, async () => {
    const snapshot = await adminDb.collection('products').where('status', '==', 'ACTIVE').limit(5000).get();
    return snapshot.docs.map(doc => ({ id: doc.id, ...serialize(doc.data()) }));
  });
}

async function loadCategories() {
  return cached(`seo:categories@${siteUrl()}`, async () => {
    const snapshot = await adminDb.collection('categories').limit(500).get();
    return snapshot.docs.map(doc => ({ id: doc.id, ...serialize(doc.data()) }));
  });
}

async function loadProduct(id) {
  return cached(`seo:product:${id}@${siteUrl()}`, async () => {
    const doc = await adminDb.collection('products').doc(id).get();
    if (!doc.exists) return null;
    return { id: doc.id, ...serialize(doc.data()) };
  });
}

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function lastmodOf(item) {
  const d = iso(item.updatedAt) || iso(item.createdAt);
  return d ? d.slice(0, 10) : null;
}

// --- GET /sitemap.xml ---------------------------------------------------------
export async function sitemap(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
  let xml;
  try {
    // Absolute URLs use siteUrl() (the canonical production domain), but the
    // index.html fallback fetch uses the request's OWN origin only — see
    // selfOrigin(): fetching SITE_URL from a preview deployment is an
    // external hop that can fail and was the cause of the live 500.
    const base = siteUrl();
    const [products, categories] = await Promise.all([loadActiveProducts(), loadCategories()]);
    const urls = [];
    const push = (loc, lastmod) => {
      if (urls.length >= 5000) return;
      urls.push(`  <url><loc>${xmlEscape(loc)}</loc>${lastmod ? `<lastmod>${xmlEscape(lastmod)}</lastmod>` : ''}</url>`);
    };
    push(`${base}/`, null);
    push(`${base}/shop`, null);
    push(`${base}/contact`, null);
    push(`${base}/support`, null);
    push(`${base}/tip`, null);
    for (const category of categories) push(`${base}/shop?category=${encodeURIComponent(category.id)}`, lastmodOf(category));
    for (const product of products) push(`${base}/product/${encodeURIComponent(product.id)}`, lastmodOf(product));
    xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
  } catch (error) {
    console.error('[seo] sitemap failed:', error?.message || error);
    // Always return valid XML so Google never receives the SPA HTML as a sitemap.
    const base = siteUrl();
    const fallbackUrls = ['/', '/shop', '/contact', '/support', '/tip']
      .map(path => `  <url><loc>${xmlEscape(`${base}${path}`)}</loc></url>`)
      .join('\n');
    const fallbackXml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${fallbackUrls}\n</urlset>\n`;
    res.setHeader('Cache-Control', 'public, s-maxage=300');
    return res.status(200).type('application/xml').send(fallbackXml);
  }
  res.setHeader('Cache-Control', 'public, s-maxage=3600');
  return res.status(200).type('application/xml').send(xml);
}


// --- GET /sitemap-products.xml -----------------------------------------------
// Automatically lists every active product page from Firestore. This keeps
// product discovery automatic when products are added or updated in the admin.
export async function productSitemap(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
  try {
    const base = siteUrl();
    const products = await loadActiveProducts();
    const urls = products.slice(0, 5000).map(product => {
      const loc = `${base}/product/${encodeURIComponent(product.id)}`;
      const lastmod = lastmodOf(product);
      return `  <url><loc>${xmlEscape(loc)}</loc>${lastmod ? `<lastmod>${xmlEscape(lastmod)}</lastmod>` : ''}</url>`;
    });
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).type('application/xml').send(xml);
  } catch (error) {
    console.error('[seo] product sitemap failed:', error?.message || error);
    const base = siteUrl();
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n</urlset>\n`;
    res.setHeader('Cache-Control', 'public, s-maxage=300');
    return res.status(200).type('application/xml').send(xml);
  }
}

const FALLBACK_HTML = '<!doctype html><html lang="en"><head><title>HerStep Collection | Step Into Your Style</title></head><body><div id="root"></div></body></html>';

// --- built index.html (static file, cached 5 minutes) -------------------------
let indexCache = null; // { html, expiresAt }

// The ORIGIN of the current request only — never siteUrl(). On preview
// deployments SITE_URL points at production, and fetching the prod domain
// from a function is an external hop that can hang or fail (that was the
// live /sitemap.xml 500). x-vercel-url is present on every Vercel request.
function selfOrigin(req) {
  const raw = req?.headers?.['x-vercel-url'];
  if (typeof raw === 'string' && raw.startsWith('http')) {
    try { return new URL(raw).origin; } catch { /* fall through */ }
  }
  const host = req?.headers?.host;
  if (typeof host === 'string' && host) {
    const proto = String(req?.headers?.['x-forwarded-proto'] || 'https').split(',')[0].trim();
    return `${proto || 'https'}://${host}`;
  }
  return null;
}

async function fetchIndexHtml(req) {
  if (indexCache && indexCache.expiresAt > Date.now()) return indexCache.html;
  const origin = selfOrigin(req);
  if (!origin) throw new Error('cannot determine own origin for index.html');
  const response = await fetch(`${origin}/index.html`, { headers: { 'user-agent': 'herstep-seo/1.0' } });
  if (!response.ok) throw new Error(`index.html fetch status ${response.status}`);
  const html = await response.text();
  if (!/<title>[\s\S]*?<\/title>/i.test(html)) throw new Error('index.html has no <title>');
  indexCache = { html, expiresAt: Date.now() + 5 * 60_000 };
  return html;
}

export function __resetIndexCacheForTests() {
  indexCache = null;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function effectivePrice(product) {
  const price = Number(product.price) || 0;
  const sale = Number(product.salePrice);
  if (Number.isFinite(sale) && sale > 0 && sale < price) return sale;
  return price;
}

function stockStatus(product) {
  const qty = Number(product.stockQuantity);
  const out = Number.isFinite(qty) ? qty <= 0 : !(product.inventory || []).some(line => Number(line.quantity) > 0);
  return out ? 'OutOfStock' : 'InStock';
}

function cloudinaryOptimised(url) {
  const raw = String(url || '');
  if (!raw.includes('/upload/')) return raw;
  return raw.replace('/upload/', '/upload/f_auto,q_auto,w_1200,h_630,c_fill/');
}

function buildHead(product, canonical) {
  const name = escapeHtml(product.name || 'Product');
  const descSource = String(product.description || '').trim();
  const description = escapeHtml(
    (descSource ? descSource.slice(0, 155) : `${product.name || 'Product'} - ladies' footwear in Juja Town. Pay with M-Pesa.`)
  );
  const image = cloudinaryOptimised((product.images || [])[0]?.url || '');
  const price = effectivePrice(product);
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.name || 'Product',
    image: (product.images || []).map(img => img.url).filter(Boolean),
    description: descSource,
    sku: product.sku || '',
    brand: { '@type': 'Brand', name: 'HerStep Collection' },
    offers: {
      '@type': 'Offer',
      price,
      priceCurrency: 'KES',
      availability: stockStatus(product),
      url: canonical,
      itemCondition: 'https://schema.org/NewCondition',
    },
  };
  // A "</" sequence inside JSON-LD would close the <script> block early;
  // escape ONLY that sequence to "<\/" (valid JSON, safe HTML). Replacing a
  // bare "</" or "<" everywhere corrupts the JSON and breaks Google parsing.
  const ldText = JSON.stringify(jsonLd).replace(/<\//g, '<\\/');
  return [
    `<title>${name} | HerStep Collection</title>`,
    `<meta name="description" content="${description}" />`,
    `<link rel="canonical" href="${escapeHtml(canonical)}" />`,
    `<meta property="og:type" content="product" />`,
    `<meta property="og:title" content="${name} | HerStep Collection" />`,
    `<meta property="og:description" content="${description}" />`,
    `<meta property="og:url" content="${escapeHtml(canonical)}" />`,
    image ? `<meta property="og:image" content="${escapeHtml(image)}" />` : '',
    `<meta property="og:site_name" content="HerStep Collection" />`,
    `<meta property="product:price:amount" content="${price}" />`,
    `<meta property="product:price:currency" content="KES" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<script type="application/ld+json">${ldText}</script>`,
  ].filter(Boolean).join('\n    ');
}

function injectIntoHead(html, titleTag, extraTags) {
  let out = html;
  if (titleTag) out = out.replace(/<title>[\s\S]*?<\/title>/i, titleTag);
  const marker = out.match(/<\/title>/i);
  if (marker) {
    out = out.slice(0, marker.index + marker[0].length) + `\n    ${extraTags}` + out.slice(marker.index + marker[0].length);
  } else {
    out = out.replace(/<\/head>/i, `    ${extraTags}\n  </head>`);
  }
  return out;
}

// --- GET /product/:id -> route=product-page -----------------------------------
export async function productPage(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
  const id = Array.isArray(req.query.id) ? req.query.id[0] : req.query.id;
  let html;
  let status = 200;
  try {
    const base = siteUrl();
    const canonical = `${base}/product/${encodeURIComponent(String(id || ''))}`;
    const plain = await fetchIndexHtml(req);
    let product = null;
    try {
      if (typeof id === 'string' && id) product = await loadProduct(id);
    } catch (error) {
      console.error('[seo] product load failed:', error?.message || error);
      product = null;
    }
    if (!product || product.status !== 'ACTIVE') {
      // Unknown / archived / draft: normal index.html, status 404, noindex.
      status = 404;
      html = injectIntoHead(plain, null, '<meta name="robots" content="noindex" />');
    } else {
      const head = buildHead(product, canonical);
      const titleMatch = head.match(/<title>[\s\S]*?<\/title>/);
      html = injectIntoHead(plain, titleMatch ? titleMatch[0] : null, head.replace(/<title>[\s\S]*?<\/title>\n?/, ''));
    }
  } catch (error) {
    // Never a 500: fall back to plain index.html with status 200.
    console.error('[seo] product-page fallback:', error?.message || error);
    try {
      html = await fetchIndexHtml(req);
    } catch {
      html = FALLBACK_HTML;
    }
    status = 200;
  }
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
  return res.status(status).type('html').send(html);
}
