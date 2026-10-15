import React, { useEffect, useState } from 'react';
import { Heart } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { apiFetch } from '../lib/api';

export function WishlistButton({ productId }: { productId: string }) {
  const navigate = useNavigate();
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let active = true;
    apiFetch('/api/wishlist').then((result: any) => {
      if (active) setSaved(Array.isArray(result.items) && result.items.some((item: any) => item.productId === productId));
    }).catch(() => undefined);
    return () => { active = false; };
  }, [productId]);

  const toggle = async () => {
    setBusy(true);
    setNotice('');
    try {
      if (saved) {
        await apiFetch('/api/wishlist', { method: 'DELETE', body: JSON.stringify({ productId }) });
        setSaved(false);
        setNotice('Removed from wishlist');
      } else {
        await apiFetch('/api/wishlist', { method: 'POST', body: JSON.stringify({ productId }) });
        setSaved(true);
        setNotice('Saved to wishlist');
      }
    } catch (error: any) {
      const message = String(error?.message || '');
      if (/authentication|required|sign in|login/i.test(message)) {
        navigate('/login', { state: { from: window.location.pathname } });
      } else {
        setNotice(message || 'Wishlist could not be updated. Please try again.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <button type="button" onClick={() => void toggle()} disabled={busy} aria-pressed={saved}
        aria-label={saved ? 'Remove from wishlist' : 'Save to wishlist'}
        title={saved ? 'Remove from wishlist' : 'Save to wishlist'}
        className="inline-flex shrink-0 items-center justify-center rounded-full border border-neutral-200 p-3 text-neutral-700 transition hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50">
        <Heart className={`h-5 w-5 ${saved ? 'fill-rose-500 text-rose-500' : ''}`} />
      </button>
      {notice && <span role="status" className="max-w-40 text-right text-xs text-neutral-500">{notice}</span>}
    </div>
  );
}
