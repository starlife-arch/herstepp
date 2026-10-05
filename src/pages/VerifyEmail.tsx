import React, { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import { Button, Card } from '../components/ui';
import { apiFetch } from '../lib/api';
import { getFirebase } from '../lib/firebase';

// POST /api/auth/verify/send response (see api/_lib/routes/email-verify-core.js).
interface SendResult {
  sent?: boolean;
  verified?: boolean;
  maskedEmail?: string;
  expiresInSeconds?: number;
  resendInSeconds?: number;
}

const DIGIT_COUNT = 6;

// Only digits reach a box; everything else is stripped before storing.
const onlyDigits = (value: unknown) => String(value ?? '').replace(/\D/g, '');

export default function VerifyEmail() {
  const { state, dispatch, reloadDashboard } = useApp();
  const navigate = useNavigate();
  const location = useLocation();
  // Where to continue after verification — set by Checkout's "Verify now"
  // button (state.from); defaults to the dashboard, like the rest of auth.
  const from = (location.state as { from?: string } | null)?.from || '/dashboard';

  const [digits, setDigits] = useState<string[]>(Array(DIGIT_COUNT).fill(''));
  const [maskedEmail, setMaskedEmail] = useState('');
  const [error, setError] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [resendSeconds, setResendSeconds] = useState(0);
  const [resending, setResending] = useState(false);
  const boxesRef = useRef<Array<HTMLInputElement | null>>([]);

  const code = digits.join('');
  const complete = code.length === DIGIT_COUNT;

  const setDigit = (index: number, value: string) => {
    setDigits(prev => {
      const next = [...prev];
      next[index] = onlyDigits(value).slice(-1);
      return next;
    });
  };

  // Ask the server for a code on mount. Google accounts and already-verified
  // users get { verified: true } back without any email being sent — they are
  // bounced straight onward. A 429 (rate limit right after sign-up) keeps the
  // countdown instead of showing a scary error.
  useEffect(() => {
    let active = true;
    boxesRef.current[0]?.focus();
    (async () => {
      try {
        const result = await apiFetch('/api/auth/verify/send', { method: 'POST', body: JSON.stringify({}) }) as SendResult;
        if (!active) return;
        if (result?.verified === true) {
          void reloadDashboard();
          navigate(from, { replace: true });
          return;
        }
        if (typeof result?.maskedEmail === 'string') setMaskedEmail(result.maskedEmail);
        if (Number.isFinite(Number(result?.resendInSeconds))) {
          setResendSeconds(Math.max(0, Math.trunc(Number(result?.resendInSeconds))));
        }
      } catch (caughtError) {
        if (!active) return;
        const message = caughtError instanceof Error ? caughtError.message : '';
        const waitMatch = message.match(/in (\d+) seconds/);
        if (waitMatch) {
          // Still inside the 60 s cooldown (sign-up just sent the code):
          // honour the server's countdown instead of showing an error. The
          // page copy falls back to "your email address" without the mask.
          setResendSeconds(Math.max(1, Number(waitMatch[1])));
        } else {
          setError(message || 'We could not send the code. Please try again.');
        }
      }
    })();
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Resend countdown ticking once per second.
  useEffect(() => {
    if (resendSeconds <= 0) return undefined;
    const timer = window.setTimeout(() => setResendSeconds(s => Math.max(0, s - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [resendSeconds]);

  // Autofocus the first empty box whenever the digits change (typing,
  // backspacing or pasting all land on the right box).
  useEffect(() => {
    const firstEmpty = digits.findIndex(d => !d);
    const target = firstEmpty === -1 ? DIGIT_COUNT - 1 : firstEmpty;
    boxesRef.current[target]?.focus();
  }, [digits]);

  const handlePaste = (event: React.ClipboardEvent<HTMLInputElement>) => {
    event.preventDefault();
    const pasted = onlyDigits(event.clipboardData.getData('text')).slice(0, DIGIT_COUNT);
    if (!pasted) return;
    const next = Array(DIGIT_COUNT).fill('');
    pasted.split('').forEach((char, index) => { next[index] = char; });
    setDigits(next);
  };

  const handleKeyDown = (index: number, event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Backspace') {
      event.preventDefault();
      if (digits[index]) {
        setDigit(index, '');
      } else if (index > 0) {
        // Backspace on an empty box clears AND steps back one box.
        setDigit(index - 1, '');
        boxesRef.current[index - 1]?.focus();
      }
    } else if (event.key === 'ArrowLeft' && index > 0) {
      boxesRef.current[index - 1]?.focus();
    } else if (event.key === 'ArrowRight' && index < DIGIT_COUNT - 1) {
      boxesRef.current[index + 1]?.focus();
    }
  };

  const finishVerified = async () => {
    // Refresh the ID token so email_verified=true is in the claim BEFORE the
    // next order attempt, then pull the fresh profile from the server.
    try {
      const { auth } = await getFirebase();
      await auth.currentUser?.getIdToken(true);
    } catch { /* best-effort: the server flag is already written */ }
    dispatch({ type: 'SET_EMAIL_VERIFIED', payload: true });
    await reloadDashboard().catch(() => { /* banner falls back to server truth later */ });
    navigate(from, { replace: true });
  };

  const handleVerify = async () => {
    if (!complete || verifying) return;
    setVerifying(true);
    setError('');
    try {
      const result = await apiFetch('/api/auth/verify/confirm', {
        method: 'POST',
        body: JSON.stringify({ code }),
      }) as { verified?: boolean };
      if (result?.verified === true) {
        await finishVerified();
      } else {
        setError('We could not verify that code. Please request a new one.');
      }
    } catch (caughtError) {
      // Inline error (never a popup): wrong code w/ attempts left, expired,
      // too many attempts — the server's own friendly wording.
      setError(caughtError instanceof Error ? caughtError.message : 'We could not verify that code.');
      setDigits(Array(DIGIT_COUNT).fill(''));
      boxesRef.current[0]?.focus();
    } finally {
      setVerifying(false);
    }
  };

  const handleResend = async () => {
    if (resending || resendSeconds > 0) return;
    setResending(true);
    setError('');
    try {
      const result = await apiFetch('/api/auth/verify/send', { method: 'POST', body: JSON.stringify({}) }) as SendResult;
      if (result?.verified === true) {
        await finishVerified();
        return;
      }
      if (typeof result?.maskedEmail === 'string') setMaskedEmail(result.maskedEmail);
      setDigits(Array(DIGIT_COUNT).fill(''));
      setResendSeconds(Number.isFinite(Number(result?.resendInSeconds)) ? Math.max(0, Math.trunc(Number(result?.resendInSeconds))) : 60);
      boxesRef.current[0]?.focus();
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : '';
      const waitMatch = message.match(/in (\d+) seconds/);
      if (waitMatch) {
        setResendSeconds(Math.max(1, Number(waitMatch[1])));
      } else {
        setError(message || 'We could not send a new code. Please try again.');
      }
    } finally {
      setResending(false);
    }
  };

  return (
    <div className="min-h-[80vh] flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="w-12 h-12 bg-neutral-900 rounded-xl flex items-center justify-center mx-auto mb-4"><span className="text-white font-bold">H</span></div>
          <h1 className="text-2xl font-bold text-neutral-900">Verify your email</h1>
          <p className="text-sm text-neutral-500 mt-1">
            {maskedEmail ? <>We sent a 6-digit code to <span className="font-medium text-neutral-700">{maskedEmail}</span></> : 'We sent a 6-digit code to your email address'}
          </p>
        </div>
        <Card className="p-6">
          <div className="flex justify-between gap-2 mb-4" onPaste={handlePaste}>
            {digits.map((digit, index) => (
              <input
                key={index}
                ref={el => { boxesRef.current[index] = el; }}
                type="text"
                inputMode="numeric"
                autoComplete={index === 0 ? 'one-time-code' : 'off'}
                aria-label={`Digit ${index + 1}`}
                maxLength={1}
                value={digit}
                onChange={event => {
                  setDigit(index, event.target.value);
                  if (event.target.value && index < DIGIT_COUNT - 1) {
                    boxesRef.current[index + 1]?.focus();
                  }
                }}
                onKeyDown={event => handleKeyDown(index, event)}
                onFocus={event => event.target.select()}
                className="w-12 h-14 text-center text-xl font-semibold border border-neutral-300 rounded-lg focus:border-neutral-900 focus:outline-none"
              />
            ))}
          </div>
          {error && <div role="alert" className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>}
          <Button size="lg" className="w-full" onClick={handleVerify} disabled={!complete} loading={verifying}>
            Verify
          </Button>
          <div className="mt-4 text-center">
            {resendSeconds > 0 ? (
              <p className="text-sm text-neutral-500">Resend code in {resendSeconds}s</p>
            ) : (
              <button type="button" onClick={() => void handleResend()} disabled={resending} className="text-sm text-neutral-900 font-medium hover:underline disabled:opacity-50">
                {resending ? 'Sending…' : 'Resend code'}
              </button>
            )}
          </div>
          <p className="text-xs text-neutral-400 text-center mt-4">The code expires in 10 minutes.</p>
        </Card>
      </div>
    </div>
  );
}
