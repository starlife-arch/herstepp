import React, { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Eye, EyeOff } from 'lucide-react';
import {
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
} from 'firebase/auth';
import { apiFetch } from '../lib/api';
import { continueWithGoogle, getFirebase, handleGoogleRedirectResult } from '../lib/firebase';
import { Button, Input, Card } from '../components/ui';

// Google's multi-colour "G" as an inline SVG (no external image assets).
export function GoogleLogo({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden="true" focusable="false">
      <path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3l5.7-5.7C34 6 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.7-.4-3.9z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3l5.7-5.7C34 6 29.3 4 24 4 15.4 4 7.8 8.9 4.3 16z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2c-2 1.4-4.6 2.4-7.2 2.4-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C15.8 39 19.6 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C36.9 39.2 44 34 44 24c0-1.3-.1-2.7-.4-3.9z" />
    </svg>
  );
}

function googleErrorMessage(error: unknown) {
  const code = typeof error === 'object' && error && 'code' in error ? String((error as { code: unknown }).code) : '';
  if (code === 'auth/account-exists-with-different-credential') {
    return 'This email already has an account. Sign in with your password.';
  }
  if (code === 'auth/popup-blocked') return 'Your browser blocked the Google popup. Please allow popups and try again.';
  if (code === 'auth/network-request-failed') return 'Network error. Check your connection and try again.';
  return authErrorMessage(error);
}

// Shared "Continue with Google" button + "or" divider for Login and Register.
// On success we sync the profile server-side and honour the F2 return-to-page
// behaviour: go back where the user came from (location.state.from), else the
// dashboard — exactly like a successful email sign-in.
function GoogleSignInButton() {
  const navigate = useNavigate();
  const location = useLocation();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const from = (location.state as { from?: string } | null)?.from || '/dashboard';

  // If a redirect fallback completed while this page was closed, surface its
  // result on mount (handleGoogleRedirectResult never rejects).
  useEffect(() => {
    let active = true;
    void handleGoogleRedirectResult()
      .then(async (user) => {
        if (!active || !user) return;
        await apiFetch('/api/auth/sync-profile', { method: 'POST', body: JSON.stringify({}) });
        if (active) navigate(from, { replace: true });
      })
      .catch(() => { /* sync retried on next sign-in */ });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleClick = async () => {
    setLoading(true);
    setError('');
    try {
      const outcome = await continueWithGoogle();
      if (outcome === 'signed-in') {
        try {
          await apiFetch('/api/auth/sync-profile', { method: 'POST', body: JSON.stringify({}) });
        } catch { /* profile sync retries on the next sign-in */ }
        navigate(from, { replace: true });
      }
      // 'cancelled': the user closed the popup — not an error, stay put.
      // 'redirecting': the page is navigating to Google; handled on return.
    } catch (caughtError) {
      setError(googleErrorMessage(caughtError));
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      {error && <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>}
      <Button variant="outline" size="lg" className="w-full gap-2" onClick={handleClick} loading={loading}>
        {!loading && <GoogleLogo className="w-5 h-5" />}
        Continue with Google
      </Button>
      <div className="flex items-center gap-3">
        <span className="h-px flex-1 bg-neutral-200" />
        <span className="text-xs text-neutral-400 uppercase tracking-wide">or</span>
        <span className="h-px flex-1 bg-neutral-200" />
      </div>
    </>
  );
}

function normalizePhone(value: string) {
  let number = value.replace(/[\s()\-]/g, '');
  if (number.startsWith('0')) number = `254${number.slice(1)}`;
  if (number.startsWith('+')) number = number.slice(1);
  return /^254[17]\d{8}$/.test(number) ? `+${number}` : null;
}

function authErrorMessage(error: unknown) {
  const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : '';
  if (code === 'auth/wrong-password' || code === 'auth/invalid-credential') return 'Incorrect email or password.';
  if (code === 'auth/email-already-in-use') return 'An account already exists for this email.';
  if (code === 'auth/weak-password') return 'Choose a stronger password with at least six characters.';
  if (code === 'auth/invalid-email') return 'Enter a valid email address.';
  if (error instanceof Error) return error.message;
  return 'We could not complete that request.';
}

export function Login() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const handleLogin = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError('');
    try {
      const { auth } = await getFirebase();
      await signInWithEmailAndPassword(auth, email.trim(), password);
      navigate('/dashboard');
    } catch (caughtError) {
      setError(authErrorMessage(caughtError));
    } finally {
      setLoading(false);
    }
  };

  const handleForgotPassword = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    setError('');
    setNotice('');
    if (!email.trim()) {
      setError('Enter your email address first, then select Forgot password.');
      return;
    }
    try {
      const { auth } = await getFirebase();
      await sendPasswordResetEmail(auth, email.trim());
      setNotice('Password reset instructions have been sent to your email.');
    } catch (caughtError) {
      setError(authErrorMessage(caughtError));
    }
  };

  return (
    <div className="min-h-[80vh] flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="w-12 h-12 bg-neutral-900 rounded-xl flex items-center justify-center mx-auto mb-4"><span className="text-white font-bold">H</span></div>
          <h1 className="text-2xl font-bold text-neutral-900">Welcome back</h1>
          <p className="text-sm text-neutral-500 mt-1">Sign in to your HerStep account</p>
        </div>
        <Card className="p-6">
          <div className="space-y-4 mb-4"><GoogleSignInButton /></div>
          <form onSubmit={handleLogin} className="space-y-4">
            {error && <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>}
            {notice && <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-sm text-emerald-700">{notice}</div>}
            <Input label="Email" type="email" value={email} onChange={event => setEmail(event.target.value)} placeholder="your@email.com" required />
            <div className="relative">
              <Input label="Password" type={showPass ? 'text' : 'password'} value={password} onChange={event => setPassword(event.target.value)} placeholder="Enter password" required />
              <button type="button" onClick={() => setShowPass(!showPass)} className="absolute right-3 top-9 text-neutral-400 hover:text-neutral-600">{showPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}</button>
            </div>
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-2 text-sm text-neutral-600"><input type="checkbox" className="rounded border-neutral-300" />Remember me</label>
              <button type="button" onClick={handleForgotPassword} className="text-sm text-neutral-600 hover:text-neutral-900">Forgot password?</button>
            </div>
            <Button type="submit" size="lg" className="w-full" loading={loading}>Sign In</Button>
          </form>
          <div className="mt-4 text-center"><p className="text-sm text-neutral-500">Don't have an account? <Link to="/register" className="text-neutral-900 font-medium hover:underline">Create account</Link></p></div>
        </Card>
      </div>
    </div>
  );
}

export function Register() {
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: '', email: '', phone: '', password: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleRegister = async (event: React.FormEvent) => {
    event.preventDefault();
    const phoneNumber = normalizePhone(form.phone);
    if (!phoneNumber) {
      setError('Enter a valid Kenyan phone number.');
      return;
    }

    setLoading(true);
    setError('');
    try {
      const { auth } = await getFirebase();
      await createUserWithEmailAndPassword(auth, form.email.trim(), form.password);
      await apiFetch('/api/auth/sync-profile', {
        method: 'POST',
        body: JSON.stringify({ displayName: form.name, phoneNumber }),
      });
      // Firebase's verification LINK is gone for good — the server now emails
      // a 6-digit code instead. Ask for it right away and land on /verify-email.
      // A failure here must not lose the sign-up: the page re-requests the
      // code on mount anyway.
      try {
        await apiFetch('/api/auth/verify/send', { method: 'POST', body: JSON.stringify({}) });
      } catch { /* VerifyEmail retries the send when it mounts */ }
      navigate('/verify-email', { replace: true });
    } catch (caughtError) {
      setError(authErrorMessage(caughtError));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-[80vh] flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="w-12 h-12 bg-neutral-900 rounded-xl flex items-center justify-center mx-auto mb-4"><span className="text-white font-bold">H</span></div>
          <h1 className="text-2xl font-bold text-neutral-900">Create account</h1>
          <p className="text-sm text-neutral-500 mt-1">Join HerStep Collection today</p>
        </div>
        <Card className="p-6">
          <div className="space-y-4 mb-4"><GoogleSignInButton /></div>
          <form onSubmit={handleRegister} className="space-y-4">
            {error && <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>}
            <Input label="Full Name" value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} placeholder="Your full name" required />
            <Input label="Email" type="email" value={form.email} onChange={event => setForm({ ...form, email: event.target.value })} placeholder="your@email.com" required />
            <Input label="Phone" value={form.phone} onChange={event => setForm({ ...form, phone: event.target.value })} placeholder="+254 7XX XXX XXX" required />
            <Input label="Password" type="password" value={form.password} onChange={event => setForm({ ...form, password: event.target.value })} placeholder="Create a password" required />
            <Button type="submit" size="lg" className="w-full" loading={loading}>Create Account</Button>
          </form>
          <div className="mt-4 text-center"><p className="text-sm text-neutral-500">Already have an account? <Link to="/login" className="text-neutral-900 font-medium hover:underline">Sign in</Link></p></div>
        </Card>
      </div>
    </div>
  );
}
