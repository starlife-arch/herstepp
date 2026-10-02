import { useState } from 'react';
import { apiFetch } from './api';

export function usePromo(cart: { product: { id: string }; size: string; quantity: number }[]) {
  const [promoCode, setPromoCode] = useState('');
  const [promo, setPromo] = useState<any>(null);
  const [promoError, setPromoError] = useState('');
  const applyPromo = async () => {
    try {
      const result: any = await apiFetch('/api/promo/validate', {
        method: 'POST',
        body: JSON.stringify({ code: promoCode, cart: cart.map(item => ({ productId: item.product.id, size: String(item.size), quantity: item.quantity })) }),
      });
      setPromo(result);
      setPromoCode(result.code);
      setPromoError('');
    } catch (error: any) {
      setPromo(null);
      setPromoError(error.message || 'Could not apply promo code.');
    }
  };
  const removePromo = () => { setPromo(null); setPromoCode(''); setPromoError(''); };
  return { promoCode, setPromoCode, promo, promoError, applyPromo, removePromo };
}
