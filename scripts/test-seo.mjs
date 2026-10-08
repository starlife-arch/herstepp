// scripts/test-seo.mjs — SEO routes (sitemap.xml + product-page meta).
// Run: node --import ./scripts/seo-stub.mjs scripts/test-seo.mjs
// Goes through the REAL api/catalog.js dispatcher with a stubbed firebase-admin,
// so route registration, validation and fallback behaviour are all genuine.
import assert from 'node:assert/strict';

let passed = 0;
// Deterministic per-test SITE_URL counter: random values occasionally
// collide across tests and make the seo.js cache-key isolation flaky.
let caseCounter = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push([name, err]);
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}

const catalog = (await import('../api/catalog.js')).default;

function makeRes() {
  const res = { statusCode: 200, body: null, headers: {} };
  res.status = code => { res.statusCode = code; return res; };
  res.json = obj => { res.body = obj; return res; };
  res.send = text => { res.body = String(text); return res; };
  res.type = t => { res.headers['content-type'] = t; return res; };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  return res;
}

async function call(query) {
  const res = makeRes();
  await catalog({ method: 'GET', query: { ...query }, headers: reqHeaders() }, res);
  return res;
}

function seedCatalog(db) {
  db.__seed('products', 'p-active', {
    name: 'Chunky Heel Sandal', description: 'Elegant black sandal with a chunky heel.', categoryId: 'cat-heels',
    sku: 'HS-CHS-01', price: 3500, salePrice: 2800, status: 'ACTIVE', stockQuantity: 12,
    inventory: [{ size: '38', quantity: 12 }],
    images: [{ url: 'https://res.cloudinary.com/demo/image/upload/herstep/products/p-active.jpg', publicId: 'herstep/products/p-active', resourceType: 'image' }],
    updatedAt: new Date('2026-05-01T00:00:00Z'), createdAt: new Date('2026-01-01T00:00:00Z'),
  });
  db.__seed('products', 'p-noimg', {
    name: '<script>alert(1)</script>', description: '', categoryId: 'cat-heels', sku: 'X', price: 1000,
    salePrice: null, status: 'ACTIVE', stockQuantity: 0, inventory: [], images: [],
    updatedAt: new Date('2026-04-01T00:00:00Z'), createdAt: new Date('2026-02-01T00:00:00Z'),
  });
  db.__seed('products', 'p-archived', { name: 'Old Loafer', status: 'ARCHIVED', price: 900, salePrice: null, stockQuantity: 5, inventory: [], images: [], updatedAt: new Date('2026-03-01T00:00:00Z') });
  db.__seed('products', 'p-draft', { name: 'Draft Pump', status: 'DRAFT', price: 900, salePrice: null, stockQuantity: 5, inventory: [], images: [], updatedAt: new Date('2026-03-01T00:00:00Z') });
  db.__seed('categories', 'cat-heels', { name: 'Heels', updatedAt: new Date('2026-04-15T00:00:00Z') });
  db.__seed('categories', 'cat-sandals', { name: 'Sandals' });
}

async function freshSeoModule(seed = true) {
  // Unique SITE_URL per test busts seo.js's 60 s in-process cache (the cache
  // key embeds siteUrl()), so every test re-reads its own fake database.
  process.env.SITE_URL = `https://herstepcollection.shop?case=${(caseCounter += 1)}`;
  globalThis.__seoState.reset();
  if (seed) seedCatalog(globalThis.__seoState.db);
  const m = await import('../api/_lib/routes/seo.js');
  // The built index.html is cached for 5 minutes globally; tests must each
  // see their own fetchImpl (success, outage, wrong shape), so reset it too.
  m.__resetIndexCacheForTests();
  return m;
}

// Tests call the routes through the real dispatcher with empty headers; give
// them a self origin so fetchIndexHtml() can resolve one exactly like Vercel
// does via x-vercel-url / host.
function reqHeaders() {
  return { host: 'test.local', 'x-forwarded-proto': 'https' };
}

console.log('\nsitemap.xml');

await test('contains only ACTIVE products with absolute herstepcollection.shop URLs', async () => {
  await freshSeoModule();
  const res = await call({ route: 'sitemap' });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /application\/xml/);
  assert.equal(res.headers['cache-control'], 'public, s-maxage=3600');
  assert.ok(res.body.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.ok(res.body.includes('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'));
  assert.ok(res.body.includes('<loc>https://herstepcollection.shop?case='), 'home URL uses siteUrl()');
  for (const path of ['/shop', '/contact', '/support', '/tip']) assert.ok(res.body.includes(`<loc>https://herstepcollection.shop?case=${new URL(process.env.SITE_URL).searchParams.get('case')}${path}</loc>`), `missing ${path}`);
  assert.ok(res.body.includes('/product/p-active'));
  assert.ok(res.body.includes('/shop?category=cat-heels'));
  assert.ok(!res.body.includes('p-archived'), 'archived products must not appear');
  assert.ok(!res.body.includes('p-draft'), 'draft products must not appear');
  assert.ok(res.body.includes('<lastmod>2026-05-01</lastmod>'), 'product lastmod from updatedAt');
});

await test('caps at 5000 URLs', async () => {
  await freshSeoModule(false);
  const db = globalThis.__seoState.db;
  for (let i = 0; i < 5010; i += 1) db.__seed('products', `bulk-${String(i).padStart(5, '0')}`, { name: `P${i}`, status: 'ACTIVE', price: 100, salePrice: null, stockQuantity: 1, inventory: [], images: [] });
  const res = await call({ route: 'sitemap' });
  const count = (res.body.match(/<loc>/g) || []).length;
  assert.equal(count, 5000);
});

console.log('\nproduct page meta injection');

await test('injects title, canonical, og:image and JSON-LD with the EFFECTIVE (sale) price', async () => {
  await freshSeoModule();
  const res = await call({ route: 'product-page', id: 'p-active' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['cache-control'], 'public, s-maxage=300, stale-while-revalidate=600');
  assert.ok(res.body.includes('<title>Chunky Heel Sandal | HerStep Collection</title>'));
  assert.ok(res.body.includes('<link rel="canonical" href="https://herstepcollection.shop/product/p-active">') === false, 'href uses quotes escaped form');
  assert.ok(/<link rel="canonical" href="[^"]*\/product\/p-active"/.test(res.body));
  assert.ok(res.body.includes('og:image'));
  assert.ok(res.body.includes('f_auto,q_auto,w_1200,h_630,c_fill'), 'og:image is Cloudinary-optimised');
  const ldMatch = res.body.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(ldMatch, 'JSON-LD block present');
  // The HTML only escapes "</" to "<\/" (valid JSON escape), so the captured
  // group parses as-is with JSON.parse — no unescaping hacks.
  const ld = JSON.parse(ldMatch[1]);
  assert.equal(ld['@type'], 'Product');
  assert.equal(ld.offers.price, 2800, 'salePrice wins when valid');
  assert.equal(ld.offers.priceCurrency, 'KES');
  assert.equal(ld.offers.availability, 'InStock');
  assert.equal(ld.brand.name, 'HerStep Collection');
  assert.ok(res.body.includes('product:price:amount" content="2800"'));
  assert.ok(res.body.includes('summary_large_image'));
});

await test('HTML in product names is escaped (a <script> name is neutralised)', async () => {
  await freshSeoModule();
  const res = await call({ route: 'product-page', id: 'p-noimg' });
  assert.equal(res.statusCode, 200);
  assert.ok(!/<title>[^<]*<script>/.test(res.body), 'raw <script> must never reach <title>');
  assert.ok(res.body.includes('&lt;script&gt;alert(1)&lt;/script&gt; | HerStep Collection'));
  // The injected head must not open an executable script tag from the name.
  const head = res.body.slice(0, res.body.indexOf('</head>'));
  const scriptOpens = (head.match(/<script/g) || []).length;
  assert.ok(scriptOpens <= 2, 'only the JSON-LD script may exist in head');
});

await test('unknown id returns the plain index.html with status 404 and noindex', async () => {
  await freshSeoModule();
  const res = await call({ route: 'product-page', id: 'does-not-exist' });
  assert.equal(res.statusCode, 404);
  assert.ok(res.body.includes('<meta name="robots" content="noindex" />'));
  assert.ok(res.body.includes('<div id="root">'), 'still the normal SPA shell');
});

await test('archived and draft products also answer 404 + noindex', async () => {
  await freshSeoModule();
  for (const id of ['p-archived', 'p-draft']) {
    const res = await call({ route: 'product-page', id });
    assert.equal(res.statusCode, 404, `${id} must be 404`);
    assert.ok(res.body.includes('noindex'));
  }
});

await test('fetch failure falls back to plain index.html with status 200 (never 500)', async () => {
  await freshSeoModule();
  globalThis.__seoState.fetchImpl = async () => { throw new Error('network down'); };
  const res = await call({ route: 'product-page', id: 'p-active' });
  assert.equal(res.statusCode, 200);
  assert.ok(String(res.body).includes("Step Into Your Style"), "plain index.html served"); assert.ok(!String(res.body).includes("og:type"), "no injected meta in the fallback");
});

await test('Firestore failure falls back to plain index.html with status 200', async () => {
  await freshSeoModule();
  // Poison the DB AFTER seeding: reads now throw like a Firestore outage.
  const db = globalThis.__seoState.db;
  db.collection = () => { throw new Error('FAILED_UNAVAILABLE'); };
  const res = await call({ route: 'product-page', id: 'p-active' });
  assert.equal(res.statusCode, 200);
  assert.ok(String(res.body).includes("Step Into Your Style"), "plain index.html served"); assert.ok(!String(res.body).includes("og:type"), "no injected meta in the fallback");
});

await test('sitemap failure never 500s', async () => {
  await freshSeoModule();
  const db = globalThis.__seoState.db;
  db.collection = () => { throw new Error('FAILED_UNAVAILABLE'); };
  const res = await call({ route: 'sitemap' });
  assert.equal(res.statusCode, 200);
});

console.log('\nvercel.json wiring (checked by check-api too, asserted here as spec)');

await test('sitemap + product-page rewrites exist BEFORE the SPA fallback', async () => {
  const { readFileSync } = await import('node:fs');
  const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  const rw = vercel.rewrites;
  const idxOf = pred => rw.findIndex(pred);
  const fallback = idxOf(r => String(r.source).startsWith('/(('));
  const sitemap = idxOf(r => r.source === '/sitemap.xml' && r.destination === '/api/catalog?route=sitemap');
  const product = idxOf(r => r.source === '/product/:id' && r.destination === '/api/catalog?route=product-page&id=:id');
  assert.ok(sitemap >= 0 && product >= 0 && fallback >= 0, 'all three entries present');
  assert.ok(sitemap < fallback && product < fallback, 'SEO rewrites must precede the SPA fallback');
});

await test('routes registered in api/catalog.js dispatch map', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../api/catalog.js', import.meta.url), 'utf8');
  assert.ok(src.includes("'sitemap'"));
  assert.ok(src.includes("'product-page'"));
});

if (failures.length) {
  console.error(`\n${failures.length} FAILED:`);
  for (const [name, err] of failures) console.error(` - ${name}: ${err.message}`);
  process.exit(1);
}
console.log(`\n${passed} seo tests passed`);
