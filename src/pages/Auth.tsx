import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Eye, EyeOff } from 'lucide-react';
import {
  createUserWithEmailAndPassword,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
} from 'firebase/auth';
import { apiFetch } from '../lib/api';
import { getFirebase } from '../lib/firebase';
import { Button, Input, Card } from '../components/ui';

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
  const [form, setForm] = useState({ name: '', email: '', phone: '', password: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [verificationSent, setVerificationSent] = useState(false);

  const resendVerification = async () => {
    try {
      const { auth } = await getFirebase();
      if (!auth.currentUser) throw new Error('Sign in again to resend your verification email.');
      await sendEmailVerification(auth.currentUser);
      setVerificationSent(true);
    } catch (caughtError) {
      setError(authErrorMessage(caughtError));
    }
  };

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
      const credential = await createUserWithEmailAndPassword(auth, form.email.trim(), form.password);
      await apiFetch('/api/auth/sync-profile', {
        method: 'POST',
        body: JSON.stringify({ displayName: form.name, phoneNumber }),
      });
      await sendEmailVerification(credential.user);
      setVerificationSent(true);
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
          <form onSubmit={handleRegister} className="space-y-4">
            {error && <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>}
            {verificationSent && <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-800">Verify your email before checkout. Check your inbox, then <button type="button" onClick={resendVerification} className="font-medium underline">resend the verification email</button>.</div>}
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
