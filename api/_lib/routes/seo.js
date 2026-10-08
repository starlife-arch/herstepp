// SEO routes (registered in api/catalog.js): sitemap.xml and server-rendered
// product-page <head> meta so crawlers/social unfurlers see per-product data
// even though the site is a Vite SPA. Read-only; never 500s — any failure
// falls back to plain index.html with status 200.
import { adminDb } from '../firebase-admin.js';
import { methodNotAllowed } from '../http.js';
import { siteUrl } from '../site-url.js';

const iso = v => (v?.toDate ? v.toDate().toISOString() : v || null);
function serialize(value) {
  if (value?.toDate) return value.toDate().toISOString();
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
    return res.status(200).type('html').send(await fetchIndexHtml().catch(() => '<!doctype html>'));
  }
  res.setHeader('Cache-Control', 'public, s-maxage=3600');
  return res.status(200).type('application/xml').send(xml);
}

const FALLBACK_HTML = '<!doctype html><html lang="en"><head><title>HerStep Collection | Step Into Your Style</title></head><body><div id="root"></div></body></html>';

// --- built index.html (static file, cached 5 minutes) -------------------------
let indexCache = null; // { html, expiresAt }

async function fetchIndexHtml() {
  if (indexCache && indexCache.expiresAt > Date.now()) return indexCache.html;
  const response = await fetch(`${siteUrl()}/index.html`, { headers: { 'user-agent': 'herstep-seo/1.0' } });
  if (!response.ok) throw new Error(`index.html fetch status ${response.status}`);
  const html = await response.text();
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
  // "</script>" inside JSON-LD would break the block; escape it defensively.
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
    const plain = await fetchIndexHtml();
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
      html = await fetchIndexHtml();
    } catch {
      html = FALLBACK_HTML;
    }
    status = 200;
  }
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
  return res.status(status).type('html').send(html);
}
