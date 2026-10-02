import React from 'react';
import { Link } from 'react-router-dom';
import { Minus, Plus, Trash2, ArrowLeft } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { effectivePrice, hasDiscount } from '../context/AppContext';
import { Button, Card, formatCurrency, EmptyState } from '../components/ui';
import { productImageUrl, handleImageError } from '../lib/productImage';
import { usePromo } from '../lib/usePromo';

export default function Cart() {
  const { state, dispatch } = useApp();

  const subtotal = state.cart.reduce((sum, item) => sum + effectivePrice(item.product) * item.quantity, 0);
  const { promoCode, setPromoCode, promo, promoError, applyPromo, removePromo } = usePromo(state.cart);

  // Delivery fees are never computed here: they come from the server
  // (GET /api/checkout/config and the total returned by POST /api/orders/create).

  if (state.cart.length === 0) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-16">
        <EmptyState
          title="Your cart is empty"
          description="Browse our collection and add items to your cart."
          action={<Link to="/shop"><Button>Start Shopping</Button></Link>}
        />
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 animate-fadeIn">
      <div className="flex items-center gap-3 mb-8">
        <Link to="/shop" className="p-2 rounded-lg hover:bg-neutral-100"><ArrowLeft className="w-5 h-5" /></Link>
        <h1 className="text-2xl font-bold text-neutral-900">Shopping Cart</h1>
        <span className="text-sm text-neutral-500">({state.cart.length} item{state.cart.length !== 1 ? 's' : ''})</span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Cart Items */}
        <div className="lg:col-span-2 space-y-4">
          {state.cart.map(item => {
            const price = effectivePrice(item.product);
            const inventory = Array.isArray(item.product.inventory) ? item.product.inventory : [];
            const stock = inventory.find(s => s.size === item.size)?.quantity ?? 0;
            return (
              <Card key={`${item.product.id}-${item.size}`} className="p-4">
                <div className="flex gap-4">
                  <img
                    src={productImageUrl(item.product)}
                    alt={item.product.name}
                    onError={handleImageError}
                    className="w-20 h-20 sm:w-24 sm:h-24 rounded-lg object-cover bg-neutral-100"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex justify-between gap-2">
                      <div>
                        <Link to={`/product/${item.product.id}`} className="font-medium text-neutral-900 text-sm hover:underline">
                          {item.product.name}
                        </Link>
                        <p className="text-xs text-neutral-500 mt-0.5">Size: {item.size}</p>
                      </div>
                      <button
                        onClick={() => dispatch({ type: 'REMOVE_FROM_CART', payload: { productId: item.product.id, size: item.size } })}
                        className="p-1.5 rounded-lg hover:bg-neutral-100 text-neutral-400 hover:text-red-600"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                    <div className="flex items-center justify-between mt-3">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => {
                            if (item.quantity <= 1) {
                              dispatch({ type: 'REMOVE_FROM_CART', payload: { productId: item.product.id, size: item.size } });
                            } else {
                              dispatch({ type: 'UPDATE_CART_QUANTITY', payload: { productId: item.product.id, size: item.size, quantity: item.quantity - 1 } });
                            }
                          }}
                          className="w-8 h-8 border border-neutral-300 rounded-lg flex items-center justify-center hover:bg-neutral-50"
                        >
                          <Minus className="w-3 h-3" />
                        </button>
                        <span className="w-8 text-center text-sm font-medium">{item.quantity}</span>
                        <button
                          onClick={() => dispatch({ type: 'UPDATE_CART_QUANTITY', payload: { productId: item.product.id, size: item.size, quantity: item.quantity + 1 } })}
                          disabled={item.quantity >= stock}
                          className="w-8 h-8 border border-neutral-300 rounded-lg flex items-center justify-center hover:bg-neutral-50 disabled:opacity-40"
                        >
                          <Plus className="w-3 h-3" />
                        </button>
                        <span className="text-xs text-neutral-400 ml-1">{stock} in stock</span>
                      </div>
                      <span className="font-semibold text-neutral-900">
                        {formatCurrency(price * item.quantity)}
                        {hasDiscount(item.product) && (
                          <span className="ml-2 text-xs text-neutral-400 line-through">{formatCurrency(item.product.price * item.quantity)}</span>
                        )}
                      </span>
                    </div>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>

        {/* Order Summary */}
        <div className="lg:col-span-1">
          <Card className="p-6 sticky top-24">
            <h2 className="text-lg font-semibold text-neutral-900 mb-4">Order Summary</h2>

            <div className="mt-4"><div className="flex gap-2"><input value={promoCode} onChange={event => setPromoCode(event.target.value)} placeholder="Promo code" className="min-w-0 flex-1 rounded-lg border border-neutral-300 px-3 py-2 text-sm" /><Button size="sm" variant="outline" onClick={applyPromo}>Apply</Button></div>{promo && <div className="mt-2 flex items-center justify-between rounded bg-emerald-50 px-2 py-1 text-xs text-emerald-800"><span>{promo.code} · -{formatCurrency(promo.discount)} · applies to: {promo.appliesTo.map((product: any) => product.name).join(', ')}</span><button onClick={removePromo}>Remove</button></div>}{promoError && <p className="mt-1 text-xs text-red-600">{promoError}</p>}</div>
            <div className="space-y-3 border-t border-neutral-200 pt-4">
              <div className="flex justify-between text-sm">
                <span className="text-neutral-600">Subtotal</span>
                <span className="text-neutral-900">{formatCurrency(subtotal)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-neutral-600">Delivery</span>
                <span className="text-neutral-500 italic">Calculated at checkout</span>
              </div>
              <div className="flex justify-between font-semibold text-neutral-900 border-t border-neutral-200 pt-3">
                <span>Estimated Total</span>
                <span>{formatCurrency(subtotal - (promo?.discount || 0))}</span>
              </div>
            </div>

            <p className="text-xs text-neutral-500 mt-3">
              Collection at the store is free. If delivery is available in your area, the fee is added at checkout.
            </p>

            <Link to="/checkout" className="block mt-6">
              <Button size="lg" className="w-full">Proceed to Checkout</Button>
            </Link>
            <Link to="/shop" className="block text-center text-sm text-neutral-500 hover:text-neutral-900 mt-3">
              Continue Shopping
            </Link>
          </Card>
        </div>
      </div>
    </div>
  );
}
