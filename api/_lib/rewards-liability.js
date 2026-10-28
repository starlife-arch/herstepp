/**
 * Reward liability is derived from the ledger, not the cached config total.
 * Positive award entries stop counting after expiry; negative redemption and
 * refund-reversal entries remain effective because they represent consumed
 * liability. Accepts Firestore Timestamp, Date, ISO string, or millisecond time.
 */
function millis(value) {
  if (value == null) return null;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  if (value instanceof Date) return value.getTime();
  const n = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(n) ? n : null;
}

export function calculateOutstandingLiability(entries, pointValueKes, now = Date.now()) {
  const pointValue = Math.max(0.001, Number(pointValueKes) || 0.1);
  const activePoints = (Array.isArray(entries) ? entries : []).reduce((sum, entry) => {
    if (!entry || String(entry.status || 'POSTED').toUpperCase() !== 'POSTED') return sum;
    const points = Number(entry.points);
    if (!Number.isFinite(points) || points === 0) return sum;
    const expiresAt = millis(entry.expiresAt);
    // Expiry only removes positive earned points. A negative ledger movement
    // must not be silently undone by an expiry timestamp.
    if (points > 0 && expiresAt != null && expiresAt <= now) return sum;
    return sum + points;
  }, 0);
  return Math.max(0, activePoints) * pointValue;
}

export function pointsAllowedUnderLiabilityCap(requested, maxLiabilityKes, outstandingKes, pointValueKes) {
  const pointValue = Math.max(0.001, Number(pointValueKes) || 0.1);
  const cap = Math.max(0, Number(maxLiabilityKes) || 0);
  const outstanding = Math.max(0, Number(outstandingKes) || 0);
  const room = Math.max(0, cap - outstanding);
  return Math.max(0, Math.min(Math.floor(Number(requested) || 0), Math.floor((room + 1e-9) / pointValue)));
}
