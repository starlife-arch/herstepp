// Browser-only mirror of api/_lib/delivery.js. It is an estimate for display;
// POST /api/orders/create always recalculates the authoritative total.
export type DeliveryRates = {
  outsideJuja: number;
  kiambu: number;
  defaultCounty: number;
  counties: Record<string, number>;
};

export type DeliverySettings = { deliveryEnabled: boolean; deliveryRates: DeliveryRates };

const fee = (value: unknown, fallback: number) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
};

export function normalizeDelivery(raw: unknown): DeliverySettings {
  const source = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const rawRates = source.deliveryRates && typeof source.deliveryRates === 'object' ? source.deliveryRates as Record<string, unknown> : {};
  const counties: Record<string, number> = {};
  const rawCounties = rawRates.counties && typeof rawRates.counties === 'object' ? rawRates.counties as Record<string, unknown> : {};
  Object.entries(rawCounties).forEach(([name, value]) => {
    const trimmed = name.trim();
    const amount = fee(value, -1);
    if (trimmed && trimmed.length <= 80 && amount >= 0) counties[trimmed] = amount;
  });
  return { deliveryEnabled: source.deliveryEnabled === true, deliveryRates: {
    outsideJuja: fee(rawRates.outsideJuja, 100), kiambu: fee(rawRates.kiambu, 200),
    defaultCounty: fee(rawRates.defaultCounty, 500), counties,
  } };
}

export function deliveryFee(settings: unknown, location: string): number {
  const rates = normalizeDelivery(settings).deliveryRates;
  const text = location.toLowerCase();
  if (text.includes('juja')) return 0;
  if (text.includes('kiambu')) return rates.kiambu;
  const match = Object.entries(rates.counties).find(([name]) => text.includes(name.toLowerCase()));
  return match ? match[1] : rates.defaultCounty;
}
