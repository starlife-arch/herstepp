// scripts/check-api.mjs — guard against deploy-breaking API errors.
//
// 1) `node --check` every .js/.mjs file under api/ (recursive) and scripts/.
//    Catches SyntaxErrors like duplicate const declarations that would make a
//    whole Vercel serverless module fail to load (every route -> 500).
// 2) Dynamic-import each api/*.js entry and each api/_lib/routes/*.js inside
//    try/catch with harmless dummy env vars, so IMPORT-TIME errors (missing
//    exports, bad top-level code) are caught too.
// 3) Vercel Hobby limits: at most 12 files directly under /api (excluding
//    _lib), and EVERY vercel.json rewrite must point to a ?route=<name> that
//    is actually registered in the matching area file (parsed both ways).
// Exits 1 if anything fails. Wired into "test" (first) and "prebuild".
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Generate a REAL (throwaway) RSA key pair so firebase-admin's cert() parses
// successfully at import time — initializeApp does NOT contact any server, so
// these harmless dummy credentials are never validated against anything.
import { generateKeyPairSync } from 'node:crypto';
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const privateKeyPem = privateKey;

Object.assign(process.env, {
  FIREBASE_ADMIN_PROJECT_ID: 'dummy-project',
  FIREBASE_ADMIN_CLIENT_EMAIL: 'dummy@example.invalid',
  // Real Vercel stores this with literal \n sequences; emulate that exactly.
  FIREBASE_ADMIN_PRIVATE_KEY: privateKeyPem.trim().replace(/\n/g, '\\n'),
  PRINTPAY_API_KEY: 'dummy-key',
});

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(js|mjs|ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

let failed = false;

// ---- Phase 1: syntax check -------------------------------------------------
const files = [...walk(path.join(root, 'api')), ...walk(path.join(root, 'scripts'))].filter(file => /\.(js|mjs)$/.test(file));
for (const file of files) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) {
    failed = true;
    console.error(`SYNTAX FAIL: ${path.relative(root, file)}\n${(r.stderr || '').trim()}\n`);
  }
}
console.log(`check-api: node --check on ${files.length} file(s): ${failed ? 'FAILURES above' : 'all OK'}`);

// ---- Phase 2: import check -------------------------------------------------
async function importCheck(file) {
  try {
    await import(pathToFileURL(file).href);
    return null;
  } catch (error) {
    return error;
  }
}

const importTargets = [
  ...walk(path.join(root, 'api')).filter(f => /\.js$/.test(f) && path.dirname(f) === path.join(root, 'api')), // api/*.js entries
  ...walk(path.join(root, 'api', '_lib', 'routes')).filter(f => /\.js$/.test(f)),                                        // all route modules
];

let importFails = 0;
for (const file of importTargets) {
  const error = await importCheck(file);
  if (error) {
    importFails += 1;
    failed = true;
    console.error(`IMPORT FAIL: ${path.relative(root, file)}\n  ${error?.stack || error}\n`);
  }
}
console.log(`check-api: dynamic import of ${importTargets.length} module(s): ${importFails ? `${importFails} FAILED` : 'all OK'}`);

// ---- Phase 3: Vercel Hobby limits ------------------------------------------
// (a) at most 12 .js files directly under /api (excluding _lib/) — the plan
//     allows 12 serverless functions.
const apiDir = path.join(root, 'api');
const areaFiles = readdirSync(apiDir).filter(n => {
  if (n.startsWith('.') || n === '_lib') return false;
  try { return statSync(path.join(apiDir, n)).isFile() && /\.js$/.test(n); } catch { return false; }
});
if (areaFiles.length > 12) {
  failed = true;
  console.error(`LIMIT FAIL: ${areaFiles.length} files directly under /api (Vercel Hobby allows 12): ${areaFiles.join(', ')}`);
} else {
  console.log(`check-api: ${areaFiles.length}/12 /api function files (OK)`);
}

// (b) every vercel.json rewrite destination "/api/<area>?route=<name>" must
//     have <name> registered in that area file's dispatch map. Route names are
//     parsed from the object keys of `dispatchRoute(req, res, { ... })`.
function routeNamesIn(areaFile) {
  const src = readFileSync(areaFile, 'utf8');
  const names = new Set();
  // Quoted or plain identifier keys followed by ':' inside the routes object.
  const re = /(?:^|[{,\s])('([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*:/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const key = m[2] || m[3] || m[4];
    if (!key || key === 'default' || key === 'then' || key === 'catch') continue;
    names.add(key);
  }
  return names;
}

let vercelJson;
try {
  vercelJson = JSON.parse(readFileSync(path.join(root, 'vercel.json'), 'utf8'));
} catch (error) {
  failed = true;
  console.error(`REWRITE FAIL: cannot parse vercel.json: ${error.message}`);
}
if (vercelJson) {
  const rewrites = Array.isArray(vercelJson.rewrites) ? vercelJson.rewrites : [];
  const cache = new Map();
  let rewriteFails = 0;
  for (const rw of rewrites) {
    const dest = String(rw?.destination || '');
    const match = dest.match(/^\/api\/([\w-]+)\?route=([^&]+)/);
    if (!match) continue; // non-dispatch destinations are not our concern here
    const [, area, routeName] = match;
    const decoded = decodeURIComponent(routeName);
    const file = path.join(apiDir, `${area}.js`);
    if (!existsSync(file)) {
      rewriteFails += 1;
      failed = true;
      console.error(`REWRITE FAIL: ${rw.source} -> /api/${area} does not exist`);
      continue;
    }
    if (!cache.has(area)) cache.set(area, routeNamesIn(file));
    if (!cache.get(area).has(decoded)) {
      rewriteFails += 1;
      failed = true;
      console.error(`REWRITE FAIL: ${rw.source} -> route "${decoded}" is NOT registered in api/${area}.js`);
    }
  }
  console.log(`check-api: ${rewrites.length} rewrite(s) validated against area route maps: ${rewriteFails ? `${rewriteFails} FAILED` : 'all OK'}`);
}

// ---- Phase 4: readable source ---------------------------------------------
const sourceFiles = [...walk(path.join(root, 'api')), ...walk(path.join(root, 'src'))].filter(file => /\.(js|mjs|ts|tsx)$/.test(file));
for (const file of sourceFiles) {
  const longLine = readFileSync(file, 'utf8').split(/\r?\n/).findIndex(line => line.length > 400);
  if (longLine >= 0) {
    failed = true;
    console.error(`FORMAT FAIL: ${path.relative(root, file)}:${longLine + 1} exceeds 400 characters`);
  }
}

if (failed) {
  console.error('check-api: FAILED — fix the errors above before deploying.');
  process.exit(1);
}
console.log('check-api: OK');
