// Admin GET/PATCH /api/admin/hero and /api/admin/announcement. Validates with
// the shared hero.js rules, writes updatedAt + auditLogs in one transaction
// and invalidates the public route's in-memory cache so a Save is visible
// immediately.
import { FieldValue } from 'firebase-admin/firestore';
import { adminDb, requireAdmin } from '../firebase-admin.js';
import { clientError, methodNotAllowed } from '../http.js';
import { validateAnnouncementSettings, validateHeroSettings } from '../hero.js';
import { invalidateStorefrontCache } from './storefront-settings.js';

async function audit(tx, admin, action, targetId, previous, next) {
  tx.set(adminDb.collection('auditLogs').doc(), {
    adminId: admin.uid,
    adminName: admin.displayName || admin.name || admin.email || '',
    action,
    targetType: 'settings',
    targetId,
    previous,
    next,
    createdAt: FieldValue.serverTimestamp(),
  });
}

export async function adminHero(req, res) {
  const admin = await requireAdmin(req);
  if (req.method !== 'GET' && req.method !== 'PATCH') return methodNotAllowed(res, ['GET', 'PATCH']);
  const ref = adminDb.collection('settings').doc('hero');
  const snapshot = await ref.get();
  const raw = snapshot.exists ? snapshot.data() || {} : {};
  if (req.method === 'GET') {
    return res.status(200).json(validateCandidate(raw, validateHeroSettings));
  }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const next = patchOrThrow(body, validateHeroSettings, 'hero');
  const previous = { ...raw };
  delete previous.updatedAt;
  await adminDb.runTransaction(async tx => {
    tx.set(ref, { ...next, updatedAt: FieldValue.serverTimestamp() }, { merge: false });
    await audit(tx, admin, 'HERO_UPDATED', 'hero', previous, next);
  });
  invalidateStorefrontCache('hero');
  return res.status(200).json(next);
}

export async function adminAnnouncement(req, res) {
  const admin = await requireAdmin(req);
  if (req.method !== 'GET' && req.method !== 'PATCH') return methodNotAllowed(res, ['GET', 'PATCH']);
  const ref = adminDb.collection('settings').doc('announcement');
  const snapshot = await ref.get();
  const raw = snapshot.exists ? snapshot.data() || {} : {};
  if (req.method === 'GET') {
    const current = validateCandidate(raw, validateAnnouncementSettings);
    return res.status(200).json({ ...current, enabled: raw.enabled === true });
  }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const next = patchOrThrow(body, validateAnnouncementSettings, 'announcement');
  const previous = { ...raw };
  delete previous.updatedAt;
  await adminDb.runTransaction(async tx => {
    tx.set(ref, { ...next, updatedAt: FieldValue.serverTimestamp() }, { merge: false });
    await audit(tx, admin, 'ANNOUNCEMENT_UPDATED', 'announcement', previous, next);
  });
  invalidateStorefrontCache('announcement');
  return res.status(200).json(next);
}

// Validate a stored document for the admin editor; on an invalid or missing
// document fall back to a safe default shape so the editor still opens (the
// public route hides unusable content anyway).
function validateCandidate(raw, validator) {
  try {
    return validator(raw);
  } catch {
    if (validator === validateHeroSettings) {
      return { enabled: raw?.enabled === true, slides: [] };
    }
    return { enabled: false, message: '', linkUrl: '', linkLabel: '' };
  }
}

function patchOrThrow(body, validator, kind) {
  try {
    return validator(body);
  } catch (error) {
    throw clientError(error instanceof Error ? error.message : `The ${kind} settings are invalid.`);
  }
}
