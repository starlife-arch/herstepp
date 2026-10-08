import React, { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ShoppingBag, ChevronRight, Minus, Plus, Check, Truck } from 'lucide-react';
import { useApp, effectivePrice, hasDiscount } from '../context/AppContext';
import { Button, Card, Badge, Skeleton, EmptyState, formatCurrency } from '../components/ui';
import { usePageMeta } from '../hooks/usePageMeta';


export default function ProductDetail() {
  const { id } = useParams();
  const { state, dispatch, reloadCatalog } = useApp();
  const { products, catalogLoading, catalogError } = state;
  const product = products.find(p => p.id === id);
  // Hook is called unconditionally, BEFORE any early return below; it uses the
  // real `product` variable (null-safe), never an undefined helper name.
  usePageMeta(
    product ? `${product.name} | HerStep Collection` : 'Product | HerStep Collection',
    product?.description
      ? `${String(product.description).slice(0, 155)} - ladies' footwear in Juja Town. Pay with M-Pesa.`
      : `${product?.name ?? 'HerStep'} - ladies' footwear in Juja Town. Pay with M-Pesa.`
  );
  // Only sizes with quantity > 0 are selectable.
  const [selectedSize, setSelectedSize] = useState<string | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [selectedImage, setSelectedImage] = useState(0);

  if (catalogError) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-16">
        <EmptyState
          title="We couldn't load this product"
          description={catalogError}
          action={<Button onClick={() => void reloadCatalog()}>Try again</Button>}
        />
      </div>
    );
  }

  if (catalogLoading) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 grid grid-cols-1 lg:grid-cols-2 gap-8 animate-fadeIn">
        <Skeleton className="aspect-square rounded-2xl" />
        <div className="space-y-4">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-8 w-3/4" />
          <Skeleton className="h-6 w-1/4" />
          <Skeleton className="h-24 w-full" />
        </div>
      </div>
    );
  }

  if (!product) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-16 text-center">
        <h2 className="text-2xl font-bold text-neutral-900 mb-2">Product Not Found</h2>
        <p className="text-neutral-500 mb-6">The product you're looking for doesn't exist or has been removed.</p>
        <Link to="/shop"><Button>Back to Shop</Button></Link>
      </div>
    );
  }

  const totalStock = product.stockQuantity;
  const isSoldOut = totalStock === 0;
  const selectedSizeData = selectedSize ? product.inventory.find(s => s.size === selectedSize) : undefined;
  const maxQuantity = selectedSizeData?.quantity ?? 0;
  const canAddToCart = Boolean(selectedSize && selectedSizeData && selectedSizeData.quantity >= quantity && quantity >= 1);

  const handleSelectSize = (size: string) => {
    setSelectedSize(size);
    const stock = product.inventory.find(s => s.size === size)?.quantity ?? 1;
    setQuantity(Math.min(quantity, Math.max(stock, 1)));
  };

  const handleAddToCart = () => {
    if (!canAddToCart || !selectedSize) return;
    dispatch({
      type: 'ADD_TO_CART',
      payload: { product, size: selectedSize, quantity },
    });
    dispatch({ type: 'SET_TOAST', payload: { message: 'Added to cart', type: 'success' } });
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 animate-fadeIn">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-2 text-sm text-neutral-500 mb-6">
        <Link to="/" className="hover:text-neutral-900">Home</Link>
        <ChevronRight className="w-3 h-3" />
        <Link to="/shop" className="hover:text-neutral-900">Shop</Link>
        <ChevronRight className="w-3 h-3" />
        <span className="text-neutral-900 font-medium">{product.name}</span>
      </nav>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 lg:gap-12">
        {/* Gallery */}
        <div>
          <div className="aspect-square bg-neutral-100 rounded-2xl overflow-hidden mb-4">
            <img
              src={product.images[selectedImage]?.url}
              alt={product.name}
              width={600}
              height={600}
              className="w-full h-full object-cover"
            />
          </div>
          {product.images.length > 1 && (
            <div className="grid grid-cols-4 gap-3">
              {product.images.map((img, i) => (
                <button
                  key={img.publicId || i}
                  onClick={() => setSelectedImage(i)}
                  className={`aspect-square rounded-lg overflow-hidden border-2 transition-colors ${selectedImage === i ? 'border-neutral-900' : 'border-transparent hover:border-neutral-300'}`}
                >
                  <img src={img.url} alt={`${product.name} — photo ${i + 1}`} loading="lazy" className="w-full h-full object-cover" />
                </button>
              ))}
            </div>
          )}
          {product.video && (
            <video src={product.video.url} controls className="mt-4 w-full rounded-2xl bg-neutral-100" />
          )}
        </div>

        {/* Product Info */}
        <div>
          <div className="mb-4">
            <p className="text-sm text-neutral-500 mb-1">{state.categories.find(c => c.id === product.categoryId)?.name}</p>
            <h1 className="text-2xl sm:text-3xl font-bold text-neutral-900 mb-2">{product.name}</h1>
            <p className="text-sm text-neutral-400">SKU: {product.sku}</p>
          </div>

          {/* Price */}
          <div className="flex items-baseline gap-3 mb-6">
            {hasDiscount(product) ? (
              <>
                <span className="text-3xl font-bold text-neutral-900">{formatCurrency(effectivePrice(product))}</span>
                <span className="text-lg text-neutral-400 line-through">{formatCurrency(product.price)}</span>
                <Badge variant="danger">Sale</Badge>
              </>
            ) : (
              <span className="text-3xl font-bold text-neutral-900">{formatCurrency(effectivePrice(product))}</span>
            )}
          </div>

          {/* Description */}
          <p className="text-neutral-600 leading-relaxed mb-8">{product.description}</p>

          {/* Size Selection */}
          <div className="mb-6">
            <div className="flex items-center justify-between mb-3">
              <label className="text-sm font-medium text-neutral-900">Select Size</label>
              {isSoldOut && <Badge variant="danger">Sold Out</Badge>}
            </div>
            <div className="grid grid-cols-6 gap-2">
              {product.inventory.map(s => {
                const unavailable = s.quantity === 0;
                return (
                  <button
                    key={s.size}
                    onClick={() => !unavailable && handleSelectSize(s.size)}
                    disabled={unavailable}
                    className={`py-3 rounded-lg text-sm font-medium border transition-all ${
                      selectedSize === s.size
                        ? 'border-neutral-900 bg-neutral-900 text-white'
                        : unavailable
                        ? 'border-neutral-200 text-neutral-300 cursor-not-allowed line-through'
                        : 'border-neutral-300 text-neutral-700 hover:border-neutral-400'
                    }`}
                  >
                    {s.size}
                  </button>
                );
              })}
            </div>
            {selectedSize && selectedSizeData && (
              <p className="text-xs text-neutral-500 mt-2">
                {selectedSizeData.quantity > 0 ? `${selectedSizeData.quantity} in stock` : 'Out of stock'}
              </p>
            )}
          </div>

          {/* Quantity — capped by the selected size's stock */}
          {!isSoldOut && selectedSize && (
            <div className="mb-8">
              <label className="text-sm font-medium text-neutral-900 mb-3 block">Quantity</label>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setQuantity(Math.max(1, quantity - 1))}
                  className="w-10 h-10 border border-neutral-300 rounded-lg flex items-center justify-center hover:bg-neutral-50"
                >
                  <Minus className="w-4 h-4" />
                </button>
                <span className="w-12 text-center font-medium">{quantity}</span>
                <button
                  onClick={() => setQuantity(Math.min(maxQuantity || 1, quantity + 1))}
                  disabled={quantity >= maxQuantity}
                  className="w-10 h-10 border border-neutral-300 rounded-lg flex items-center justify-center hover:bg-neutral-50 disabled:opacity-40"
                >
                  <Plus className="w-4 h-4" />
                </button>
                <span className="text-xs text-neutral-500">Max {maxQuantity} for size {selectedSize}</span>
              </div>
            </div>
          )}

          {/* Add to Cart */}
          <div className="flex gap-3 mb-8">
            <Button
              size="lg"
              className="flex-1"
              disabled={!canAddToCart || isSoldOut}
              onClick={handleAddToCart}
            >
              <ShoppingBag className="w-4 h-4 mr-2" />
              {isSoldOut ? 'Sold Out' : 'Add to Cart'}
            </Button>
          </div>

          {/* Delivery Info */}
          <Card className="p-4">
            <div className="flex items-start gap-3">
              <Truck className="w-5 h-5 text-neutral-500 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-neutral-900">Delivery Information</p>
                <p className="text-xs text-neutral-500 mt-1">Delivery availability and fees are shown at checkout. Collection at our store is always free.</p>
              </div>
            </div>
          </Card>
        </div>
      </div>

      {/* Toast */}
      {state.toast && (
        <div className="fixed bottom-4 right-4 z-50 bg-neutral-900 text-white px-4 py-3 rounded-xl shadow-lg flex items-center gap-2 animate-fadeIn">
          <Check className="w-4 h-4" />
          <span className="text-sm">{state.toast.message}</span>
        </div>
      )}
    </div>
  );
}
