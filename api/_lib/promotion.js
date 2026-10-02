import { clientError } from './http.js';
export const PROMO_RE=/^[A-Z0-9][A-Z0-9_-]{2,39}$/;
export function normalisePromoCode(value){const code=typeof value==='string'?value.trim().toUpperCase():'';if(!PROMO_RE.test(code))throw clientError('Provide a valid promo code.');return code;}
const ms=v=>v?.toMillis?v.toMillis():new Date(v).getTime();
export function calculatePromoDiscount(promo,lines,subtotal,now=new Date()){
 if(!promo.active)throw clientError('This promo code is inactive.',409); const time=now instanceof Date?now.getTime():new Date(now).getTime();
 if(Number.isFinite(ms(promo.startsAt))&&time<ms(promo.startsAt))throw clientError('This promo code is not active yet.',409);
 if(Number.isFinite(ms(promo.endsAt))&&time>ms(promo.endsAt))throw clientError('This promo code has expired.',409);
 if(subtotal<Number(promo.minimumOrderValue||0))throw clientError('This promo code requires a higher order value.',409);
 const p=Array.isArray(promo.productIds)?promo.productIds:[],c=Array.isArray(promo.categoryIds)?promo.categoryIds:[];
 const eligible=lines.filter(l=>(!p.length&&!c.length)||p.includes(l.productId)||c.includes(l.categoryId));const eligibleSubtotal=eligible.reduce((n,l)=>n+(Number(l.lineTotal)||0),0);
 if(!eligibleSubtotal)throw clientError('This promo code does not apply to the selected products.',409);
 const discount=promo.discountType==='PERCENTAGE'?Math.floor(eligibleSubtotal*Number(promo.discountValue)/100):Math.min(Number(promo.discountValue),eligibleSubtotal);
 return {discount,eligibleSubtotal,eligible};
}
