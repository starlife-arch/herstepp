import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from './api';

const PROMO_STORAGE_KEY = 'herstep-checkout-promo-code';

function readSavedCode(): string {
  try { return sessionStorage.getItem(PROMO_STORAGE_KEY) || ''; } catch { return ''; }
}

export function usePromo(cart: { product: { id: string }; size: string; quantity: number }[]) {
  const [promoCode, setPromoCodeState] = useState(readSavedCode);
  const [promo, setPromo] = useState<any>(null);
  const [promoError, setPromoError] = useState('');
  const restoreOnMount = useRef(Boolean(readSavedCode()));
  const cartKey = cart.map(item => `${item.product.id}:${item.size}:${item.quantity}`).join('|');

  const setPromoCode = (value: string) => setPromoCodeState(value);

  const validate = useCallback(async (rawCode: string) => {
    const code = rawCode.trim().toUpperCase();
    if (!code) { setPromo(null); setPromoError('Enter a promo code.'); return; }
    try {
      const result: any = await apiFetch('/api/promo/validate', {
        method: 'POST',
        body: JSON.stringify({ code, cart: cart.map(item => ({ productId: item.product.id, size: String(item.size), quantity: item.quantity })) }),
      });
      setPromo(result);
      setPromoCodeState(result.code);
      setPromoError('');
      try { sessionStorage.setItem(PROMO_STORAGE_KEY, result.code); } catch { /* optional convenience only */ }
    } catch (error: any) {
      setPromo(null);
      setPromoError(error.message || 'Could not apply promo code.');
      try { sessionStorage.removeItem(PROMO_STORAGE_KEY); } catch { /* optional convenience only */ }
    }
  }, [cartKey]); // cart contents are represented by cartKey; avoid revalidation on every render

  const applyPromo = () => { void validate(promoCode); };

  useEffect(() => {
    if (!restoreOnMount.current || !promoCode || !cart.length) return;
    restoreOnMount.current = false;
    void validate(promoCode);
  }, [promoCode, cartKey, validate]);

  const removePromo = () => {
    setPromo(null); setPromoCodeState(''); setPromoError(''); restoreOnMount.current = false;
    try { sessionStorage.removeItem(PROMO_STORAGE_KEY); } catch { /* optional convenience only */ }
  };
  return { promoCode, setPromoCode, promo, promoError, applyPromo, removePromo };
}
