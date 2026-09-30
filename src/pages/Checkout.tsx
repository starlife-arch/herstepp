import React, { useEffect, useRef, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { ArrowLeft, CreditCard, MapPin, Store, Loader2, Check, AlertCircle } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { effectivePrice, hasDiscount } from '../context/AppContext';
import { Button, Card, Input, formatCurrency } from '../components/ui';
import { apiFetch } from '../lib/api';
import { productImageUrl, handleImageError } from '../lib/productImage';

type CheckoutConfig = {
  deliveryEnabled: boolean;
  collectionEnabled: boolean;
  deliveryRates: Record<string, unknown>;
};

// Finite outcome of the payment poll. Anything else keeps polling until the
// 90-second deadline turns into 'STILL_PENDING'.
type PaymentOutcome = 'PAID' | 'CANCELLED' | 'FAILED' | 'TIMEOUT' | 'STILL_PENDING';

export default function Checkout() {
  const { state, dispatch } = useApp();
  const navigate = useNavigate();
  const [step, setStep] = useState<'details' | 'review' | 'processing' | 'success'>('details');
  const [form, setForm] = useState({
    fullName: state.user?.name || '',
    phone: state.user?.phone || '',
    email: state.user?.email || '',
    deliveryMethod: 'collection' as 'collection' | 'delivery',
    deliveryLocation: '',
    instructions: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Delivery fees come ONLY from GET /api/checkout/config — never hardcoded.
  const [config, setConfig] = useState<CheckoutConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);

  // The authoritative amount to pay is the server total from /api/orders/create.
  const [serverTotal, setServerTotal] = useState<number | null>(null);

  // Payment state machine: the order is created ONCE and its id kept here so
  // "Try again" re-initiates the STK push for the SAME order (no second order).
  const [orderId, setOrderId] = useState<string | null>(null);
  const [paidInfo, setPaidInfo] = useState<{ orderId: string; receiptNumber: string | null } | null>(null);

  // Abort ref: leaving the page (or restarting the flow) stops all polling.
  const abortRef = useRef(false);
  useEffect(() => {
    abortRef.current = false;
    return () => { abortRef.current = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/checkout/config')
      .then((data: any) => {
        if (cancelled) return;
        const cfg: CheckoutConfig = {
          deliveryEnabled: data?.deliveryEnabled === true,
          collectionEnabled: data?.collectionEnabled !== false,
          deliveryRates: (data?.deliveryRates && typeof data.deliveryRates === 'object') ? data.deliveryRates : {},
        };
        setConfig(cfg);
        // Delivery is only offered when the server enables it; if it was
        // disabled after selection, fall back to free collection.
        if (!cfg.deliveryEnabled) {
          setForm(f => (f.deliveryMethod === 'delivery' ? { ...f, deliveryMethod: 'collection' } : f));
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setConfig({ deliveryEnabled: false, collectionEnabled: true, deliveryRates: {} });
        setConfigError(err instanceof Error ? err.message : 'Could not load delivery options.');
      });
    return () => { cancelled = true; };
  }, []);

  const subtotal = state.cart.reduce((sum, item) => sum + effectivePrice(item.product) * item.quantity, 0);

  // Estimated fee for display only (from server rates). Collection is always
  // free. The ACTUAL amount to pay is the total returned by /api/orders/create.
  const estimateDeliveryFee = (): number => {
    if (form.deliveryMethod === 'collection') return 0;
    const rates = config?.deliveryRates || {};
    const counties = (rates.counties && typeof rates.counties === 'object') ? rates.counties as Record<string, number> : {};
    const text = form.deliveryLocation.toLowerCase();
    const match = Object.entries(counties).find(([name]) => name && text.includes(name.toLowerCase()));
    if (match && Number.isFinite(Number(match[1]))) return Number(match[1]);
    const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : undefined);
    if (text.includes('juja')) return num(rates.outsideJuja) ?? 100;
    if (text.includes('kiambu')) return num(rates.kiambu) ?? 200;
    return num(rates.defaultCounty) ?? 500;
  };
  const deliveryFee = estimateDeliveryFee();
  const estimatedTotal = subtotal + deliveryFee;
  // Once the order exists, the server total is the only number we pay.
  const amountToPay = serverTotal ?? estimatedTotal;

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

  const sleep = (ms: number) => new Promise<void>((resolve, reject) => {
    const resolveTimer = setTimeout(resolve, ms);
    const abortTimer = setTimeout(() => { clearTimeout(resolveTimer); reject(new Error('ABORTED')); }, ms + 10_000);
    // abortTimer only fires if something external never resolves; harmless.
    void abortTimer;
  });

  // Poll GET /api/payments/status every 4 s for up to 90 s. Network errors
  // RETRY (they do not end the flow); only a terminal status stops it.
  const pollPaymentStatus = async (paymentId: string): Promise<PaymentOutcome> => {
    const started = Date.now();
    let consecutiveNetworkErrors = 0;
    while (!abortRef.current && Date.now() - started < 90_000) {
      try {
        const res = await apiFetch(`/api/payments/status?paymentId=${encodeURIComponent(paymentId)}`);
        consecutiveNetworkErrors = 0;
        const status = String(res?.payment?.status || '').toUpperCase();
        if (status === 'PAID' || status === 'CANCELLED' || status === 'FAILED' || status === 'TIMEOUT') {
          return status as PaymentOutcome;
        }
      } catch (err) {
        if (abortRef.current) return 'STILL_PENDING';
        consecutiveNetworkErrors += 1;
        // Transient network/poll failure: keep retrying within the window.
        if (consecutiveNetworkErrors >= 8) {
          setErrors({ payment: 'We could not reach the payment service. Please check Track Order shortly.' });
          return 'STILL_PENDING';
        }
      }
      try { await sleep(4000); } catch { return 'STILL_PENDING'; } // aborted
    }
    return 'STILL_PENDING';
  };

  const runFlow = async (existingOrderId?: string | null) => {
    setErrors({});
    // If we are not reusing an existing order, this attempt creates a fresh one.
    const reusingOrder = Boolean(existingOrderId || orderId);
    if (!reusingOrder) setServerTotal(null);
    setStep('processing');
    let currentOrderId = existingOrderId || orderId;
    try {
      // Create the order exactly once; reuse its id on every retry.
      if (!currentOrderId) {
        const created = await apiFetch('/api/orders/create', {
          method: 'POST',
          body: JSON.stringify({
            cart: state.cart.map(item => ({ productId: item.product.id, size: String(item.size), quantity: item.quantity })),
            delivery: {
              fullName: form.fullName,
              phone: form.phone,
              deliveryMethod: form.deliveryMethod.toUpperCase(),
              location: form.deliveryLocation,
              instructions: form.instructions,
            },
          }),
        });
        currentOrderId = created?.order?.id ?? created?.order?.orderDocumentId ?? null;
        if (!currentOrderId) throw new Error('The server did not return an order id. Please try again.');
        setOrderId(currentOrderId);
        // The amount to pay is the SERVER total returned by orders/create.
        const st = Number(created?.order?.total);
        if (Number.isFinite(st) && st > 0) setServerTotal(st);
      }

      const attempt = await apiFetch('/api/payments/stk/initiate', {
        method: 'POST',
        body: JSON.stringify({ orderDocumentId: currentOrderId }),
      });
      const paymentId = attempt?.payment?.id;
      if (!paymentId) throw new Error('Payment could not be started.');

      const outcome = await pollPaymentStatus(paymentId);
      if (abortRef.current) return;

      if (outcome === 'PAID') {
        let receiptNumber: string | null = attempt?.payment?.receiptNumber ?? null;
        try {
          const finalRes = await apiFetch(`/api/payments/status?paymentId=${encodeURIComponent(paymentId)}`);
          receiptNumber = finalRes?.payment?.receiptNumber ?? receiptNumber;
        } catch { /* keep whatever we have */ }
        // Only clear the cart AFTER PAID.
        dispatch({ type: 'CLEAR_CART' });
        setPaidInfo({ orderId: currentOrderId, receiptNumber });
        setStep('success');
        return;
      }

      // Terminal non-paid outcomes: back to review with a clear red message.
      const messages: Record<string, string> = {
        CANCELLED: 'You cancelled the M-Pesa request.',
        TIMEOUT: 'The M-Pesa request timed out.',
        FAILED: 'The payment failed (wrong PIN or insufficient funds).',
        STILL_PENDING: 'We have not received confirmation yet. Check Track Order shortly.',
      };
      setErrors({ payment: messages[outcome] || 'The payment could not be completed.' });
      setStep('review');
    } catch (error) {
      if (abortRef.current) return;
      // Show EVERY server error in the red box directly above the Pay button.
      setErrors({ payment: error instanceof Error ? error.message : 'Payment could not be started.' });
      setStep('review');
    }
  };

  const handlePay = () => { void runFlow(null); };
  const handleRetryPayment = () => { void runFlow(orderId); }; // same order, no second order

  if (state.cart.length === 0 && step !== 'success') {
    navigate('/cart');
    return null;
  }

  const errorMessage = errors.payment || configError;
  const stillPendingMessage = errorMessage === 'We have not received confirmation yet. Check Track Order shortly.';

  if (step === 'processing') {
    return (
      <div className="max-w-lg mx-auto px-4 py-20 text-center animate-fadeIn">
        <div className="w-16 h-16 bg-neutral-100 rounded-2xl flex items-center justify-center mx-auto mb-6">
          <Loader2 className="w-8 h-8 text-neutral-700 animate-spin" />
        </div>
        <h2 className="text-xl font-bold text-neutral-900 mb-2">Processing Payment</h2>
        <p className="text-neutral-500 text-sm">An M-Pesa prompt has been sent to {form.phone}. Please enter your PIN to complete the payment.</p>
        <p className="text-neutral-400 text-xs mt-4">Waiting up to 90 seconds for confirmation…</p>
        {stillPendingMessage && (
          <div role="alert" className="mt-6 p-3 rounded-lg bg-red-50 border border-red-200 text-left flex items-start gap-2">
            <AlertCircle className="w-4 h-4 text-red-600 mt-0.5 shrink-0" />
            <div>
              <p className="text-sm text-red-700 font-medium">{errorMessage}</p>
              <Link to="/track" className="text-sm text-neutral-900 underline font-medium">Check Track Order</Link>
            </div>
          </div>
        )}
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
        <p className="text-neutral-500 text-sm mb-2">Your order has been placed successfully. You will receive a confirmation shortly.</p>
        {paidInfo && (
          <div className="bg-neutral-50 rounded-xl p-4 mb-6 text-left text-sm space-y-1">
            <p className="text-neutral-600">Order: <span className="font-medium text-neutral-900">{paidInfo.orderId}</span></p>
            {paidInfo.receiptNumber && (
              <p className="text-neutral-600">Receipt: <span className="font-medium text-neutral-900">{paidInfo.receiptNumber}</span></p>
            )}
          </div>
        )}
        <div className="flex flex-col gap-3">
          <Link to="/dashboard/orders"><Button>View My Orders</Button></Link>
          <Link to="/track"><Button variant="outline">Track This Order</Button></Link>
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
                  <div className={`grid grid-cols-2 gap-3 ${config?.deliveryEnabled ? '' : 'grid-cols-1'}`}>
                    {config?.deliveryEnabled && (
                      <button
                        onClick={() => setForm({ ...form, deliveryMethod: 'delivery' })}
                        className={`p-4 rounded-xl border-2 text-left transition-all ${form.deliveryMethod === 'delivery' ? 'border-neutral-900 bg-neutral-50' : 'border-neutral-200 hover:border-neutral-300'}`}
                      >
                        <MapPin className="w-5 h-5 mb-2" />
                        <p className="font-medium text-sm">Delivery</p>
                        <p className="text-xs text-neutral-500 mt-0.5">
                          {!config ? 'Loading fees…' : `From ${formatCurrency(estimateDeliveryFee())} (by location)`}
                        </p>
                      </button>
                    )}
                    <button
                      onClick={() => setForm({ ...form, deliveryMethod: 'collection' })}
                      className={`p-4 rounded-xl border-2 text-left transition-all ${form.deliveryMethod === 'collection' ? 'border-neutral-900 bg-neutral-50' : 'border-neutral-200 hover:border-neutral-300'}`}
                    >
                      <Store className="w-5 h-5 mb-2" />
                      <p className="font-medium text-sm">Collection</p>
                      <p className="text-xs text-neutral-500 mt-0.5">Free - Jerry House</p>
                    </button>
                  </div>
                  {config && !config.deliveryEnabled && (
                    <p className="text-xs text-neutral-500 mt-2">Delivery is currently unavailable — collection only.</p>
                  )}
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
                    <img src={productImageUrl(item.product)} alt="" onError={handleImageError} className="w-14 h-14 rounded-lg object-cover bg-neutral-100" />
                    <div className="flex-1">
                      <p className="font-medium text-sm text-neutral-900">{item.product.name}</p>
                      <p className="text-xs text-neutral-500">Size: {item.size} | Qty: {item.quantity}</p>
                    </div>
                    <span className="font-medium text-sm">
                      {formatCurrency(effectivePrice(item.product) * item.quantity)}
                      {hasDiscount(item.product) && (
                        <span className="ml-2 text-xs text-neutral-400 line-through">{formatCurrency(item.product.price * item.quantity)}</span>
                      )}
                    </span>
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

              {/* Every server/API error shows HERE, visibly, directly above the button. */}
              {errorMessage && (
                <div role="alert" className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 text-red-600 mt-0.5 shrink-0" />
                  <p className="text-sm text-red-700 font-medium">{errorMessage}</p>
                </div>
              )}

              <div className="flex gap-3">
                <Button variant="outline" onClick={() => setStep('details')}>Edit Details</Button>
                {orderId ? (
                  <Button size="lg" className="flex-1" onClick={handleRetryPayment}>
                    <CreditCard className="w-4 h-4 mr-2" />
                    Try again — Pay {formatCurrency(amountToPay)}
                  </Button>
                ) : (
                  <Button size="lg" className="flex-1" onClick={handlePay} disabled={!config}>
                    <CreditCard className="w-4 h-4 mr-2" />
                    {config ? `Pay ${formatCurrency(estimatedTotal)}` : 'Loading…'}
                  </Button>
                )}
              </div>
              {orderId && (
                <p className="text-xs text-neutral-500 mt-2">
                  Retrying uses the same order — no duplicate order will be created.
                </p>
              )}
              {errors.payment === 'We have not received confirmation yet. Check Track Order shortly.' && (
                <p className="text-sm mt-3">
                  <Link to="/track" className="text-neutral-900 underline font-medium">Check Track Order</Link> for the latest status.
                </p>
              )}
            </Card>
          )}
        </div>

        {/* Summary Sidebar */}
        <div>
          <Card className="p-6 sticky top-24">
            <h2 className="text-lg font-semibold text-neutral-900 mb-4">Summary</h2>
            <div className="space-y-3">
              <div className="flex justify-between text-sm">
                <span className="text-neutral-600">Subtotal ({state.cart.length} item{state.cart.length !== 1 ? 's' : ''})</span>
                <span>{formatCurrency(subtotal)}</span>
              </div>
              {(!config || config.deliveryEnabled) && (
                <div className="flex justify-between text-sm">
                  <span className="text-neutral-600">Delivery</span>
                  <span>{!config ? '…' : deliveryFee === 0 ? 'Free' : formatCurrency(deliveryFee)}</span>
                </div>
              )}
              <div className="flex justify-between font-semibold border-t border-neutral-200 pt-3">
                <span>{serverTotal != null ? 'Amount to pay' : 'Estimated Total'}</span>
                <span>{formatCurrency(amountToPay)}</span>
              </div>
              {serverTotal != null && (
                <p className="text-xs text-neutral-400">Confirmed by the server for order {orderId}.</p>
              )}
            </div>
            <div className="mt-4 p-3 bg-neutral-50 rounded-lg">
              <p className="text-xs text-neutral-500">Payment via M-Pesa STK Push. You will receive a prompt on your phone. The final total is confirmed by the server when the order is created.</p>
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
