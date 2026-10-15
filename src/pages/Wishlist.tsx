import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Heart, Trash2 } from 'lucide-react';
import { useApp, effectivePrice } from '../context/AppContext';
import { apiFetch } from '../lib/api';
import { productPath } from '../lib/product-slug';
import { productImageUrl } from '../lib/productImage';
import { Button, Card, formatCurrency } from '../components/ui';
import { usePageMeta } from '../hooks/usePageMeta';

type SavedItem = { productId: string; createdAt?: string | null };

export default function Wishlist() {
  usePageMeta('My Wishlist | HerStep Collection');
  const { state } = useApp();
  const [items, setItems] = useState<SavedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [removing, setRemoving] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result: any = await apiFetch('/api/wishlist');
      setItems(Array.isArray(result.items) ? result.items : []);
    } catch (err: any) {
      setError(err?.message || 'Your wishlist could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const remove = async (productId: string) => {
    setRemoving(productId);
    setError('');
    try {
      await apiFetch('/api/wishlist', { method: 'DELETE', body: JSON.stringify({ productId }) });
      setItems(current => current.filter(item => item.productId !== productId));
    } catch (err: any) {
      setError(err?.message || 'This item could not be removed.');
    } finally {
      setRemoving('');
    }
  };

  const products = items.map(item => ({
    item,
    product: state.products.find(product => product.id === item.productId),
  })).filter(entry => Boolean(entry.product));

  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <div className="mb-6 flex items-center gap-3">
        <Heart className="h-7 w-7 text-rose-500" />
        <div>
          <h1 className="text-2xl font-bold text-neutral-900">My Wishlist</h1>
          <p className="text-sm text-neutral-500">Shoes you have saved for later.</p>
        </div>
      </div>

      {error && <p role="alert" className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {loading ? (
        <Card className="p-8 text-center text-sm text-neutral-500">Loading your wishlist…</Card>
      ) : items.length === 0 ? (
        <Card className="p-8 text-center">
          <Heart className="mx-auto mb-3 h-9 w-9 text-neutral-300" />
          <h2 className="font-semibold text-neutral-900">Your wishlist is empty</h2>
          <p className="mt-1 mb-4 text-sm text-neutral-500">Browse the collection and tap the heart on a shoe to save it here.</p>
          <Link to="/shop"><Button>Explore shoes</Button></Link>
        </Card>
      ) : products.length === 0 ? (
        <Card className="p-6 text-center">
          <p className="text-sm text-neutral-600">Your saved shoes are loading into the catalogue. Try refreshing if they do not appear.</p>
          <Button className="mt-4" onClick={() => void load()}>Refresh wishlist</Button>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {products.map(({ item, product }) => product && (
            <Card key={item.productId} className="overflow-hidden">
              <Link to={productPath(product)} className="block">
                <img src={productImageUrl(product)} alt={product.name} loading="lazy" className="aspect-square w-full bg-neutral-100 object-cover" />
              </Link>
              <div className="space-y-3 p-4">
                <Link to={productPath(product)} className="font-semibold text-neutral-900 hover:underline">{product.name}</Link>
                <p className="font-bold text-neutral-900">{formatCurrency(effectivePrice(product))}</p>
                <div className="flex gap-2">
                  <Link to={productPath(product)} className="flex-1"><Button block>View shoe</Button></Link>
                  <Button variant="outline" disabled={removing === item.productId} onClick={() => void remove(item.productId)} aria-label={`Remove ${product.name} from wishlist`}>
                    <Trash2 className="h-4 w-4" /> {removing === item.productId ? 'Removing…' : 'Remove'}
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </main>
  );
}
