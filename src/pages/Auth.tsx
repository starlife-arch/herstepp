import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Eye, EyeOff } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { Button, Input, Card } from '../components/ui';

export function Login() {
  const { dispatch } = useApp();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    setTimeout(() => {
      dispatch({
        type: 'SET_USER',
        payload: {
          id: 'user-1',
          name: 'Jane Wanjiku',
          email: email || 'jane@example.com',
          phone: '+254712345678',
          role: 'customer',
          createdAt: '2026-01-01T00:00:00Z',
        },
      });
      setLoading(false);
      navigate('/dashboard');
    }, 1000);
  };

  return (
    <div className="min-h-[80vh] flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="w-12 h-12 bg-neutral-900 rounded-xl flex items-center justify-center mx-auto mb-4">
            <span className="text-white font-bold">H</span>
          </div>
          <h1 className="text-2xl font-bold text-neutral-900">Welcome back</h1>
          <p className="text-sm text-neutral-500 mt-1">Sign in to your HerStep account</p>
        </div>

        <Card className="p-6">
          <form onSubmit={handleLogin} className="space-y-4">
            {error && <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>}
            <Input label="Email" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="your@email.com" required />
            <div className="relative">
              <Input label="Password" type={showPass ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} placeholder="Enter password" required />
              <button type="button" onClick={() => setShowPass(!showPass)} className="absolute right-3 top-9 text-neutral-400 hover:text-neutral-600">
                {showPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-2 text-sm text-neutral-600">
                <input type="checkbox" className="rounded border-neutral-300" />
                Remember me
              </label>
              <a href="#" className="text-sm text-neutral-600 hover:text-neutral-900">Forgot password?</a>
            </div>
            <Button type="submit" size="lg" className="w-full" loading={loading}>
              Sign In
            </Button>
          </form>

          <div className="mt-4 text-center">
            <p className="text-sm text-neutral-500">
              Don't have an account?{' '}
              <Link to="/register" className="text-neutral-900 font-medium hover:underline">Create account</Link>
            </p>
          </div>
        </Card>

        {/* Demo Access */}
        <div className="mt-4 text-center">
          <button
            onClick={() => {
              dispatch({ type: 'SET_USER', payload: { id: 'admin-1', name: 'Admin User', email: 'admin@herstep.com', phone: '+254799021089', role: 'super_admin', createdAt: '2026-01-01T00:00:00Z' } });
              navigate('/admin');
            }}
            className="text-xs text-neutral-400 hover:text-neutral-600"
          >
            Admin Demo Access
          </button>
        </div>
      </div>
    </div>
  );
}

export function Register() {
  const { dispatch } = useApp();
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: '', email: '', phone: '', password: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleRegister = (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setTimeout(() => {
      dispatch({
        type: 'SET_USER',
        payload: {
          id: 'user-new',
          name: form.name,
          email: form.email,
          phone: form.phone,
          role: 'customer',
          createdAt: new Date().toISOString(),
        },
      });
      setLoading(false);
      navigate('/dashboard');
    }, 1000);
  };

  return (
    <div className="min-h-[80vh] flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="w-12 h-12 bg-neutral-900 rounded-xl flex items-center justify-center mx-auto mb-4">
            <span className="text-white font-bold">H</span>
          </div>
          <h1 className="text-2xl font-bold text-neutral-900">Create account</h1>
          <p className="text-sm text-neutral-500 mt-1">Join HerStep Collection today</p>
        </div>

        <Card className="p-6">
          <form onSubmit={handleRegister} className="space-y-4">
            {error && <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>}
            <Input label="Full Name" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Your full name" required />
            <Input label="Email" type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} placeholder="your@email.com" required />
            <Input label="Phone" value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} placeholder="+254 7XX XXX XXX" required />
            <Input label="Password" type="password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} placeholder="Create a password" required />
            <Button type="submit" size="lg" className="w-full" loading={loading}>
              Create Account
            </Button>
          </form>
          <div className="mt-4 text-center">
            <p className="text-sm text-neutral-500">
              Already have an account?{' '}
              <Link to="/login" className="text-neutral-900 font-medium hover:underline">Sign in</Link>
            </p>
          </div>
        </Card>
      </div>
    </div>
  );
}
