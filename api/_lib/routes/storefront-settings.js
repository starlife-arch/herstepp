// Public GET /api/hero and GET /api/announcement. Served from settings/* with
// the shared public edge cache; admin writes invalidate the in-memory snapshot
// so a Save is visible immediately even while s-maxage is still fresh.
import { adminDb } from '../firebase-admin.js';
import { methodNotAllowed } from '../http.js';
import { setPublicCache } from '../route-dispatch.js';
import { normalizeAnnouncement, normalizeHero } from '../hero.js';

const TTL_MS = 60 * 1000;
const cache = { hero: null, announcement: null };

export function invalidateStorefrontCache(kind) {
  if (kind === 'hero' || !kind) cache.hero = null;
  if (kind === 'announcement' || !kind) cache.announcement = null;
}

async function readSetting(id) {
  const now = Date.now();
  const entry = cache[id];
  if (entry && entry.expires > now) return entry.value;
  const snapshot = await adminDb.collection('settings').doc(id).get();
  const value = snapshot.exists ? snapshot.data() || {} : {};
  cache[id] = { value, expires: now + TTL_MS };
  return value;
}

export async function publicHero(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
  const hero = normalizeHero(await readSetting('hero'));
  setPublicCache(res);
  const visible = hero.enabled && hero.slides.length > 0 ? hero : null;
  return res.status(200).json({ hero: visible });
}

export async function publicAnnouncement(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
  const announcement = normalizeAnnouncement(await readSetting('announcement'));
  setPublicCache(res);
  const visible = announcement.enabled ? announcement : null;
  return res.status(200).json({ announcement: visible });
}
