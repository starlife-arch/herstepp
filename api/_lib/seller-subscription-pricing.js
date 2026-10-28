import { SELLER_PLANS, SELLER_BADGE_MONTHLY_FEE } from './seller-subscription-core.js';

export const SELLER_BILLING_TERMS = Object.freeze([1, 3, 6, 12]);
export const DEFAULT_SELLER_TERM_DISCOUNTS = Object.freeze({ 1: 0, 3: 5, 6: 10, 12: 20 });

export function calculateSellerSubscriptionPrice(planCode, durationMonths = 1, discountConfig = DEFAULT_SELLER_TERM_DISCOUNTS) {
  const code = String(planCode || '').toUpperCase();
  const plan = SELLER_PLANS[code];
  const months = Number(durationMonths);
  if (!plan) throw new Error('Choose a valid seller subscription plan.');
  if (!SELLER_BILLING_TERMS.includes(months)) throw new Error('Choose a valid billing term.');
  const configured = discountConfig && typeof discountConfig === 'object' ? discountConfig : DEFAULT_SELLER_TERM_DISCOUNTS;
  const raw = Number(configured[months] ?? DEFAULT_SELLER_TERM_DISCOUNTS[months]);
  const discountPercent = months === 1 ? 0 : Math.max(0, Math.min(50, Number.isFinite(raw) ? raw : DEFAULT_SELLER_TERM_DISCOUNTS[months]));
  const planSubtotal = plan.amount * months;
  const discountAmount = Math.round(planSubtotal * discountPercent / 100);
  const badgeAmount = SELLER_BADGE_MONTHLY_FEE * months;
  return { planCode: code, durationMonths: months, planAmount: plan.amount, planSubtotal, discountPercent, discountAmount, discountedPlanAmount: planSubtotal - discountAmount, badgeAmount, amount: planSubtotal - discountAmount + badgeAmount, currency: 'KES' };
}
