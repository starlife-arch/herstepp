import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { ArrowLeft, CreditCard, MapPin, Store, Loader2, Check } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { Button, Card, Input, formatCurrency } from '../components/ui';

export default function Checkout() {
  const { state, dispatch } = useApp();
  const navigate = useNavigate();
  const [step, setStep] = useState<'details' | 'review' | 'processing' | 'success'>('details');
  const [form, setForm] = useState({
    fullName: state.user?.name || '',
    phone: state.user?.phone || '',
    email: state.user?.email || '',
    deliveryMethod: 'delivery' as 'collection' | 'delivery',
    deliveryLocation: '',
    instructions: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

  const subtotal = state.cart.reduce((sum, item) => sum + (item.product.salePrice || item.product.price) * item.quantity, 0);
  const deliveryFee = form.deliveryMethod === 'collection' ? 0 : 150;
  const total = subtotal + deliveryFee;

  const validate = () => {
    const e: Record<string, string> = {};
    if (!form.fullName.trim()) e.fullName = 'Full name is required';
    if (!form.phone.trim()) e.phone = 'Phone number is required';
    if (!/^(\+254|0)[17]\d{8}$/.test(form.phone.replace(/\s/g, ''))) e.phone = 'Enter a valid Kenyan phone number';
    if (!form.email.trim()) e.email = 'Email is required';
    if (!/\S+@\S+\.\S+/.test(form.email)) e.email = 'Enter a valid email';
    if (form.deliveryMethod === 'delivery' && !form.deliveryLocation.trim()) e.deliveryLocation = 'Delivery location is required';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleContinue = () => {
    if (validate()) setStep('review');
  };

  const handlePay = () => {
    setStep('processing');
    // Simulate STK Push process
    setTimeout(() => {
      const orderId = `HS-2026-${String(Math.floor(Math.random() * 999999)).padStart(6, '0')}`;
      const order = {
        id: `order-${Date.now()}`,
        orderId,
        customerId: state.user?.id || 'guest',
        customerName: form.fullName,
        customerPhone: form.phone,
        customerEmail: form.email,
        items: state.cart.map(item => ({
          productId: item.product.id,
          productName: item.product.name,
          productImage: item.product.images[0],
          size: item.size,
          quantity: item.quantity,
          unitPrice: item.product.salePrice || item.product.price,
          total: (item.product.salePrice || item.product.price) * item.quantity,
        })),
        subtotal,
        deliveryFee,
        discount: 0,
        total,
        deliveryMethod: form.deliveryMethod,
        deliveryLocation: form.deliveryMethod === 'collection' ? 'Jerry House, near Juja Posta' : form.deliveryLocation,
        deliveryInstructions: form.instructions,
        paymentStatus: 'paid' as const,
        orderStatus: 'pending' as const,
        statusHistory: [{ previousStatus: 'pending', newStatus: 'pending', timestamp: new Date().toISOString() }],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      dispatch({ type: 'ADD_ORDER', payload: order });
      dispatch({ type: 'CLEAR_CART' });
      setStep('success');
    }, 3000);
  };

  if (state.cart.length === 0 && step !== 'success') {
    navigate('/cart');
    return null;
  }

  if (step === 'processing') {
    return (
      <div className="max-w-lg mx-auto px-4 py-20 text-center animate-fadeIn">
        <div className="w-16 h-16 bg-neutral-100 rounded-2xl flex items-center justify-center mx-auto mb-6">
          <Loader2 className="w-8 h-8 text-neutral-700 animate-spin" />
        </div>
        <h2 className="text-xl font-bold text-neutral-900 mb-2">Processing Payment</h2>
        <p className="text-neutral-500 text-sm">An M-Pesa prompt has been sent to {form.phone}. Please enter your PIN to complete the payment.</p>
      </div>
    );
  }

  if (step === 'success') {
    return (
      <div className="max-w-lg mx-auto px-4 py-20 text-center animate-fadeIn">
        <div className="w-16 h-16 bg-emerald-50 rounded-2xl flex items-center justify-center mx-auto mb-6">
          <Check className="w-8 h-8 text-emerald-600" />
        </div>
        <h2 className="text-xl font-bold text-neutral-900 mb-2">Payment Successful</h2>
        <p className="text-neutral-500 text-sm mb-6">Your order has been placed successfully. You will receive a confirmation shortly.</p>
        <div className="flex flex-col gap-3">
          <Link to="/dashboard/orders"><Button>View My Orders</Button></Link>
          <Link to="/shop"><Button variant="outline">Continue Shopping</Button></Link>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 animate-fadeIn">
      <div className="flex items-center gap-3 mb-8">
        <button onClick={() => step === 'review' ? setStep('details') : navigate('/cart')} className="p-2 rounded-lg hover:bg-neutral-100">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h1 className="text-2xl font-bold text-neutral-900">Checkout</h1>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2">
          {step === 'details' && (
            <Card className="p-6">
              <h2 className="text-lg font-semibold text-neutral-900 mb-6">Delivery Details</h2>
              <div className="space-y-4">
                <Input label="Full Name" value={form.fullName} onChange={e => setForm({ ...form, fullName: e.target.value })} error={errors.fullName} placeholder="Enter your full name" />
                <Input label="Phone Number" value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} error={errors.phone} placeholder="+254 7XX XXX XXX" />
                <Input label="Email Address" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} error={errors.email} placeholder="your@email.com" />

                <div>
                  <label className="block text-sm font-medium text-neutral-700 mb-3">Delivery Method</label>
                  <div className="grid grid-cols-2 gap-3">
                    <button
                      onClick={() => setForm({ ...form, deliveryMethod: 'delivery' })}
                      className={`p-4 rounded-xl border-2 text-left transition-all ${form.deliveryMethod === 'delivery' ? 'border-neutral-900 bg-neutral-50' : 'border-neutral-200 hover:border-neutral-300'}`}
                    >
                      <MapPin className="w-5 h-5 mb-2" />
                      <p className="font-medium text-sm">Delivery</p>
                      <p className="text-xs text-neutral-500 mt-0.5">KSh 150</p>
                    </button>
                    <button
                      onClick={() => setForm({ ...form, deliveryMethod: 'collection' })}
                      className={`p-4 rounded-xl border-2 text-left transition-all ${form.deliveryMethod === 'collection' ? 'border-neutral-900 bg-neutral-50' : 'border-neutral-200 hover:border-neutral-300'}`}
                    >
                      <Store className="w-5 h-5 mb-2" />
                      <p className="font-medium text-sm">Collection</p>
                      <p className="text-xs text-neutral-500 mt-0.5">Free - Jerry House</p>
                    </button>
                  </div>
                </div>

                {form.deliveryMethod === 'delivery' && (
                  <Input label="Delivery Location" value={form.deliveryLocation} onChange={e => setForm({ ...form, deliveryLocation: e.target.value })} error={errors.deliveryLocation} placeholder="e.g., Juja Town, near Stage" />
                )}
                <div>
                  <label className="block text-sm font-medium text-neutral-700 mb-1.5">Additional Instructions</label>
                  <textarea
                    value={form.instructions}
                    onChange={e => setForm({ ...form, instructions: e.target.value })}
                    className="w-full px-3.5 py-2.5 border border-neutral-300 rounded-lg text-sm h-20 resize-none"
                    placeholder="Any special delivery instructions..."
                  />
                </div>

                <Button size="lg" className="w-full" onClick={handleContinue}>
                  Review Order
                </Button>
              </div>
            </Card>
          )}

          {step === 'review' && (
            <Card className="p-6">
              <h2 className="text-lg font-semibold text-neutral-900 mb-6">Review Your Order</h2>
              <div className="space-y-4 mb-6">
                {state.cart.map(item => (
                  <div key={`${item.product.id}-${item.size}`} className="flex gap-3 py-3 border-b border-neutral-100 last:border-0">
                    <img src={item.product.images[0]} alt="" className="w-14 h-14 rounded-lg object-cover bg-neutral-100" />
                    <div className="flex-1">
                      <p className="font-medium text-sm text-neutral-900">{item.product.name}</p>
                      <p className="text-xs text-neutral-500">Size: {item.size} | Qty: {item.quantity}</p>
                    </div>
                    <span className="font-medium text-sm">{formatCurrency((item.product.salePrice || item.product.price) * item.quantity)}</span>
                  </div>
                ))}
              </div>

              <div className="bg-neutral-50 rounded-xl p-4 mb-6">
                <h3 className="text-sm font-medium text-neutral-900 mb-2">Delivery Details</h3>
                <p className="text-sm text-neutral-600">{form.fullName}</p>
                <p className="text-sm text-neutral-600">{form.phone}</p>
                <p className="text-sm text-neutral-600">{form.email}</p>
                <p className="text-sm text-neutral-600 mt-2">
                  {form.deliveryMethod === 'collection' ? 'Collection at Jerry House' : form.deliveryLocation}
                </p>
              </div>

              <div className="flex gap-3">
                <Button variant="outline" onClick={() => setStep('details')}>Edit Details</Button>
                <Button size="lg" className="flex-1" onClick={handlePay}>
                  <CreditCard className="w-4 h-4 mr-2" />
                  Pay {formatCurrency(total)}
                </Button>
              </div>
            </Card>
          )}
        </div>

        {/* Summary Sidebar */}
        <div>
          <Card className="p-6 sticky top-24">
            <h2 className="text-lg font-semibold text-neutral-900 mb-4">Summary</h2>
            <div className="space-y-3">
              <div className="flex justify-between text-sm">
                <span className="text-neutral-600">Subtotal ({state.cart.length} items)</span>
                <span>{formatCurrency(subtotal)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-neutral-600">Delivery</span>
                <span>{deliveryFee === 0 ? 'Free' : formatCurrency(deliveryFee)}</span>
              </div>
              <div className="flex justify-between font-semibold border-t border-neutral-200 pt-3">
                <span>Total</span>
                <span>{formatCurrency(total)}</span>
              </div>
            </div>
            <div className="mt-4 p-3 bg-neutral-50 rounded-lg">
              <p className="text-xs text-neutral-500">Payment via M-Pesa STK Push. You will receive a prompt on your phone.</p>
            </div>
            <div className="mt-3 p-3 bg-amber-50 border border-amber-200 rounded-lg">
              <p className="text-xs text-amber-800 font-medium">Security Notice</p>
              <p className="text-xs text-amber-700 mt-0.5">Always verify payment requests. Never send money to unofficial numbers. Official WhatsApp: +254 106 624 924</p>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
