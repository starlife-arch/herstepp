import React, { useEffect, useState } from 'react';
import { X, Check, AlertCircle, Info, Loader2 } from 'lucide-react';

// Button Component
export function Button({
  children, variant = 'primary', size = 'md', loading = false, disabled = false, className = '', ...props
}: {
  children: React.ReactNode;
  variant?: 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  disabled?: boolean;
  className?: string;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const base = 'inline-flex items-center justify-center font-medium rounded-lg transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed';
  const sizes = { sm: 'px-3 py-1.5 text-sm', md: 'px-4 py-2.5 text-sm', lg: 'px-6 py-3 text-base' };
  const variants = {
    primary: 'bg-neutral-900 text-white hover:bg-neutral-800 active:bg-neutral-950',
    secondary: 'bg-neutral-100 text-neutral-900 hover:bg-neutral-200',
    outline: 'border border-neutral-300 text-neutral-700 hover:bg-neutral-50',
    ghost: 'text-neutral-600 hover:bg-neutral-100',
    danger: 'bg-red-600 text-white hover:bg-red-700',
  };
  return (
    <button className={`${base} ${sizes[size]} ${variants[variant]} ${className}`} disabled={disabled || loading} {...props}>
      {loading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
      {children}
    </button>
  );
}

// Input Component
export function Input({
  label, error, className = '', ...props
}: {
  label?: string;
  error?: string;
  className?: string;
} & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="space-y-1.5">
      {label && <label className="block text-sm font-medium text-neutral-700">{label}</label>}
      <input
        className={`w-full px-3.5 py-2.5 border border-neutral-300 rounded-lg text-sm transition-colors focus:border-neutral-900 focus:ring-0 ${error ? 'border-red-400' : ''} ${className}`}
        {...props}
      />
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}

// Select Component
export function Select({
  label, options, error, className = '', ...props
}: {
  label?: string;
  options: { value: string; label: string }[];
  error?: string;
  className?: string;
} & React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="space-y-1.5">
      {label && <label className="block text-sm font-medium text-neutral-700">{label}</label>}
      <select
        className={`w-full px-3.5 py-2.5 border border-neutral-300 rounded-lg text-sm bg-white transition-colors focus:border-neutral-900 ${className}`}
        {...props}
      >
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}

// Badge Component
export function Badge({ children, variant = 'default' }: { children: React.ReactNode; variant?: 'default' | 'success' | 'warning' | 'danger' | 'info' }) {
  const variants = {
    default: 'bg-neutral-100 text-neutral-700',
    success: 'bg-emerald-50 text-emerald-700',
    warning: 'bg-amber-50 text-amber-700',
    danger: 'bg-red-50 text-red-700',
    info: 'bg-blue-50 text-blue-700',
  };
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${variants[variant]}`}>
      {children}
    </span>
  );
}

// Card Component
export function Card({ children, className = '', hover = false }: { children: React.ReactNode; className?: string; hover?: boolean }) {
  return (
    <div className={`bg-white border border-neutral-200 rounded-xl ${hover ? 'hover:shadow-md hover:border-neutral-300 transition-all duration-200 cursor-pointer' : ''} ${className}`}>
      {children}
    </div>
  );
}

// Modal Component
export function Modal({ isOpen, onClose, title, children, size = 'md' }: {
  isOpen: boolean; onClose: () => void; title?: string; children: React.ReactNode; size?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
}) {
  useEffect(() => {
    if (isOpen) document.body.style.overflow = 'hidden';
    else document.body.style.overflow = '';
    return () => { document.body.style.overflow = ''; };
  }, [isOpen]);

  if (!isOpen) return null;
  const sizes = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl', full: 'max-w-full mx-4' };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className={`relative bg-white rounded-2xl shadow-xl w-full ${sizes[size]} max-h-[90vh] overflow-hidden animate-fadeIn`}>
        {title && (
          <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-200">
            <h3 className="text-lg font-semibold text-neutral-900">{title}</h3>
            <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-neutral-100 transition-colors">
              <X className="w-5 h-5 text-neutral-500" />
            </button>
          </div>
        )}
        <div className="overflow-y-auto max-h-[calc(90vh-80px)] p-6">{children}</div>
      </div>
    </div>
  );
}

// Toast Component
export function Toast({ message, type, onClose }: { message: string; type: 'success' | 'error' | 'info'; onClose: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onClose, 4000);
    return () => clearTimeout(timer);
  }, [onClose]);

  const icons = { success: <Check className="w-5 h-5" />, error: <AlertCircle className="w-5 h-5" />, info: <Info className="w-5 h-5" /> };
  const colors = { success: 'bg-emerald-50 border-emerald-200 text-emerald-800', error: 'bg-red-50 border-red-200 text-red-800', info: 'bg-blue-50 border-blue-200 text-blue-800' };

  return (
    <div className={`fixed top-4 right-4 z-[100] flex items-center gap-3 px-4 py-3 rounded-xl border shadow-lg toast-enter ${colors[type]}`}>
      {icons[type]}
      <span className="text-sm font-medium">{message}</span>
      <button onClick={onClose} className="ml-2 p-1 rounded hover:bg-black/5"><X className="w-4 h-4" /></button>
    </div>
  );
}

// Skeleton Loader
export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`skeleton rounded-lg ${className}`} />;
}

// Empty State
export function EmptyState({ title, description, action }: { title: string; description: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
      <div className="w-16 h-16 bg-neutral-100 rounded-2xl flex items-center justify-center mb-4">
        <Info className="w-8 h-8 text-neutral-400" />
      </div>
      <h3 className="text-lg font-semibold text-neutral-900 mb-1">{title}</h3>
      <p className="text-sm text-neutral-500 max-w-sm mb-4">{description}</p>
      {action}
    </div>
  );
}

// Pagination
export function Pagination({ page, totalPages, onPageChange }: { page: number; totalPages: number; onPageChange: (p: number) => void }) {
  if (totalPages <= 1) return null;
  return (
    <div className="flex items-center justify-center gap-2 mt-6">
      <button onClick={() => onPageChange(page - 1)} disabled={page === 1} className="px-3 py-1.5 text-sm border border-neutral-200 rounded-lg disabled:opacity-50 hover:bg-neutral-50">
        Previous
      </button>
      <span className="text-sm text-neutral-600">Page {page} of {totalPages}</span>
      <button onClick={() => onPageChange(page + 1)} disabled={page === totalPages} className="px-3 py-1.5 text-sm border border-neutral-200 rounded-lg disabled:opacity-50 hover:bg-neutral-50">
        Next
      </button>
    </div>
  );
}

// Status Badge helper. The API stores statuses in UPPERCASE (PENDING, PAID, OUT_FOR_DELIVERY…);
// we normalise before lookup so both cases render a friendly label.
export function getStatusBadge(status?: string | null): { label: string; variant: 'default' | 'success' | 'warning' | 'danger' | 'info' } {
  const map: Record<string, { label: string; variant: 'default' | 'success' | 'warning' | 'danger' | 'info' }> = {
    PENDING: { label: 'Pending', variant: 'warning' },
    PROCESSING: { label: 'Processing', variant: 'info' },
    PROCESSED: { label: 'Processed', variant: 'info' },
    OUT_FOR_DELIVERY: { label: 'Out for Delivery', variant: 'info' },
    DELIVERED: { label: 'Delivered', variant: 'success' },
    CANCELLED: { label: 'Cancelled', variant: 'danger' },
    PAID: { label: 'Paid', variant: 'success' },
    FAILED: { label: 'Failed', variant: 'danger' },
    TIMEOUT: { label: 'Timeout', variant: 'warning' },
    REFUNDED: { label: 'Refunded', variant: 'warning' },
    DRAFT: { label: 'Draft', variant: 'default' },
    ACTIVE: { label: 'Active', variant: 'success' },
    ARCHIVED: { label: 'Archived', variant: 'default' },
    OPEN: { label: 'Open', variant: 'warning' },
    IN_PROGRESS: { label: 'In Progress', variant: 'info' },
    WAITING_CUSTOMER: { label: 'Waiting', variant: 'warning' },
    RESOLVED: { label: 'Resolved', variant: 'success' },
    CLOSED: { label: 'Closed', variant: 'default' },
  };
  const key = String(status ?? '').toUpperCase();
  return map[key] || { label: key || 'Unknown', variant: 'default' };
}

// Format currency
export function formatCurrency(amount: number): string {
  return `KSh ${amount.toLocaleString()}`;
}

// Format date
export function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatDateTime(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
