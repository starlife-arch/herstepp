import React, { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { ArrowLeft, CreditCard, MapPin, Store, Loader2, Check, AlertCircle, Heart } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { effectivePrice, hasDiscount } from '../context/AppContext';
import { Button, Card, Input, formatCurrency } from '../components/ui';
import { apiFetch } from '../lib/api';
import { productImageUrl, handleImageError } from '../lib/productImage';
import { deliveryFee as previewDeliveryFee, normalizeDelivery } from '../lib/delivery';
import type { CheckoutConfigResponse } from '../lib/apiTypes';
import { usePromo } from '../lib/usePromo';

type CheckoutConfig = CheckoutConfigResponse;

// Finite outcome of the payment poll. Anything else keeps polling until the
// 90-second deadline turns into 'STILL_PENDING'.
type PaymentOutcome = 'PAID' | 'CANCELLED' | 'FAILED' | 'TIMEOUT' | 'STILL_PENDING';

export default function Checkout() {
  const { state, dispatch } = useApp();
  const navigate = useNavigate();
  // /checkout?order=<doc id> — "Pay now" from the dashboard: retry payment for
  // an EXISTING order (no new order is created; the doc id stays internal).
  const [searchParams] = useSearchParams();
  const resumeOrderDocId = searchParams.get('order');
  const resumedRef = useRef(false);
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
  // "save to my profile" for the delivery/M-Pesa phone (used when the signed-in
  // profile has no phone yet — e.g. Google sign-ups).
  const [savePhoneToProfile, setSavePhoneToProfile] = useState(true);
  const { promoCode, setPromoCode, promo, promoError, applyPromo, removePromo } = usePromo(state.cart);

  // Delivery fees come ONLY from GET /api/checkout/config — never hardcoded.
  const [config, setConfig] = useState<CheckoutConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);

  // The authoritative amount to pay is the server total from /api/orders/create.
  const [serverTotal, setServerTotal] = useState<number | null>(null);

  // Payment state machine: the order is created ONCE and its id kept here so
  // "Try again" re-initiates the STK push for the SAME order (no second order).
  // Firestore document id — INTERNAL ONLY (payments API calls). Never rendered.
  const [orderDocId, setOrderDocId] = useState<string | null>(null);
  // Human order number HS-YYYY-NNNNNN — what the user sees everywhere.
  const [orderNumber, setOrderNumber] = useState<string | null>(null);
  const [failureReason, setFailureReason] = useState<string | null>(null);
  // Countdown + "I cancelled / I didn't get the prompt" UX state.
  const [secondsElapsed, setSecondsElapsed] = useState(0);
  const [cancelling, setCancelling] = useState(false);
  const [paidInfo, setPaidInfo] = useState<{ orderId: string; orderDocumentId: string | null; receiptNumber: string | null } | null>(null);
  // Ref mirrors so the async flow always sees the latest values (state lags).
  const orderNumberRef = useRef<string | null>(null);
  const failureReasonRef = useRef<string | null>(null);
  // The payment currently being polled — needed by the cancel button.
  const currentPaymentIdRef = useRef<string | null>(null);

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
          collectionLocation: typeof data?.collectionLocation === 'string' ? data.collectionLocation : 'Juja Town, Jerry House, near Juja Posta, Outside Shop No. 12',
          deliveryRates: normalizeDelivery(data).deliveryRates,
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
        setConfig({ deliveryEnabled: false, collectionEnabled: true, collectionLocation: 'Juja Town, Jerry House, near Juja Posta, Outside Shop No. 12', deliveryRates: normalizeDelivery({}).deliveryRates });
        setConfigError(err instanceof Error ? err.message : 'Could not load delivery options.');
      });
    return () => { cancelled = true; };
  }, []);

  const subtotal = state.cart.reduce((sum, item) => sum + effectivePrice(item.product) * item.quantity, 0);

  // Estimated fee for display only (from server rates). Collection is always
  // free. The ACTUAL amount to pay is the total returned by /api/orders/create.
  const estimateDeliveryFee = (): number => {
    if (form.deliveryMethod === 'collection') return 0;
    return previewDeliveryFee(config, form.deliveryLocation);
  };
  const deliveryFee = estimateDeliveryFee();
  const estimatedTotal = subtotal + deliveryFee - (promo?.discount || 0);
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
    if (!validate()) return;
    // Google sign-ups have no phone on their profile. The delivery/M-Pesa
    // phone collected here is saved back to users/{uid} — ALWAYS when the
    // profile phone is empty, or when the user ticks "save to my profile" —
    // so future checkouts and the M-Pesa prompt work without re-typing.
    if (state.user) {
      const wantsSave = savePhoneToProfile || !state.user.phone;
      if (wantsSave && state.user.phone !== form.phone.replace(/\s/g, '')) {
        void apiFetch('/api/auth/sync-profile', { method: 'POST', body: JSON.stringify({ phoneNumber: form.phone }) })
          .then(() => dispatch({ type: 'SET_USER', payload: { ...state.user!, phone: form.phone.replace(/\s/g, '') } }))
          .catch(() => { /* best-effort: checkout never blocks on profile sync */ });
      }
    }
    setStep('review');
  };

  const sleep = (ms: number) => new Promise<void>((resolve, reject) => {
    const resolveTimer = setTimeout(resolve, ms);
    const abortTimer = setTimeout(() => { clearTimeout(resolveTimer); reject(new Error('ABORTED')); }, ms + 10_000);
    // abortTimer only fires if something external never resolves; harmless.
    void abortTimer;
  });

  // Poll GET /api/payments/status every 2 s for up to 105 s. The server applies
  // its own timeout rule at RECONCILE_TIMEOUT_MS (100 s), so a lost prompt is
  // surfaced as TIMEOUT before our window closes. Network errors RETRY (they do
  // not end the flow); only a terminal status stops it.
  // Also captures the server's failureReason for CANCELLED/FAILED/TIMEOUT.
  const pollPaymentStatus = async (paymentId: string): Promise<PaymentOutcome> => {
    const started = Date.now();
    let consecutiveNetworkErrors = 0;
    while (!abortRef.current && Date.now() - started < 105_000) {
      const elapsed = Math.floor((Date.now() - started) / 1000);
      setSecondsElapsed(elapsed);
      try {
        const res = await apiFetch(`/api/payments/status?paymentId=${encodeURIComponent(paymentId)}`);
        consecutiveNetworkErrors = 0;
        const status = String(res?.payment?.status || '').toUpperCase();
        if (status === 'PAID' || status === 'CANCELLED' || status === 'FAILED' || status === 'TIMEOUT') {
          { const fr = typeof res?.payment?.failureReason === 'string' && res.payment.failureReason ? res.payment.failureReason : null; failureReasonRef.current = fr; setFailureReason(fr); }
          return status as PaymentOutcome;
        }
      } catch (err) {
        if (abortRef.current) return 'STILL_PENDING';
        consecutiveNetworkErrors += 1;
        // Transient network/poll failure: keep retrying within the window.
        if (consecutiveNetworkErrors >= 40) {
          setErrors({ payment: 'We could not reach the payment service. Please check Track Order shortly.' });
          return 'STILL_PENDING';
        }
      }
      // Pause polling while the tab is hidden: no background requests.
      if (document.visibilityState !== 'visible') {
        await new Promise<void>((resolve) => {
          const onVisible = () => {
            if (document.visibilityState === 'visible') {
              document.removeEventListener('visibilitychange', onVisible);
              resolve();
            }
          };
          document.addEventListener('visibilitychange', onVisible);
        });
        if (abortRef.current) return 'STILL_PENDING';
      }
      try { await sleep(2000); } catch { return 'STILL_PENDING'; } // aborted
    }
    return 'STILL_PENDING';
  };

  // "I cancelled / I didn't get the prompt": POST /api/payments/cancel does ONE
  // final provider.checkStatus — if PrintPay says PAID we apply that (never
  // cancel real money); otherwise the payment becomes CANCELLED and stock is
  // released, so the customer sees the truth instantly instead of waiting out
  // the full poll window.
  const handleCancelPrompt = async () => {
    if (!currentPaymentIdRef.current) return;
    setCancelling(true);
    try {
      const res: any = await apiFetch('/api/payments/cancel', {
        method: 'POST',
        body: JSON.stringify({ paymentId: currentPaymentIdRef.current }),
      });
      const status = String(res?.payment?.status || '').toUpperCase();
      const fr = typeof res?.payment?.failureReason === 'string' && res.payment.failureReason ? res.payment.failureReason : null;
      failureReasonRef.current = fr;
      setFailureReason(fr);
      if (status === 'PAID') {
        abortRef.current = true; // stop polling; the payment actually went through
        dispatch({ type: 'CLEAR_CART' });
        setPaidInfo({ orderId: orderNumberRef.current || 'your order', orderDocumentId: orderDocId, receiptNumber: res?.payment?.receiptNumber ?? null });
        setStep('success');
      } else {
        abortRef.current = true;
        setErrors({ payment: fr || 'You cancelled the M-Pesa request.' });
        setStep('review');
      }
    } catch (error) {
      // Cancel call failed (e.g. offline): keep polling; show the server message.
      setErrors({ payment: error instanceof Error ? error.message : 'Could not cancel the payment request. It will time out automatically.' });
    } finally {
      setCancelling(false);
    }
  };

  const runFlow = async (existingOrderId?: string | null) => {
    setErrors({});
    // Fresh orders require a verified email ("Verify your email to place
    // orders"). Resuming an EXISTING order after FAILED/TIMEOUT is still
    // allowed — the order was created while the account was in good standing.
    if (!existingOrderId && !orderDocId && !state.emailVerified) {
      setErrors({ payment: 'Verify your email to place orders.' });
      return;
    }
    // If we are not reusing an existing order, this attempt creates a fresh one.
    const reusingOrder = Boolean(existingOrderId || orderDocId);
    if (!reusingOrder) setServerTotal(null);
    setStep('processing');
    setFailureReason(null);
    let currentDocId = existingOrderId || orderDocId;
    let currentNumber = orderNumberRef.current;
    failureReasonRef.current = null;
    setFailureReason(null);
    try {
      // Create the order exactly once; reuse its ids on every retry.
      if (!currentDocId) {
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
            promoCode: promo?.code || null,
          }),
        });
        currentDocId = created?.order?.orderDocumentId ?? created?.order?.id ?? null;
        if (!currentDocId) throw new Error('The server did not return an order id. Please try again.');
        setOrderDocId(currentDocId);
        // The HS-... order number is what we show the customer — never the doc id.
        currentNumber = typeof created?.order?.orderId === 'string' ? created.order.orderId : null;
        orderNumberRef.current = currentNumber;
        setOrderNumber(currentNumber);
        // The amount to pay is the SERVER total returned by orders/create.
        const st = Number(created?.order?.total);
        if (Number.isFinite(st) && st > 0) setServerTotal(st);
      }

      const attempt = await apiFetch('/api/payments/stk/initiate', {
        method: 'POST',
        body: JSON.stringify({ orderDocumentId: currentDocId }),
      });
      const paymentId = attempt?.payment?.id;
      if (!paymentId) throw new Error('Payment could not be started.');
      currentPaymentIdRef.current = String(paymentId);
      setSecondsElapsed(0);
      if (attempt?.payment?.failureReason) { failureReasonRef.current = String(attempt.payment.failureReason); setFailureReason(failureReasonRef.current); }

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
        // Show the human HS-... order number, NEVER the Firestore document id.
        setPaidInfo({ orderId: currentNumber || 'your order', orderDocumentId: currentDocId, receiptNumber });
        setStep('success');
        return;
      }

      // Terminal non-paid outcomes: back to review with a clear red message.
      const fallbackMessages: Record<string, string> = {
        CANCELLED: 'You cancelled the M-Pesa request.',
        TIMEOUT: 'The M-Pesa request timed out.',
        FAILED: 'The payment failed (wrong PIN or insufficient funds).',
        STILL_PENDING: 'We have not received confirmation yet. Check Track Order shortly.',
      };
      // For CANCELLED / FAILED / TIMEOUT prefer the SERVER's failureReason
      // (e.g. "Wrong M-Pesa PIN entered.") in the red box above Pay.
      const serverReason = failureReasonRef.current;
      const message = (outcome !== 'STILL_PENDING' && serverReason)
        ? serverReason
        : (fallbackMessages[outcome] || 'The payment could not be completed.');
      setErrors({ payment: message });
      setStep('review');
    } catch (error) {
      if (abortRef.current) return;
      // Show EVERY server error in the red box directly above the Pay button.
      setErrors({ payment: error instanceof Error ? error.message : 'Payment could not be started.' });
      setStep('review');
    }
  };

  const handlePay = () => { void runFlow(null); };
  const handleRetryPayment = () => { void runFlow(orderDocId || resumeOrderDocId); }; // SAME order (doc id internal only), no second order

  // /checkout?order=<doc id>: "Pay now" from the dashboard. Skip the details
  // step and initiate the STK push for the EXISTING order immediately.
  useEffect(() => {
    if (!resumeOrderDocId || resumedRef.current) return;
    if (!state.authReady || !state.user) return; // wait so we never redirect to /cart on a cold render
    resumedRef.current = true;
    setOrderDocId(resumeOrderDocId);
    void runFlow(resumeOrderDocId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeOrderDocId, state.authReady, state.user]);

  // A resumed payment has an empty local cart — that is expected, the order
  // already exists server-side. Only bounce to /cart when there is genuinely
  // nothing to pay for.
  if (state.cart.length === 0 && step !== 'success' && !(resumeOrderDocId && state.authReady)) {
    navigate('/cart');
    return null;
  }

  const errorMessage = errors.payment || configError;
  const stillPendingMessage = typeof errorMessage === 'string' && (
    errorMessage === 'We have not received confirmation yet. Check Track Order shortly.'
    || errorMessage === 'We could not reach the payment service. Please check Track Order shortly.'
  );

  if (step === 'processing') {
    const remaining = Math.max(0, 105 - secondsElapsed);
    return (
      <div className="max-w-lg mx-auto px-4 py-20 text-center animate-fadeIn">
        <div className="w-16 h-16 bg-neutral-100 rounded-2xl flex items-center justify-center mx-auto mb-6">
          <Loader2 className="w-8 h-8 text-neutral-700 animate-spin" />
        </div>
        <h2 className="text-xl font-bold text-neutral-900 mb-2">Processing Payment</h2>
        <p className="text-neutral-500 text-sm">An M-Pesa prompt has been sent to {form.phone}. Please enter your PIN to complete the payment.</p>
        {/* Visible countdown — the server applies its own timeout at 100 s. */}
        <p className="text-neutral-700 text-sm mt-4 font-medium tabular-nums">Waiting for confirmation… {remaining}s left</p>
        {/* From 6 s after the prompt: let the customer cut the wait short. */}
        {secondsElapsed >= 6 && currentPaymentIdRef.current && (
          <Button variant="outline" className="mt-4" onClick={() => void handleCancelPrompt()} disabled={cancelling}>
            {cancelling ? 'Cancelling…' : 'I cancelled / I didn’t get the prompt'}
          </Button>
        )}
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
          {paidInfo && (
            <Link to={`/track?order=${encodeURIComponent(paidInfo.orderId)}`}><Button variant="outline">Track This Order</Button></Link>
          )}
          <Link to="/shop"><Button variant="outline">Continue Shopping</Button></Link>
          {/* In-app tipping entry point — inline link, no popups. */}
          <Link to="/tip" className="mt-2">
            <Card className="p-4 flex items-center justify-between gap-3 hover:bg-neutral-50 text-left">
              <div>
                <p className="text-sm font-medium text-neutral-900">Loved the service? Treat the team</p>
                <p className="text-xs text-neutral-500">A soda, a coffee or just a tip — completely optional.</p>
              </div>
              <Heart className="w-5 h-5 text-neutral-400 shrink-0" />
            </Card>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 animate-fadeIn">
      {/* Email must be verified before an order can be created. The server is
          the authority (GET /api/dashboard → profile.emailVerified, mirrored
          by state.emailVerified); orders/create refuses unverified accounts. */}
      {state.user && !state.emailVerified && (
        <div className="mb-6 p-3 rounded-lg bg-yellow-50 border border-yellow-200 flex items-center justify-between gap-3">
          <p className="text-sm text-yellow-800">Verify your email to place orders</p>
          <Link to="/verify-email" state={{ from: '/checkout' }}>
            <Button size="sm" variant="secondary">Verify now</Button>
          </Link>
        </div>
      )}
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
                {!state.user?.phone && (
                  <div className="p-3 rounded-lg bg-yellow-50 border border-yellow-200 text-sm text-yellow-800">
                    Add your phone number so we can send the M-Pesa prompt
                  </div>
                )}
                <Input label="Full Name" value={form.fullName} onChange={e => setForm({ ...form, fullName: e.target.value })} error={errors.fullName} placeholder="Enter your full name" />
                <div>
                  <Input label="Phone Number" value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} error={errors.phone} placeholder="+254 7XX XXX XXX" />
                  {state.user && (
                    <label className="flex items-center gap-2 mt-2 text-sm text-neutral-600">
                      <input type="checkbox" checked={savePhoneToProfile} onChange={e => setSavePhoneToProfile(e.target.checked)} className="rounded border-neutral-300" disabled={!state.user.phone} />
                      Save to my profile{!state.user.phone ? ' (recommended — your profile has no phone yet)' : ''}
                    </label>
                  )}
                </div>
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
                    <p className="text-xs text-neutral-500 mt-2">Delivery is currently unavailable. Collection only.</p>
                  )}
                </div>

                {form.deliveryMethod === 'delivery' && <div className="space-y-2">
                  <Input label="Delivery Location" value={form.deliveryLocation} onChange={e => setForm({ ...form, deliveryLocation: e.target.value })} error={errors.deliveryLocation} placeholder="e.g., Juja Town, near Stage" />
                  <p className="text-xs text-neutral-500">Estimated delivery fee: <span className="font-medium text-neutral-900">{deliveryFee === 0 ? 'Free' : formatCurrency(deliveryFee)}</span>. Juja is always free.</p>
                </div>}
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
                {orderDocId ? (
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
              {orderDocId && (
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
              <div className="pt-2">
                <div className="flex gap-2">
                  <input value={promoCode} onChange={event => setPromoCode(event.target.value)} placeholder="Promo code" className="min-w-0 flex-1 rounded-lg border border-neutral-300 px-3 py-2 text-sm" />
                  <Button size="sm" variant="outline" onClick={applyPromo}>Apply</Button>
                </div>
                {promo && <div className="mt-2 flex items-center justify-between rounded bg-emerald-50 px-2 py-1 text-xs text-emerald-800"><span>{promo.code} · -{formatCurrency(promo.discount)} · applies to: {promo.appliesTo.map((product: any) => product.name).join(', ')}</span><button onClick={removePromo}>Remove</button></div>}
                {promoError && <p className="mt-1 text-xs text-red-600">{promoError}</p>}
              </div>
              {promo && <div className="flex justify-between text-sm text-emerald-700"><span>Discount ({promo.code})</span><span>-{formatCurrency(promo.discount)}</span></div>}
              <div className="flex justify-between font-semibold border-t border-neutral-200 pt-3">
                <span>{serverTotal != null ? 'Amount to pay' : 'Estimated Total'}</span>
                <span>{formatCurrency(amountToPay)}</span>
              </div>
              {serverTotal != null && (
                <p className="text-xs text-neutral-400">Confirmed by the server for order {orderNumber || 'your order'}.</p>
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
