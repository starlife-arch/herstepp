import React, { useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { LayoutDashboard, ShoppingBag, CreditCard, MessageSquare, Bell, User, LogOut, Package, FileText, ChevronRight } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { Card, Badge, Button, formatCurrency, formatDate, formatDateTime, getStatusBadge, EmptyState } from '../components/ui';

export default function CustomerDashboard() {
  const { state, dispatch, logout } = useApp();
  const navigate = useNavigate();
  const location = useLocation();
  const [activeTab, setActiveTab] = useState('overview');

  if (!state.user) {
    navigate('/login');
    return null;
  }

  const userOrders = state.orders.filter(o => o.customerId === state.user?.id || o.customerId === 'user-1');
  const pendingOrders = userOrders.filter(o => o.orderStatus === 'pending' || o.orderStatus === 'processing');
  const completedOrders = userOrders.filter(o => o.orderStatus === 'delivered');
  const unreadNotifs = state.notifications.filter(n => !n.read);

  const tabs = [
    { id: 'overview', label: 'Overview', icon: LayoutDashboard },
    { id: 'orders', label: 'My Orders', icon: Package },
    { id: 'payments', label: 'Payments', icon: CreditCard },
    { id: 'support', label: 'Support', icon: MessageSquare },
    { id: 'notifications', label: 'Notifications', icon: Bell },
    { id: 'profile', label: 'Profile', icon: User },
  ];

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 animate-fadeIn">
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Sidebar */}
        <aside className="lg:col-span-1">
          <Card className="p-4">
            <div className="flex items-center gap-3 p-3 mb-4 border-b border-neutral-100">
              <div className="w-10 h-10 bg-neutral-900 rounded-full flex items-center justify-center">
                <span className="text-white font-medium text-sm">{state.user.name.charAt(0)}</span>
              </div>
              <div>
                <p className="font-medium text-sm text-neutral-900">{state.user.name}</p>
                <p className="text-xs text-neutral-500">{state.user.email}</p>
              </div>
            </div>
            <nav className="space-y-1">
              {tabs.map(tab => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${activeTab === tab.id ? 'bg-neutral-100 text-neutral-900' : 'text-neutral-600 hover:bg-neutral-50'}`}
                >
                  <tab.icon className="w-4 h-4" />
                  {tab.label}
                  {tab.id === 'notifications' && unreadNotifs.length > 0 && (
                    <span className="ml-auto w-5 h-5 bg-red-500 text-white text-xs rounded-full flex items-center justify-center">{unreadNotifs.length}</span>
                  )}
                </button>
              ))}
              <hr className="my-2 border-neutral-100" />
              <button
                onClick={async () => { await logout(); navigate('/'); }}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-neutral-600 hover:bg-neutral-50"
              >
                <LogOut className="w-4 h-4" />
                Logout
              </button>
            </nav>
          </Card>
        </aside>

        {/* Content */}
        <main className="lg:col-span-3">
          {activeTab === 'overview' && <OverviewTab orders={userOrders} pendingOrders={pendingOrders} completedOrders={completedOrders} />}
          {activeTab === 'orders' && <OrdersTab orders={userOrders} />}
          {activeTab === 'payments' && <PaymentsTab orders={userOrders} />}
          {activeTab === 'support' && <SupportTab />}
          {activeTab === 'notifications' && <NotificationsTab />}
          {activeTab === 'profile' && <ProfileTab />}
        </main>
      </div>
    </div>
  );
}

function OverviewTab({ orders, pendingOrders, completedOrders }: any) {
  return (
    <div className="space-y-6">
      <h2 className="text-xl font-bold text-neutral-900">Dashboard Overview</h2>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <StatCard label="Total Orders" value={orders.length} />
        <StatCard label="Pending" value={pendingOrders.length} />
        <StatCard label="Completed" value={completedOrders.length} />
        <StatCard label="Total Spent" value={`KSh ${orders.reduce((s: number, o: any) => s + o.total, 0).toLocaleString()}`} />
      </div>
      <Card className="p-6">
        <h3 className="font-semibold text-neutral-900 mb-4">Recent Orders</h3>
        {orders.length === 0 ? (
          <EmptyState title="No orders yet" description="Your orders will appear here." action={<Link to="/shop"><Button size="sm">Start Shopping</Button></Link>} />
        ) : (
          <div className="space-y-3">
            {orders.slice(0, 5).map((order: any) => (
              <Link key={order.id} to={`/track?orderId=${order.orderId}`} className="flex items-center justify-between p-3 rounded-lg hover:bg-neutral-50 border border-neutral-100">
                <div>
                  <p className="font-medium text-sm text-neutral-900">{order.orderId}</p>
                  <p className="text-xs text-neutral-500">{formatDate(order.createdAt)}</p>
                </div>
                <div className="flex items-center gap-3">
                  <Badge variant={getStatusBadge(order.orderStatus).variant}>{getStatusBadge(order.orderStatus).label}</Badge>
                  <span className="font-medium text-sm">{formatCurrency(order.total)}</span>
                  <ChevronRight className="w-4 h-4 text-neutral-400" />
                </div>
              </Link>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function OrdersTab({ orders }: any) {
  return (
    <div className="space-y-6">
      <h2 className="text-xl font-bold text-neutral-900">My Orders</h2>
      {orders.length === 0 ? (
        <Card className="p-8"><EmptyState title="No orders yet" description="Your order history will appear here." /></Card>
      ) : (
        <div className="space-y-4">
          {orders.map((order: any) => (
            <Card key={order.id} className="p-5">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
                <div>
                  <p className="font-semibold text-neutral-900">{order.orderId}</p>
                  <p className="text-xs text-neutral-500">{formatDate(order.createdAt)}</p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={getStatusBadge(order.paymentStatus).variant}>{getStatusBadge(order.paymentStatus).label}</Badge>
                  <Badge variant={getStatusBadge(order.orderStatus).variant}>{getStatusBadge(order.orderStatus).label}</Badge>
                </div>
              </div>
              <div className="space-y-2 mb-4">
                {order.items.map((item: any, i: number) => (
                  <div key={i} className="flex items-center gap-3">
                    <img src={item.productImage} alt="" className="w-10 h-10 rounded-lg object-cover bg-neutral-100" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-neutral-900 truncate">{item.productName}</p>
                      <p className="text-xs text-neutral-500">Size {item.size} x {item.quantity}</p>
                    </div>
                    <span className="text-sm font-medium">{formatCurrency(item.total)}</span>
                  </div>
                ))}
              </div>
              <div className="flex items-center justify-between pt-3 border-t border-neutral-100">
                <span className="text-sm text-neutral-500">Total: <span className="font-semibold text-neutral-900">{formatCurrency(order.total)}</span></span>
                <Link to={`/track?orderId=${order.orderId}`} className="text-sm font-medium text-neutral-700 hover:text-neutral-900">Track Order</Link>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function PaymentsTab({ orders }: any) {
  const paidOrders = orders.filter((o: any) => o.paymentStatus === 'paid');
  return (
    <div className="space-y-6">
      <h2 className="text-xl font-bold text-neutral-900">Payment History</h2>
      {paidOrders.length === 0 ? (
        <Card className="p-8"><EmptyState title="No payments yet" description="Your payment history will appear here." /></Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-neutral-50 border-b border-neutral-200">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-neutral-600">Order</th>
                  <th className="text-left px-4 py-3 font-medium text-neutral-600">Amount</th>
                  <th className="text-left px-4 py-3 font-medium text-neutral-600">Method</th>
                  <th className="text-left px-4 py-3 font-medium text-neutral-600">Status</th>
                  <th className="text-left px-4 py-3 font-medium text-neutral-600">Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {paidOrders.map((order: any) => (
                  <tr key={order.id} className="hover:bg-neutral-50">
                    <td className="px-4 py-3 font-medium">{order.orderId}</td>
                    <td className="px-4 py-3">{formatCurrency(order.total)}</td>
                    <td className="px-4 py-3 text-neutral-500">M-Pesa</td>
                    <td className="px-4 py-3"><Badge variant="success">Paid</Badge></td>
                    <td className="px-4 py-3 text-neutral-500">{formatDate(order.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

function SupportTab() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-neutral-900">Support Tickets</h2>
        <Link to="/support"><Button size="sm">New Ticket</Button></Link>
      </div>
      <Card className="p-6">
        <p className="text-sm text-neutral-500 mb-4">Your support tickets and conversations.</p>
        <Link to="/support" className="text-sm font-medium text-neutral-700 hover:text-neutral-900">View all tickets</Link>
      </Card>
    </div>
  );
}

function NotificationsTab() {
  const { state, dispatch, logout } = useApp();
  return (
    <div className="space-y-6">
      <h2 className="text-xl font-bold text-neutral-900">Notifications</h2>
      {state.notifications.length === 0 ? (
        <Card className="p-8"><EmptyState title="No notifications" description="You're all caught up." /></Card>
      ) : (
        <div className="space-y-2">
          {state.notifications.map(n => (
            <Card key={n.id} className={`p-4 ${!n.read ? 'border-neutral-900 bg-neutral-50' : ''}`}>
              <div className="flex items-start justify-between">
                <div>
                  <p className="font-medium text-sm text-neutral-900">{n.title}</p>
                  <p className="text-xs text-neutral-500 mt-0.5">{n.message}</p>
                  <p className="text-xs text-neutral-400 mt-1">{formatDateTime(n.createdAt)}</p>
                </div>
                {!n.read && <button onClick={() => dispatch({ type: 'MARK_NOTIFICATION_READ', payload: n.id })} className="text-xs text-neutral-500 hover:text-neutral-900">Mark read</button>}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function ProfileTab() {
  const { state } = useApp();
  return (
    <div className="space-y-6">
      <h2 className="text-xl font-bold text-neutral-900">Profile</h2>
      <Card className="p-6">
        <div className="flex items-center gap-4 mb-6">
          <div className="w-16 h-16 bg-neutral-900 rounded-full flex items-center justify-center">
            <span className="text-white font-bold text-xl">{state.user?.name.charAt(0)}</span>
          </div>
          <div>
            <p className="font-semibold text-neutral-900">{state.user?.name}</p>
            <p className="text-sm text-neutral-500">{state.user?.email}</p>
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="p-4 bg-neutral-50 rounded-lg">
            <p className="text-xs text-neutral-500 mb-1">Phone</p>
            <p className="text-sm font-medium text-neutral-900">{state.user?.phone}</p>
          </div>
          <div className="p-4 bg-neutral-50 rounded-lg">
            <p className="text-xs text-neutral-500 mb-1">Member Since</p>
            <p className="text-sm font-medium text-neutral-900">{formatDate(state.user?.createdAt || '')}</p>
          </div>
          <div className="p-4 bg-neutral-50 rounded-lg">
            <p className="text-xs text-neutral-500 mb-1">Account Type</p>
            <p className="text-sm font-medium text-neutral-900 capitalize">{state.user?.role}</p>
          </div>
        </div>
        <Button variant="outline" className="mt-6">Edit Profile</Button>
      </Card>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <Card className="p-4">
      <p className="text-xs text-neutral-500 mb-1">{label}</p>
      <p className="text-xl font-bold text-neutral-900">{value}</p>
    </Card>
  );
}
