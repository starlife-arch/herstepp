import React, { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { productPath, slugifyProductName } from '../lib/product-slug';
import { ShoppingBag, ChevronRight, Minus, Plus, Check, Truck, X, ZoomIn, Flag, MessageCircle, BadgeCheck } from 'lucide-react';
import { WishlistButton } from '../components/WishlistButton';
import { useApp, effectivePrice, hasDiscount } from '../context/AppContext';
import { apiFetch } from '../lib/api';
import { Button, Card, Badge, Skeleton, EmptyState, formatCurrency } from '../components/ui';
import { usePageMeta } from '../hooks/usePageMeta';
import { ProductReviews } from '../components/ProductReviews';


export default function ProductDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { state, dispatch, reloadCatalog } = useApp();
  const { products, catalogLoading, catalogError } = state;
  const decodedId = id ? decodeURIComponent(id) : '';
  const product = products.find(p => p.id === decodedId) || products.find(p => slugifyProductName(p.name) === decodedId);
  // Hook is called unconditionally, BEFORE any early return below; it uses the
  // real `product` variable (null-safe), never an undefined helper name.
  useEffect(() => { if (product && decodedId !== slugifyProductName(product.name)) navigate(productPath(product), { replace: true }); }, [product, decodedId, navigate]);
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
  const [imageZoomOpen, setImageZoomOpen] = useState(false);
  const [restockBusy, setRestockBusy] = useState(false);
  const [restockMessage, setRestockMessage] = useState('');
  const [reportOpen, setReportOpen] = useState(false);
  const [reportReason, setReportReason] = useState('SUSPICIOUS_SELLER');
  const [reportDetails, setReportDetails] = useState('');
  const [reportBusy, setReportBusy] = useState(false);
  const [reportMessage, setReportMessage] = useState('');
  const [messageBusy, setMessageBusy] = useState(false);
  const [messageError, setMessageError] = useState('');

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

  const submitListingReport = async () => {
    setReportBusy(true); setReportMessage('');
    try {
      const result: any = await apiFetch('/api/marketplace/reports', {
        method: 'POST',
        body: JSON.stringify({ productId: product.id, reasonCode: reportReason, details: reportDetails }),
      });
      setReportMessage(result.message || 'Report submitted for admin review.');
      setReportOpen(false);
      setReportDetails('');
    } catch (error: any) {
      setReportMessage(error?.message || 'Could not submit report. Sign in and try again.');
    } finally { setReportBusy(false); }
  };

  const startSellerConversation = async () => {
    setMessageBusy(true); setMessageError('');
    try {
      const result: any = await apiFetch('/api/marketplace/messages', { method: 'POST', body: JSON.stringify({ action: 'start', productId: product.id }) });
      navigate('/messages?conversationId=' + encodeURIComponent(result.conversationId));
    } catch (error: any) {
      setMessageError(error?.message || 'Could not start a conversation. Please sign in and try again.');
    } finally { setMessageBusy(false); }
  };

  const subscribeRestock = async (size: string) => {
    setRestockBusy(true); setRestockMessage('');
    try {
      const result: any = await apiFetch('/api/restock-alerts', { method: 'POST', body: JSON.stringify({ productId: product.id, size }) });
      setRestockMessage(result.message || 'You are subscribed to the restock alert.');
    } catch (error: any) { setRestockMessage(error?.message || 'Could not set up the restock alert. Sign in and try again.'); }
    finally { setRestockBusy(false); }
  };

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
          <button
            type="button"
            onClick={() => setImageZoomOpen(true)}
            aria-label={`Zoom in on ${product.name} image`}
            className="relative block w-full aspect-square bg-neutral-100 rounded-2xl overflow-hidden mb-4 cursor-zoom-in group"
          >
            <img
              src={product.images[selectedImage]?.url}
              alt={product.name}
              width={600}
              height={600}
              className="w-full h-full object-contain transition-transform group-hover:scale-[1.02]"
            />
            <span className="absolute bottom-3 right-3 inline-flex items-center gap-1 rounded-full bg-black/70 text-white text-xs px-3 py-2">
              <ZoomIn className="w-4 h-4" /> Tap to zoom
            </span>
          </button>
          {imageZoomOpen && (
            <div
              role="dialog"
              aria-modal="true"
              aria-label={`Zoomed image of ${product.name}`}
              className="fixed inset-0 z-[100] bg-black/90 flex items-center justify-center p-3 sm:p-8"
              onClick={() => setImageZoomOpen(false)}
            >
              <button type="button" onClick={() => setImageZoomOpen(false)} aria-label="Close zoomed image" className="absolute top-4 right-4 z-10 rounded-full bg-white/15 hover:bg-white/25 text-white p-3">
                <X className="w-6 h-6" />
              </button>
              <img
                src={product.images[selectedImage]?.url}
                alt={product.name}
                onClick={event => event.stopPropagation()}
                className="max-h-[92vh] max-w-full object-contain rounded-lg"
              />
              {product.images.length > 1 && (
                <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex gap-2">
                  {product.images.map((image, index) => (
                    <button key={image.publicId || index} type="button" onClick={event => { event.stopPropagation(); setSelectedImage(index); }} aria-label={`View image ${index + 1}`} className={`w-12 h-12 rounded border-2 overflow-hidden ${selectedImage === index ? 'border-white' : 'border-white/40'}`}>
                      <img src={image.url} alt="" className="w-full h-full object-cover" />
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
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
            <div className="flex items-start justify-between gap-3"><div><h1 className="text-2xl sm:text-3xl font-bold text-neutral-900 mb-2">{product.name}</h1>{(product as any).promotedUntil && new Date((product as any).promotedUntil).getTime() > Date.now() && <Badge variant="success">Promoted · Ad</Badge>}</div><WishlistButton productId={product.id} /></div>
            <p className="text-sm text-neutral-400">SKU: {product.sku}</p>
            {product.sellerUid && <p className="text-sm text-neutral-600 mt-2 flex flex-wrap items-center gap-1">Sold by <Link to={`/seller/shop/${encodeURIComponent(product.sellerUid)}`} className="font-semibold underline hover:text-neutral-900">{product.sellerBusinessName || product.sellerDisplayName || "Marketplace seller"}</Link>{product.sellerVerificationBadgeActive && <span title="Verified seller" aria-label="Verified seller" className="inline-flex items-center gap-1 text-blue-600 text-xs font-semibold"><BadgeCheck className="w-4 h-4 fill-blue-50" /> Verified seller</span>}</p>}
            {product.sellerUid && <div className="mt-3">
              <button type="button" onClick={() => void startSellerConversation()} disabled={messageBusy} className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-300 px-3 py-2 text-sm font-medium text-neutral-800 hover:bg-neutral-50 disabled:opacity-50"><MessageCircle className="w-4 h-4" /> {messageBusy ? 'Opening messages…' : 'Message seller'}</button>
              {messageError && <p role="alert" className="text-sm text-red-700 mt-2">{messageError} <span className="text-neutral-500">You must be signed in to message a seller.</span></p>}
              <div className="mt-2">
              <button type="button" onClick={() => setReportOpen(open => !open)} className="inline-flex items-center gap-1.5 text-xs text-neutral-500 hover:text-red-700 underline"><Flag className="w-3.5 h-3.5" /> Report this listing</button>
              {reportMessage && <p role="status" className="text-sm text-neutral-600 mt-2">{reportMessage}</p>}
              {reportOpen && <div className="mt-3 rounded-xl border border-neutral-200 p-4 space-y-3">
                <p className="text-sm font-semibold text-neutral-900">Tell us what concerns you</p>
                <label className="block text-xs font-medium text-neutral-700" htmlFor="marketplace-report-reason">Reason</label>
                <select id="marketplace-report-reason" value={reportReason} onChange={event => setReportReason(event.target.value)} className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm">
                  <option value="COUNTERFEIT_OR_MISLEADING">Counterfeit or misleading</option>
                  <option value="SUSPICIOUS_SELLER">Suspicious seller</option>
                  <option value="PROHIBITED_ITEM">Prohibited item</option>
                  <option value="WRONG_INFORMATION">Incorrect listing information</option>
                  <option value="OTHER">Other</option>
                </select>
                <label className="block text-xs font-medium text-neutral-700" htmlFor="marketplace-report-details">Additional details {reportReason === 'OTHER' ? '(required)' : '(optional)'}</label>
                <textarea id="marketplace-report-details" value={reportDetails} onChange={event => setReportDetails(event.target.value)} maxLength={1000} rows={3} className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm" placeholder="Share details that may help us review this listing…" />
                <div className="flex gap-2"><Button onClick={() => void submitListingReport()} disabled={reportBusy || (reportReason === 'OTHER' && reportDetails.trim().length < 10)}>{reportBusy ? 'Submitting…' : 'Submit report'}</Button><Button variant="outline" onClick={() => setReportOpen(false)} disabled={reportBusy}>Cancel</Button></div>
                <p className="text-xs text-neutral-500">You must be signed in. Reports are reviewed by HerStep admins; submitting a report does not automatically remove the listing.</p>
              </div>}
              </div>
            </div>}
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
            {product.inventory.some(s => s.quantity === 0) && (
              <div className="mt-3 space-y-2">
                <p className="text-sm text-neutral-600">Want a size that's sold out?</p>
                <div className="flex flex-wrap gap-2">
                  {product.inventory.filter(s => s.quantity === 0).map(s => (
                    <button key={s.size} type="button" disabled={restockBusy} onClick={() => void subscribeRestock(s.size)} className="rounded-lg border border-neutral-300 px-3 py-2 text-xs font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50">
                      Notify me · Size {s.size}
                    </button>
                  ))}
                </div>
                {restockMessage && <p role="status" className="text-sm text-neutral-600">{restockMessage}</p>}
              </div>
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

      <ProductReviews productId={product.id} />

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
