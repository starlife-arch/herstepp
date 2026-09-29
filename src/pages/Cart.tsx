import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Minus, Plus, Trash2, ShoppingBag, ArrowLeft, Tag } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { Button, Card, formatCurrency, Input, EmptyState } from '../components/ui';
import { samplePromotions } from '../data/mockData';

export default function Cart() {
  const { state, dispatch } = useApp();
  const navigate = useNavigate();
  const [promoCode, setPromoCode] = useState('');
  const [appliedPromo, setAppliedPromo] = useState<any>(null);
  const [promoError, setPromoError] = useState('');

  const subtotal = state.cart.reduce((sum, item) => {
    const price = item.product.salePrice || item.product.price;
    return sum + price * item.quantity;
  }, 0);

  const discount = appliedPromo
    ? appliedPromo.type === 'percentage'
      ? Math.round(subtotal * appliedPromo.discountValue / 100)
      : appliedPromo.discountValue
    : 0;

  const deliveryFee = subtotal > 0 ? 150 : 0;
  const total = subtotal - discount + deliveryFee;

  const handleApplyPromo = () => {
    const promo = samplePromotions.find(p => p.promoCode === promoCode.toUpperCase() && p.active);
    if (!promo) {
      setPromoError('Invalid promo code');
      setAppliedPromo(null);
      return;
    }
    if (promo.minOrder && subtotal < promo.minOrder) {
      setPromoError(`Minimum order of ${formatCurrency(promo.minOrder)} required`);
      return;
    }
    setAppliedPromo(promo);
    setPromoError('');
  };

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
            const price = item.product.salePrice || item.product.price;
            return (
              <Card key={`${item.product.id}-${item.size}`} className="p-4">
                <div className="flex gap-4">
                  <img
                    src={item.product.images[0]}
                    alt={item.product.name}
                    className="w-20 h-20 sm:w-24 sm:h-24 rounded-lg object-cover bg-neutral-100"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex justify-between gap-2">
                      <div>
                        <Link to={`/product/${item.product.slug}`} className="font-medium text-neutral-900 text-sm hover:underline">
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
                          className="w-8 h-8 border border-neutral-300 rounded-lg flex items-center justify-center hover:bg-neutral-50"
                        >
                          <Plus className="w-3 h-3" />
                        </button>
                      </div>
                      <span className="font-semibold text-neutral-900">{formatCurrency(price * item.quantity)}</span>
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

            {/* Promo Code */}
            <div className="mb-4">
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Tag className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-400" />
                  <input
                    type="text"
                    placeholder="Promo code"
                    value={promoCode}
                    onChange={e => setPromoCode(e.target.value)}
                    className="w-full pl-9 pr-3 py-2 border border-neutral-300 rounded-lg text-sm"
                  />
                </div>
                <Button variant="outline" size="sm" onClick={handleApplyPromo}>Apply</Button>
              </div>
              {promoError && <p className="text-xs text-red-600 mt-1">{promoError}</p>}
              {appliedPromo && <p className="text-xs text-emerald-600 mt-1">Code applied: -{formatCurrency(discount)}</p>}
            </div>

            <div className="space-y-3 border-t border-neutral-200 pt-4">
              <div className="flex justify-between text-sm">
                <span className="text-neutral-600">Subtotal</span>
                <span className="text-neutral-900">{formatCurrency(subtotal)}</span>
              </div>
              {discount > 0 && (
                <div className="flex justify-between text-sm">
                  <span className="text-neutral-600">Discount</span>
                  <span className="text-emerald-600">-{formatCurrency(discount)}</span>
                </div>
              )}
              <div className="flex justify-between text-sm">
                <span className="text-neutral-600">Delivery</span>
                <span className="text-neutral-900">{formatCurrency(deliveryFee)}</span>
              </div>
              <div className="flex justify-between font-semibold text-neutral-900 border-t border-neutral-200 pt-3">
                <span>Total</span>
                <span>{formatCurrency(total)}</span>
              </div>
            </div>

            <Button size="lg" className="w-full mt-6" onClick={() => navigate('/checkout')}>
              Proceed to Checkout
            </Button>
            <Link to="/shop" className="block text-center text-sm text-neutral-500 hover:text-neutral-900 mt-3">
              Continue Shopping
            </Link>
          </Card>
        </div>
      </div>
    </div>
  );
}
