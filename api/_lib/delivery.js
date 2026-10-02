// ---------------------------------------------------------------------------
// api/_lib/delivery.js — THE single source of truth for delivery settings and
// rates (backend). Shared by:
//   * order-core.createOrderCore  (authoritative fee at order creation)
//   * routes/orders-create.config (GET /api/checkout/config for the frontend)
//   * routes/admin-delivery       (GET/PATCH /api/admin/delivery)
//   * scripts/test-order-core.mjs (offline tests)
// The tiny TS mirror in src/lib/delivery.ts must stay identical to this file.
//
// Rules (match the old live site):
//   settings/checkout.deliveryRates = { outsideJuja, kiambu, defaultCounty, counties{name:fee} }
//   - `outsideJuja` is KEPT UNTOUCHED (legacy field, not shown in the admin UI).
//   - Fee for DELIVERY, location text lowercased:
//       contains "juja"      -> 0 (Juja is always free)
//       contains "kiambu"    -> rates.kiambu
//       contains a county key-> that county's fee (case-insensitive)
//       otherwise            -> rates.defaultCounty
//   - COLLECTION is always free at the pickup address below.
//   - Delivery is disabled unless deliveryEnabled === true.
//   - Fees are non-negative integers; area names are trimmed and <= 80 chars.
// ---------------------------------------------------------------------------

export const COLLECTION_LOCATION = 'Juja Town, Jerry House, near Juja Posta, Outside Shop No. 12';

// Defaults only used when a stored value is missing/invalid — never written
// back to Firestore by normaliseDelivery.
export const DELIVERY_DEFAULTS = { kiambu: 200, defaultCounty: 500 };

/** Non-negative integer or null. */
function asFee(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * Normalise a raw settings/checkout document into the canonical shape:
 * { deliveryEnabled: boolean, deliveryRates: { outsideJuja, kiambu,
 *   defaultCounty, counties: { name: fee } } }
 * `outsideJuja` is passed through untouched (kept for the old live site).
 */
export function normalizeDelivery(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const rates = src.deliveryRates && typeof src.deliveryRates === 'object' ? src.deliveryRates : {};

  const counties = {};
  const rawCounties = rates.counties && typeof rates.counties === 'object' ? rates.counties : {};
  for (const [name, fee] of Object.entries(rawCounties)) {
    const trimmed = String(name || '').trim();
    if (!trimmed || trimmed.length > 80) continue;
    const validFee = asFee(fee);
    if (validFee === null) continue;
    counties[trimmed] = validFee;
  }

  const normalized = {
    deliveryEnabled: src.deliveryEnabled === true,
    deliveryRates: {
      // Legacy field: keep whatever is stored (default 100), never displayed.
      outsideJuja: asFee(rates.outsideJuja) ?? 100,
      kiambu: asFee(rates.kiambu) ?? DELIVERY_DEFAULTS.kiambu,
      defaultCounty: asFee(rates.defaultCounty) ?? DELIVERY_DEFAULTS.defaultCounty,
      counties,
    },
  };
  return normalized;
}

/**
 * Validate a PATCH payload for /api/admin/delivery. Returns the normalised
 * settings object on success; throws Error with a human message on failure.
 * Negative / non-integer fees and bad area names are REJECTED here (not just
 * dropped like in normalizeDelivery, which is for reading legacy data).
 */
export function validateDelivery(input) {
  const src = input && typeof input === 'object' ? input : {};
  const errors = [];

  const deliveryEnabled = src.deliveryEnabled === true;

  const ratesIn = src.deliveryRates && typeof src.deliveryRates === 'object' ? src.deliveryRates : {};

  const feeField = (name, label, fallback) => {
    if (ratesIn[name] === undefined) return fallback;
    const n = asFee(ratesIn[name]);
    if (n === null) {
      errors.push(`${label} must be a whole number of at least 0.`);
      return fallback;
    }
    return n;
  };

  const kiambu = feeField('kiambu', 'Kiambu fee', DELIVERY_DEFAULTS.kiambu);
  const defaultCounty = feeField('defaultCounty', 'Other areas (default) fee', DELIVERY_DEFAULTS.defaultCounty);

  const counties = {};
  const seenLower = new Map();
  const rawCounties = ratesIn.counties && typeof ratesIn.counties === 'object' ? ratesIn.counties : {};
  for (const [rawName, rawFee] of Object.entries(rawCounties)) {
    const name = String(rawName || '').trim();
    if (!name) { errors.push('Area names cannot be empty.'); continue; }
    if (name.length > 80) { errors.push(`Area name "${name.slice(0, 40)}…" is longer than 80 characters.`); continue; }
    const fee = asFee(rawFee);
    if (fee === null) { errors.push(`Fee for "${name}" must be a whole number of at least 0.`); continue; }
    const key = name.toLowerCase();
    if (key === 'juja') { errors.push('"Juja" is always free and cannot be given a custom fee.'); continue; }
    if (seenLower.has(key)) { errors.push(`Duplicate area name "${name}".`); continue; }
    seenLower.set(key, true);
    counties[name] = fee;
  }

  const outsideJuja = feeField('outsideJuja', 'outsideJuja', 100);
  if (errors.length) throw new Error(errors[0]);

  return {
    deliveryEnabled,
    deliveryRates: {
      // Keep the stored outsideJuja value if provided (never shown in UI);
      // it must still be a sane non-negative integer if present.
      outsideJuja,
      kiambu,
      defaultCounty,
      counties,
    },
  };
}

/**
 * Authoritative delivery fee for a DELIVERY order. `settings` may be a raw
 * settings/checkout doc or an already-normalised object. Collection callers
 * must pass 0 explicitly (COLLECTION is always free).
 */
export function deliveryFee(settings, location) {
  const normalized = normalizeDelivery(settings);
  const rates = normalized.deliveryRates;
  const text = typeof location === 'string' ? location.toLowerCase() : '';

  // Juja is always free for delivery.
  if (text.includes('juja')) return 0;

  // Kiambu (unless a more specific configured area matches first? Old live
  // site order: juja -> kiambu -> county key -> default. County keys other
  // than kiambu/juja are checked after kiambu per the stated rules.)
  if (text.includes('kiambu')) return rates.kiambu;

  const match = Object.entries(rates.counties).find(([name]) => name && text.includes(String(name).toLowerCase()));
  if (match) return match[1];

  return rates.defaultCounty;
}
