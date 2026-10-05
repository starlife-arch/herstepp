// /tip — "Treat the team". In-app tipping with M-Pesa. Everything is INLINE:
// no alert/confirm/prompt/window.open anywhere on this page. Reuses the
// existing Button/Card/Input/Badge components and the same waiting-card
// pattern as Checkout (spinner, countdown, poll every 2 s, cancel button
// after 6 s). Signed-out visitors see the page and a "Sign in to send"
// button that returns them here after login (location.state.from).
import React, { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Loader2, Check, AlertCircle, CupSoda, Coffee, Leaf, Cookie, Heart } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { Button, Card, Input, Badge, getStatusBadge, formatCurrency } from '../components/ui';
import { apiFetch } from '../lib/api';

// Hardcoded preset amounts (KSh) — shown as chips in a responsive grid.
const TIP_PRESETS = [50, 100, 200, 500, 1000, 2000, 5000, 10000];

const TREAT_OPTIONS = [
  { value: 'SODA', label: 'Soda', icon: CupSoda },
  { value: 'COFFEE', label: 'Coffee', icon: Coffee },
  { value: 'TEA', label: 'Tea', icon: Leaf },
  { value: 'SNACK', label: 'Snack', icon: Cookie },
  { value: 'TIP', label: 'Just a tip', icon: Heart },
] as const;

type TipOutcome = 'PAID' | 'CANCELLED' | 'FAILED' | 'TIMEOUT' | 'STILL_PENDING';

interface TipView {
  tipId: string;
  amount: number;
  treat: string;
  treatLabel?: string;
  message?: string;
  status: string;
  receiptNumber?: string | null;
  failureReason?: string | null;
  createdAt?: string;
}

const sleep = (ms: number) => new Promise<void>(resolve => { const t = setTimeout(resolve, ms); void t; });

export default function TipPage() {
  const { state } = useApp();
  const navigate = useNavigate();
  const user = state.user;

  useEffect(() => { document.title = 'Treat the team | HerStep'; }, []);

  const [treat, setTreat] = useState<string>('TIP');
  const [amountText, setAmountText] = useState<string>('100');
  const [selectedPreset, setSelectedPreset] = useState<number | null>(100);
  const [phone, setPhone] = useState<string>(user?.phone || '');
  const [message, setMessage] = useState<string>('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  // phase: form -> waiting -> done(success|failure)
  const [phase, setPhase] = useState<'form' | 'waiting' | 'success' | 'failure'>('form');
  const [secondsElapsed, setSecondsElapsed] = useState(0);
  const [cancelling, setCancelling] = useState(false);
  const [paidTip, setPaidTip] = useState<TipView | null>(null);
  const [failedTip, setFailedTip] = useState<TipView | null>(null);
  const [myTips, setMyTips] = useState<TipView[]>([]);
  const abortRef = useRef(false);

  useEffect(() => () => { abortRef.current = true; }, []);

  const loadTips = async () => {
    if (!user) return;
    try {
      const res: any = await apiFetch('/api/tips');
      setMyTips(Array.isArray(res?.tips) ? res.tips : []);
    } catch { /* list is best-effort */ }
  };
  useEffect(() => { void loadTips(); }, [user]);

  const amount = Number(amountText);
  const amountValid = Number.isInteger(amount) && amount >= 10 && amount <= 150000;

  const pickPreset = (value: number) => {
    setSelectedPreset(value);
    setAmountText(String(value));
    setErrors(e => ({ ...e, amount: '' }));
  };
  const onCustomAmount = (v: string) => {
    setSelectedPreset(null); // typing a custom amount clears the chip
    setAmountText(v.replace(/[^0-9]/g, ''));
  };

  // Same polling rules as Checkout: every 2 s, terminal statuses stop it,
  // transient errors retry. The server turns stale PENDING into TIMEOUT.
  const pollTipStatus = async (tipId: string): Promise<TipOutcome> => {
    const started = Date.now();
    while (!abortRef.current && Date.now() - started < 105_000) {
      setSecondsElapsed(Math.floor((Date.now() - started) / 1000));
      try {
        const res: any = await apiFetch(`/api/tips/status?tipId=${encodeURIComponent(tipId)}`);
        const tip = res?.tip as TipView | undefined;
        const status = String(tip?.status || '').toUpperCase();
        if (status === 'PAID' || status === 'CANCELLED' || status === 'FAILED' || status === 'TIMEOUT') {
          return status as TipOutcome;
        }
      } catch { /* keep retrying within the window */ }
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
      await sleep(2000);
    }
    return 'STILL_PENDING';
  };

  const handleCancelPrompt = async () => {
    if (!paidTipRef.current) return;
    setCancelling(true);
    try {
      const res: any = await apiFetch('/api/tips/cancel', {
        method: 'POST',
        body: JSON.stringify({ tipId: paidTipRef.current }),
      });
      const tip = res?.tip as TipView;
      abortRef.current = true;
      if (String(tip?.status).toUpperCase() === 'PAID') {
        setPaidTip(tip); setPhase('success');
      } else {
        setFailedTip(tip); setPhase('failure');
      }
      void loadTips();
    } catch {
      setErrors(e => ({ ...e, payment: 'Could not cancel the request. It will time out automatically.' }));
    } finally {
      setCancelling(false);
    }
  };

  const sendTip = async () => {
    if (!user) {
      navigate('/login', { state: { from: '/tip' } });
      return;
    }
    const nextErrors: Record<string, string> = {};
    if (!amountValid) nextErrors.amount = 'Enter a whole number between KSh 10 and KSh 150,000.';
    if (!/^\+?254[0-9\s-]{9,12}$/.test(phone.trim())) nextErrors.phone = 'Enter a Kenyan phone number (+254…).';
    if (message.length > 200) nextErrors.message = 'Keep your message to 200 characters or fewer.';
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) return;

    setPhase('waiting');
    setSecondsElapsed(0);
    abortRef.current = false;
    paidTipRef.current = null;
    try {
      const res: any = await apiFetch('/api/tips/create', {
        method: 'POST',
        body: JSON.stringify({ amount, treat, phone: phone.trim(), message: message.trim() }),
      });
      const tip = res?.tip as TipView;
      if (!tip?.tipId) throw new Error('no-tip');
      paidTipRef.current = tip.tipId;
      setPaidTip(tip);
      setFailedTip(tip);
      const outcome = await pollTipStatus(tip.tipId);
      if (outcome === 'PAID') {
        // Refetch once so we display the final receipt number.
        const after: any = await apiFetch(`/api/tips/status?tipId=${encodeURIComponent(tip.tipId)}`).catch(() => null);
        setPaidTip((after?.tip as TipView) || tip);
        setPhase('success');
      } else if (outcome === 'STILL_PENDING') {
        setFailedTip({ ...tip, failureReason: 'We have not received confirmation yet. It may still arrive — check the list below.' });
        setPhase('failure');
      } else {
        const latest: any = await apiFetch(`/api/tips/status?tipId=${encodeURIComponent(tip.tipId)}`).catch(() => null);
        setFailedTip((latest?.tip as TipView) || { ...tip, failureReason: 'The M-Pesa request did not go through.' });
        setPhase('failure');
      }
      void loadTips();
    } catch (error) {
      const msg = error instanceof Error && error.message && error.message !== 'no-tip'
        ? error.message
        : 'We could not start the payment. Please try again.';
      setFailedTip({ tipId: '', amount, treat, status: 'FAILED', failureReason: msg });
      setPhase('failure');
    }
  };

  const paidTipRef = useRef<string | null>(null);

  // ---------- inline waiting card (same pattern as Checkout) ----------
  if (phase === 'waiting') {
    const remaining = Math.max(0, 105 - secondsElapsed);
    return (
      <div className="max-w-lg mx-auto px-4 py-20 text-center animate-fadeIn">
        <div className="w-16 h-16 bg-neutral-100 rounded-2xl flex items-center justify-center mx-auto mb-6">
          <Loader2 className="w-8 h-8 text-neutral-700 animate-spin" />
        </div>
        <h2 className="text-xl font-bold text-neutral-900 mb-2">Confirm your M-Pesa prompt</h2>
        <p className="text-neutral-500 text-sm">We sent an STK push to {phone}. Enter your PIN to treat the team.</p>
        <p className="text-neutral-700 text-sm mt-4 font-medium tabular-nums">Waiting for confirmation… {remaining}s left</p>
        {secondsElapsed >= 6 && paidTipRef.current && (
          <Button variant="outline" className="mt-4" onClick={() => void handleCancelPrompt()} disabled={cancelling}>
            {cancelling ? 'Cancelling…' : 'I cancelled / I didn’t get the prompt'}
          </Button>
        )}
        {errors.payment && (
          <div role="alert" className="mt-6 p-3 rounded-lg bg-red-50 border border-red-200 text-left text-sm text-red-700">{errors.payment}</div>
        )}
      </div>
    );
  }

  // ---------- inline success card ----------
  if (phase === 'success' && paidTip) {
    return (
      <div className="max-w-lg mx-auto px-4 py-20 text-center animate-fadeIn">
        <div className="w-16 h-16 bg-emerald-50 rounded-2xl flex items-center justify-center mx-auto mb-6">
          <Check className="w-8 h-8 text-emerald-600" />
        </div>
        <h2 className="text-xl font-bold text-neutral-900 mb-2">Thank you!</h2>
        <p className="text-neutral-500 text-sm mb-2">Your {formatCurrency(paidTip.amount)} treat is on its way to the team.</p>
        <div className="bg-neutral-50 rounded-xl p-4 mb-6 text-left text-sm space-y-1">
          {paidTip.receiptNumber && <p className="text-neutral-600">Receipt: <span className="font-medium text-neutral-900">{paidTip.receiptNumber}</span></p>}
        </div>
        <Button onClick={() => { setPhase('form'); setPaidTip(null); void loadTips(); }}>Send another</Button>
      </div>
    );
  }

  // ---------- inline failure card ----------
  if (phase === 'failure' && failedTip) {
    return (
      <div className="max-w-lg mx-auto px-4 py-20 text-center animate-fadeIn">
        <div className="w-16 h-16 bg-red-50 rounded-2xl flex items-center justify-center mx-auto mb-6">
          <AlertCircle className="w-8 h-8 text-red-600" />
        </div>
        <h2 className="text-xl font-bold text-neutral-900 mb-2">Payment not completed</h2>
        <p className="text-neutral-500 text-sm mb-6">{failedTip.failureReason || 'The M-Pesa request did not go through.'}</p>
        <div className="flex flex-col gap-3 items-center">
          <Button onClick={() => { setPhase('form'); setFailedTip(null); }}>Try again</Button>
          <Button variant="outline" onClick={() => { setPhase('form'); void loadTips(); }}>Back to the form</Button>
        </div>
      </div>
    );
  }

  // ---------- the form ----------
  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-10 animate-fadeIn">
      <h1 className="text-2xl font-bold text-neutral-900 mb-2">Treat the team</h1>
      <p className="text-neutral-500 text-sm mb-8">
        Say thanks to the HerStep team with a soda, a coffee or a tip. Completely optional, always appreciated.
      </p>

      <Card className="p-6 space-y-6">
        {!user && (
          <div className="p-3 rounded-lg bg-neutral-50 border border-neutral-200 text-sm text-neutral-700 flex items-center justify-between gap-3">
            <span>You need an account to send a tip.</span>
            <Link to="/login" state={{ from: '/tip' }}><Button size="sm">Sign in to send</Button></Link>
          </div>
        )}

        <div>
          <h2 className="text-sm font-semibold text-neutral-900 mb-3">What would you like to treat them to?</h2>
          <div className="flex flex-wrap gap-2">
            {TREAT_OPTIONS.map(({ value, label, icon: Icon }) => (
              <button
                key={value}
                type="button"
                onClick={() => setTreat(value)}
                className={`inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium transition-colors ${
                  treat === value ? 'border-neutral-900 bg-neutral-900 text-white' : 'border-neutral-300 text-neutral-700 hover:bg-neutral-50'
                }`}
              >
                <Icon className="w-4 h-4" /> {label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <h2 className="text-sm font-semibold text-neutral-900 mb-3">Amount</h2>
          <div className="grid grid-cols-4 gap-2 mb-3">
            {TIP_PRESETS.map(value => (
              <button
                key={value}
                type="button"
                onClick={() => pickPreset(value)}
                aria-pressed={selectedPreset === value}
                className={`rounded-lg border px-2 py-2 text-sm font-medium tabular-nums transition-colors ${
                  selectedPreset === value ? 'border-neutral-900 bg-neutral-900 text-white' : 'border-neutral-300 text-neutral-700 hover:bg-neutral-50'
                }`}
              >
                KSh {value.toLocaleString()}
              </button>
            ))}
          </div>
          <Input
            label="Custom amount (KSh)"
            inputMode="numeric"
            value={amountText}
            onChange={e => onCustomAmount(e.target.value)}
            error={errors.amount || undefined}
            placeholder="e.g. 150"
          />
        </div>

        <Input
          label="M-Pesa phone number"
          value={phone}
          onChange={e => setPhone(e.target.value)}
          error={errors.phone || undefined}
          placeholder="+254 7XX XXX XXX"
        />

        <div>
          <label className="block text-sm font-medium text-neutral-700 mb-1">Message (optional)</label>
          <textarea
            value={message}
            maxLength={200}
            onChange={e => setMessage(e.target.value)}
            rows={3}
            className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-neutral-900"
            placeholder="Add a note of thanks…"
          />
          <p className="text-xs text-neutral-500 mt-1 text-right tabular-nums">{message.length}/200</p>
        </div>

        <div>
          <Button className="w-full" onClick={() => void sendTip()} disabled={!user ? false : !amountValid}>
            Send {amountValid ? formatCurrency(amount) : 'tip'}
          </Button>
          <p className="text-xs text-neutral-500 mt-2 text-center">You will get an M-Pesa prompt on your phone.</p>
        </div>
      </Card>

      {user && myTips.length > 0 && (
        <div className="mt-10">
          <h2 className="text-lg font-semibold text-neutral-900 mb-3">Your tips</h2>
          <div className="space-y-2">
            {myTips.map(tip => {
              const badge = getStatusBadge(tip.status);
              return (
                <Card key={tip.tipId} className="p-4 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-neutral-900">{formatCurrency(tip.amount)}</span>
                      <Badge variant={badge.variant}>{badge.label}</Badge>
                    </div>
                    <p className="text-xs text-neutral-500 mt-0.5 truncate">
                      {tip.treatLabel || tip.treat}{tip.receiptNumber ? ` · ${tip.receiptNumber}` : ''}{tip.message ? ` · “${tip.message}”` : ''}
                    </p>
                  </div>
                </Card>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
