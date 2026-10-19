import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { BadgeCheck, Store } from 'lucide-react';
import { Badge, Button, Card, EmptyState, Skeleton } from '../components/ui';
import { apiFetch } from '../lib/api';
import { usePageMeta } from '../hooks/usePageMeta';

type Shop = {
  id: string;
  displayName: string;
  businessName: string;
  description: string;
  categories: string[];
  verifiedBadgeActive: boolean;
  planCode: string;
  subscriptionExpiresAt: string;
};

type ShopProduct = {
  id: string;
  name: string;
  description: string;
  categoryId: string;
  sku: string;
  price: number;
  salePrice: number | null;
  images: { url: string; publicId: string; resourceType: 'image' }[];
  inventory: { size: string; quantity: number }[];
  stockQuantity: number;
  createdAt: string | null;
};

const money = (value: number) => new Intl.NumberFormat('en-KE', { style: 'currency', currency: 'KES', maximumFractionDigits: 0 }).format(value);

export default function PublicSellerShop() {
  const { sellerId = '' } = useParams();
  const [shop, setShop] = useState<Shop | null>(null);
  const [products, setProducts] = useState<ShopProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  usePageMeta(shop ? `${shop.displayName} | HerStep Marketplace` : 'Seller Shop | HerStep Marketplace',
    shop?.description || 'Browse products from an independent seller on the HerStep marketplace.');

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    apiFetch(`/api/sellers/shop?sellerId=${encodeURIComponent(sellerId)}`)
      .then((result: any) => {
        if (!active) return;
        setShop(result.shop || null);
        setProducts(Array.isArray(result.products) ? result.products : []);
      })
      .catch((err: any) => {
        if (!active) return;
        setError(err?.message || 'This seller shop is not currently available.');
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [sellerId]);

  if (loading) return <div className="max-w-7xl mx-auto px-4 sm:px-6 py-10"><Skeleton className="h-36 rounded-2xl mb-6" /><div className="grid grid-cols-2 lg:grid-cols-4 gap-4">{Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="aspect-square rounded-xl" />)}</div></div>;

  if (error || !shop) return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-16">
      <EmptyState title="Seller shop unavailable" description={error || 'This shop may be inactive or its subscription may have expired.'} action={<Link to="/shop"><Button>Browse all products</Button></Link>} />
    </div>
  );

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 animate-fadeIn">
      <nav className="text-sm text-neutral-500 mb-5"><Link to="/shop" className="hover:text-neutral-900">Shop</Link> / Seller shop</nav>
      <Card className="p-5 sm:p-8 mb-8">
        <div className="flex flex-col sm:flex-row sm:items-start gap-4">
          <div className="rounded-2xl bg-neutral-100 p-4 self-start"><Store className="w-8 h-8 text-neutral-700" /></div>
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl sm:text-3xl font-bold text-neutral-900">{shop.displayName}</h1>
              {shop.verifiedBadgeActive && <Badge variant="success"><BadgeCheck className="inline w-3.5 h-3.5 mr-1" /> Verified seller</Badge>}
            </div>
            {shop.businessName && <p className="text-neutral-600 mt-1">{shop.businessName}</p>}
            {shop.description && <p className="text-neutral-600 mt-3 max-w-3xl whitespace-pre-line">{shop.description}</p>}
            {shop.categories.length > 0 && <div className="flex flex-wrap gap-2 mt-4">{shop.categories.map(category => <span key={category} className="rounded-full bg-neutral-100 px-3 py-1 text-xs text-neutral-700">{category}</span>)}</div>}
            <p className="text-sm text-neutral-500 mt-4">{products.length} product{products.length === 1 ? '' : 's'} available</p>
          </div>
        </div>
      </Card>

      <div className="flex items-end justify-between gap-3 mb-5">
        <div><h2 className="text-xl font-bold text-neutral-900">Shop products</h2><p className="text-sm text-neutral-500 mt-1">Products from this independent marketplace seller.</p></div>
        <Link to="/shop" className="text-sm underline text-neutral-700">All products</Link>
      </div>

      {products.length === 0 ? <EmptyState title="No products available yet" description="This seller has not published any products." action={<Link to="/shop"><Button>Browse HerStep Collection</Button></Link>} /> : (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
          {products.map(product => {
            const price = product.salePrice && product.salePrice > 0 && product.salePrice < product.price ? product.salePrice : product.price;
            return <Link key={product.id} to={`/product/${encodeURIComponent(product.id)}`} className="group block overflow-hidden rounded-xl border border-neutral-200 bg-white hover:shadow-md transition-shadow">
              <div className="aspect-square bg-neutral-100 overflow-hidden">
                {product.images[0]?.url ? <img src={product.images[0].url} alt={product.name} loading="lazy" className="w-full h-full object-cover group-hover:scale-[1.02] transition-transform" /> : <div className="w-full h-full flex items-center justify-center text-sm text-neutral-400">No image</div>}
              </div>
              <div className="p-3 sm:p-4">
                <h3 className="font-medium text-sm sm:text-base text-neutral-900 line-clamp-2">{product.name}</h3>
                <p className="font-bold text-neutral-900 mt-2">{money(price)}</p>
                {product.salePrice && product.salePrice > 0 && product.salePrice < product.price && <p className="text-xs text-neutral-400 line-through">{money(product.price)}</p>}
                <p className={`text-xs mt-2 ${product.stockQuantity > 0 ? 'text-emerald-700' : 'text-neutral-500'}`}>{product.stockQuantity > 0 ? 'In stock' : 'Out of stock'}</p>
              </div>
            </Link>;
          })}
        </div>
      )}
    </div>
  );
}
