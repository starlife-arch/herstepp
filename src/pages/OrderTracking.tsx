import React, { useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { Search, Package, Check, Truck, Clock, MapPin, ChevronRight } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { Card, Button, Badge, Input, formatCurrency, formatDate, formatDateTime, getStatusBadge, EmptyState } from '../components/ui';

export default function OrderTracking() {
  const [searchParams] = useSearchParams();
  const { state } = useApp();
  const [searchId, setSearchId] = useState(searchParams.get('orderId') || '');
  const [searched, setSearched] = useState(!!searchParams.get('orderId'));

  const order = state.orders.find(o => o.orderId === searchId);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setSearched(true);
  };

  const statusSteps = [
    { status: 'pending', label: 'Order Placed', icon: Package },
    { status: 'processing', label: 'Processing', icon: Clock },
    { status: 'processed', label: 'Processed', icon: Check },
    { status: 'out_for_delivery', label: 'Out for Delivery', icon: Truck },
    { status: 'delivered', label: 'Delivered', icon: MapPin },
  ];

  const getStepIndex = (status: string) => statusSteps.findIndex(s => s.status === status);

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8 animate-fadeIn">
      <h1 className="text-2xl font-bold text-neutral-900 mb-2">Track Your Order</h1>
      <p className="text-neutral-500 text-sm mb-8">Enter your order ID to check the status of your order.</p>

      {/* Search */}
      <form onSubmit={handleSearch} className="mb-8">
        <div className="flex gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-400" />
            <input
              type="text"
              value={searchId}
              onChange={e => setSearchId(e.target.value)}
              placeholder="Enter order ID (e.g., HS-2026-000124)"
              className="w-full pl-10 pr-4 py-3 border border-neutral-300 rounded-xl text-sm focus:border-neutral-900"
            />
          </div>
          <Button type="submit">Track</Button>
        </div>
      </form>

      {/* Results */}
      {searched && !order && (
        <Card className="p-8">
          <EmptyState
            title="Order not found"
            description="We couldn't find an order with that ID. Please check and try again."
          />
        </Card>
      )}

      {order && (
        <div className="space-y-6 animate-fadeIn">
          {/* Order Header */}
          <Card className="p-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
              <div>
                <p className="text-sm text-neutral-500">Order ID</p>
                <p className="text-xl font-bold text-neutral-900">{order.orderId}</p>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={getStatusBadge(order.paymentStatus).variant}>Payment: {getStatusBadge(order.paymentStatus).label}</Badge>
                <Badge variant={getStatusBadge(order.orderStatus).variant}>{getStatusBadge(order.orderStatus).label}</Badge>
              </div>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
              <div>
                <p className="text-neutral-500">Date</p>
                <p className="font-medium">{formatDate(order.createdAt)}</p>
              </div>
              <div>
                <p className="text-neutral-500">Total</p>
                <p className="font-medium">{formatCurrency(order.total)}</p>
              </div>
              <div>
                <p className="text-neutral-500">Delivery</p>
                <p className="font-medium capitalize">{order.deliveryMethod}</p>
              </div>
              <div>
                <p className="text-neutral-500">Location</p>
                <p className="font-medium">{order.deliveryLocation}</p>
              </div>
            </div>
          </Card>

          {/* Timeline */}
          <Card className="p-6">
            <h3 className="font-semibold text-neutral-900 mb-6">Order Timeline</h3>
            <div className="relative">
              {statusSteps.map((step, i) => {
                const currentIdx = getStepIndex(order.orderStatus);
                const isCompleted = i <= currentIdx;
                const isCurrent = i === currentIdx;
                const historyEntry = order.statusHistory.find(h => h.newStatus === step.status);

                return (
                  <div key={step.status} className="flex gap-4 mb-6 last:mb-0">
                    <div className="flex flex-col items-center">
                      <div className={`w-10 h-10 rounded-full flex items-center justify-center ${isCompleted ? 'bg-neutral-900 text-white' : 'bg-neutral-100 text-neutral-400'}`}>
                        <step.icon className="w-4 h-4" />
                      </div>
                      {i < statusSteps.length - 1 && (
                        <div className={`w-0.5 h-8 mt-2 ${isCompleted && i < currentIdx ? 'bg-neutral-900' : 'bg-neutral-200'}`} />
                      )}
                    </div>
                    <div className="pt-2">
                      <p className={`font-medium text-sm ${isCompleted ? 'text-neutral-900' : 'text-neutral-400'}`}>{step.label}</p>
                      {historyEntry && (
                        <p className="text-xs text-neutral-500 mt-0.5">{formatDateTime(historyEntry.timestamp)}</p>
                      )}
                      {isCurrent && (
                        <p className="text-xs text-neutral-600 mt-0.5 font-medium">Current status</p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>

          {/* Order Items */}
          <Card className="p-6">
            <h3 className="font-semibold text-neutral-900 mb-4">Order Items</h3>
            <div className="space-y-3">
              {order.items.map((item, i) => (
                <div key={i} className="flex items-center gap-3 p-3 bg-neutral-50 rounded-lg">
                  <img src={item.productImage} alt="" className="w-12 h-12 rounded-lg object-cover" />
                  <div className="flex-1">
                    <p className="font-medium text-sm text-neutral-900">{item.productName}</p>
                    <p className="text-xs text-neutral-500">Size {item.size} | Qty {item.quantity}</p>
                  </div>
                  <span className="font-medium text-sm">{formatCurrency(item.total)}</span>
                </div>
              ))}
            </div>
            <div className="mt-4 pt-4 border-t border-neutral-200 space-y-2">
              <div className="flex justify-between text-sm"><span className="text-neutral-500">Subtotal</span><span>{formatCurrency(order.subtotal)}</span></div>
              <div className="flex justify-between text-sm"><span className="text-neutral-500">Delivery</span><span>{order.deliveryFee === 0 ? 'Free' : formatCurrency(order.deliveryFee)}</span></div>
              {order.discount > 0 && <div className="flex justify-between text-sm"><span className="text-neutral-500">Discount</span><span className="text-emerald-600">-{formatCurrency(order.discount)}</span></div>}
              <div className="flex justify-between font-semibold pt-2 border-t border-neutral-200"><span>Total</span><span>{formatCurrency(order.total)}</span></div>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
