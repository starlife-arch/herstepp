import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { LayoutDashboard, ShoppingBag, Package, Users, CreditCard, MessageSquare, Tag, Bell, Settings, LogOut, TrendingUp, AlertTriangle, ChevronRight, Search, Filter } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { products } from '../data/mockData';
import { Card, Badge, Button, formatCurrency, formatDate, formatDateTime, getStatusBadge, EmptyState, Input } from '../components/ui';

export default function AdminDashboard() {
  const { state, dispatch } = useApp();
  const navigate = useNavigate();
  const [activeSection, setActiveSection] = useState('overview');

  if (!state.user || state.user.role === 'customer') {
    navigate('/login');
    return null;
  }

  const navItems = [
    { id: 'overview', label: 'Overview', icon: LayoutDashboard },
    { id: 'orders', label: 'Orders', icon: ShoppingBag },
    { id: 'products', label: 'Products', icon: Package },
    { id: 'customers', label: 'Customers', icon: Users },
    { id: 'payments', label: 'Payments', icon: CreditCard },
    { id: 'support', label: 'Support', icon: MessageSquare },
    { id: 'promotions', label: 'Promotions', icon: Tag },
    { id: 'notifications', label: 'Notifications', icon: Bell },
    { id: 'settings', label: 'Settings', icon: Settings },
  ];

  return (
    <div className="min-h-screen bg-neutral-50 flex">
      {/* Sidebar */}
      <aside className="hidden lg:flex flex-col w-64 bg-white border-r border-neutral-200 fixed h-full">
        <div className="p-5 border-b border-neutral-200">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-neutral-900 rounded-lg flex items-center justify-center">
              <span className="text-white font-bold text-sm">H</span>
            </div>
            <div>
              <span className="font-semibold text-neutral-900">HerStep</span>
              <span className="text-neutral-400 text-xs block -mt-0.5">Admin Panel</span>
            </div>
          </div>
        </div>
        <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
          {navItems.map(item => (
            <button
              key={item.id}
              onClick={() => setActiveSection(item.id)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${activeSection === item.id ? 'bg-neutral-100 text-neutral-900' : 'text-neutral-600 hover:bg-neutral-50'}`}
            >
              <item.icon className="w-4 h-4" />
              {item.label}
            </button>
          ))}
        </nav>
        <div className="p-3 border-t border-neutral-200">
          <button
            onClick={() => { dispatch({ type: 'SET_USER', payload: null }); navigate('/'); }}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-neutral-600 hover:bg-neutral-50"
          >
            <LogOut className="w-4 h-4" />
            Logout
          </button>
        </div>
      </aside>

      {/* Mobile Header */}
      <div className="lg:hidden fixed top-0 left-0 right-0 z-40 bg-white border-b border-neutral-200 px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 bg-neutral-900 rounded-lg flex items-center justify-center">
              <span className="text-white font-bold text-xs">H</span>
            </div>
            <span className="font-semibold text-sm">Admin</span>
          </div>
          <select value={activeSection} onChange={e => setActiveSection(e.target.value)} className="text-sm border border-neutral-200 rounded-lg px-2 py-1.5">
            {navItems.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </div>
      </div>

      {/* Main Content */}
      <main className="flex-1 lg:ml-64 pt-16 lg:pt-0">
        <div className="p-4 sm:p-6 lg:p-8">
          {activeSection === 'overview' && <AdminOverview orders={state.orders} />}
          {activeSection === 'orders' && <AdminOrders orders={state.orders} />}
          {activeSection === 'products' && <AdminProducts />}
          {activeSection === 'customers' && <AdminCustomers />}
          {activeSection === 'payments' && <AdminPayments orders={state.orders} />}
          {activeSection === 'support' && <AdminSupport tickets={state.tickets} />}
          {activeSection === 'promotions' && <AdminPromotions />}
          {activeSection === 'notifications' && <AdminNotifications />}
          {activeSection === 'settings' && <AdminSettings />}
        </div>
      </main>
    </div>
  );
}

function AdminOverview({ orders }: { orders: any[] }) {
  const todaySales = orders.filter(o => o.paymentStatus === 'paid').reduce((s, o) => s + o.total, 0);
  const pendingOrders = orders.filter(o => o.orderStatus === 'pending').length;
  const processingOrders = orders.filter(o => o.orderStatus === 'processing').length;

  return (
    <div className="space-y-6 animate-fadeIn">
      <div>
        <h1 className="text-2xl font-bold text-neutral-900">Dashboard</h1>
        <p className="text-sm text-neutral-500">Welcome back. Here's what's happening today.</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard title="Today's Sales" value={formatCurrency(todaySales)} icon={TrendingUp} trend="+12%" />
        <StatCard title="Total Orders" value={orders.length.toString()} icon={ShoppingBag} />
        <StatCard title="Pending" value={pendingOrders.toString()} icon={AlertTriangle} variant="warning" />
        <StatCard title="Processing" value={processingOrders.toString()} icon={Package} variant="info" />
      </div>

      {/* Recent Orders */}
      <Card className="p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-neutral-900">Recent Orders</h3>
          <Link to="#" className="text-sm text-neutral-600 hover:text-neutral-900">View all</Link>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-neutral-200">
              <tr>
                <th className="text-left py-3 px-2 font-medium text-neutral-600">Order</th>
                <th className="text-left py-3 px-2 font-medium text-neutral-600">Customer</th>
                <th className="text-left py-3 px-2 font-medium text-neutral-600 hidden sm:table-cell">Date</th>
                <th className="text-left py-3 px-2 font-medium text-neutral-600">Amount</th>
                <th className="text-left py-3 px-2 font-medium text-neutral-600">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {orders.slice(0, 5).map(order => (
                <tr key={order.id} className="hover:bg-neutral-50">
                  <td className="py-3 px-2 font-medium">{order.orderId}</td>
                  <td className="py-3 px-2 text-neutral-600">{order.customerName}</td>
                  <td className="py-3 px-2 text-neutral-500 hidden sm:table-cell">{formatDate(order.createdAt)}</td>
                  <td className="py-3 px-2">{formatCurrency(order.total)}</td>
                  <td className="py-3 px-2"><Badge variant={getStatusBadge(order.orderStatus).variant}>{getStatusBadge(order.orderStatus).label}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Low Stock Alert */}
      <Card className="p-6">
        <h3 className="font-semibold text-neutral-900 mb-4">Low Stock Alerts</h3>
        <div className="space-y-3">
          {products.filter(p => p.sizes.some(s => s.quantity <= 1 && s.quantity > 0)).slice(0, 4).map(p => (
            <div key={p.id} className="flex items-center justify-between p-3 bg-amber-50 rounded-lg">
              <div>
                <p className="text-sm font-medium text-neutral-900">{p.name}</p>
                <p className="text-xs text-neutral-500">{p.sku}</p>
              </div>
              <Badge variant="warning">Low Stock</Badge>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

function AdminOrders({ orders }: { orders: any[] }) {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const filtered = orders.filter(o => {
    if (search && !o.orderId.toLowerCase().includes(search.toLowerCase()) && !o.customerName.toLowerCase().includes(search.toLowerCase())) return false;
    if (statusFilter && o.orderStatus !== statusFilter) return false;
    return true;
  });

  return (
    <div className="space-y-6 animate-fadeIn">
      <h1 className="text-2xl font-bold text-neutral-900">Orders</h1>

      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-400" />
          <input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search orders..." className="w-full pl-10 pr-4 py-2.5 border border-neutral-300 rounded-lg text-sm" />
        </div>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className="px-3 py-2.5 border border-neutral-300 rounded-lg text-sm bg-white">
          <option value="">All Status</option>
          <option value="pending">Pending</option>
          <option value="processing">Processing</option>
          <option value="processed">Processed</option>
          <option value="out_for_delivery">Out for Delivery</option>
          <option value="delivered">Delivered</option>
          <option value="cancelled">Cancelled</option>
        </select>
      </div>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 border-b border-neutral-200">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-neutral-600">Order ID</th>
                <th className="text-left px-4 py-3 font-medium text-neutral-600">Customer</th>
                <th className="text-left px-4 py-3 font-medium text-neutral-600 hidden md:table-cell">Date</th>
                <th className="text-left px-4 py-3 font-medium text-neutral-600">Amount</th>
                <th className="text-left px-4 py-3 font-medium text-neutral-600">Payment</th>
                <th className="text-left px-4 py-3 font-medium text-neutral-600">Status</th>
                <th className="text-left px-4 py-3 font-medium text-neutral-600">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {filtered.map(order => (
                <tr key={order.id} className="hover:bg-neutral-50">
                  <td className="px-4 py-3 font-medium">{order.orderId}</td>
                  <td className="px-4 py-3">
                    <p className="text-neutral-900">{order.customerName}</p>
                    <p className="text-xs text-neutral-500">{order.customerPhone}</p>
                  </td>
                  <td className="px-4 py-3 text-neutral-500 hidden md:table-cell">{formatDate(order.createdAt)}</td>
                  <td className="px-4 py-3 font-medium">{formatCurrency(order.total)}</td>
                  <td className="px-4 py-3"><Badge variant={getStatusBadge(order.paymentStatus).variant}>{getStatusBadge(order.paymentStatus).label}</Badge></td>
                  <td className="px-4 py-3"><Badge variant={getStatusBadge(order.orderStatus).variant}>{getStatusBadge(order.orderStatus).label}</Badge></td>
                  <td className="px-4 py-3">
                    <button className="text-sm text-neutral-600 hover:text-neutral-900 font-medium">View</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function AdminProducts() {
  return (
    <div className="space-y-6 animate-fadeIn">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-neutral-900">Products</h1>
        <Button>Add Product</Button>
      </div>
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 border-b border-neutral-200">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-neutral-600">Product</th>
                <th className="text-left px-4 py-3 font-medium text-neutral-600 hidden sm:table-cell">SKU</th>
                <th className="text-left px-4 py-3 font-medium text-neutral-600">Category</th>
                <th className="text-left px-4 py-3 font-medium text-neutral-600">Price</th>
                <th className="text-left px-4 py-3 font-medium text-neutral-600 hidden md:table-cell">Stock</th>
                <th className="text-left px-4 py-3 font-medium text-neutral-600">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {products.map(p => {
                const totalStock = p.sizes.reduce((s, sz) => s + sz.quantity, 0);
                return (
                  <tr key={p.id} className="hover:bg-neutral-50">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <img src={p.images[0]} alt="" className="w-10 h-10 rounded-lg object-cover bg-neutral-100" />
                        <div>
                          <p className="font-medium text-neutral-900">{p.name}</p>
                          <div className="flex gap-1 mt-0.5">
                            {p.isFeatured && <span className="text-xs text-neutral-500">Featured</span>}
                            {p.isBestseller && <span className="text-xs text-neutral-500">Bestseller</span>}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-neutral-500 font-mono text-xs hidden sm:table-cell">{p.sku}</td>
                    <td className="px-4 py-3 text-neutral-600">{p.category}</td>
                    <td className="px-4 py-3">
                      {p.salePrice ? (
                        <div>
                          <span className="font-medium">{formatCurrency(p.salePrice)}</span>
                          <span className="text-xs text-neutral-400 line-through ml-1">{formatCurrency(p.price)}</span>
                        </div>
                      ) : formatCurrency(p.price)}
                    </td>
                    <td className="px-4 py-3 hidden md:table-cell">
                      <span className={totalStock <= 3 ? 'text-amber-600 font-medium' : 'text-neutral-900'}>{totalStock}</span>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={p.status === 'active' ? 'success' : 'default'}>{p.status}</Badge>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function AdminCustomers() {
  const customers = [
    { id: 'user-1', name: 'Jane Wanjiku', email: 'jane@example.com', phone: '+254712345678', orders: 5, totalSpent: 4500, joined: '2026-01-15' },
    { id: 'user-2', name: 'Mary Akinyi', email: 'mary@example.com', phone: '+254723456789', orders: 3, totalSpent: 2800, joined: '2026-02-01' },
    { id: 'user-3', name: 'Grace Muthoni', email: 'grace@example.com', phone: '+254734567890', orders: 8, totalSpent: 7200, joined: '2026-01-05' },
  ];

  return (
    <div className="space-y-6 animate-fadeIn">
      <h1 className="text-2xl font-bold text-neutral-900">Customers</h1>
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 border-b border-neutral-200">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-neutral-600">Customer</th>
                <th className="text-left px-4 py-3 font-medium text-neutral-600 hidden sm:table-cell">Phone</th>
                <th className="text-left px-4 py-3 font-medium text-neutral-600">Orders</th>
                <th className="text-left px-4 py-3 font-medium text-neutral-600">Total Spent</th>
                <th className="text-left px-4 py-3 font-medium text-neutral-600 hidden md:table-cell">Joined</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {customers.map(c => (
                <tr key={c.id} className="hover:bg-neutral-50">
                  <td className="px-4 py-3">
                    <p className="font-medium text-neutral-900">{c.name}</p>
                    <p className="text-xs text-neutral-500">{c.email}</p>
                  </td>
                  <td className="px-4 py-3 text-neutral-600 hidden sm:table-cell">{c.phone}</td>
                  <td className="px-4 py-3">{c.orders}</td>
                  <td className="px-4 py-3 font-medium">{formatCurrency(c.totalSpent)}</td>
                  <td className="px-4 py-3 text-neutral-500 hidden md:table-cell">{formatDate(c.joined)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function AdminPayments({ orders }: { orders: any[] }) {
  return (
    <div className="space-y-6 animate-fadeIn">
      <h1 className="text-2xl font-bold text-neutral-900">Payments</h1>
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 border-b border-neutral-200">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-neutral-600">Order</th>
                <th className="text-left px-4 py-3 font-medium text-neutral-600">Customer</th>
                <th className="text-left px-4 py-3 font-medium text-neutral-600">Amount</th>
                <th className="text-left px-4 py-3 font-medium text-neutral-600">Method</th>
                <th className="text-left px-4 py-3 font-medium text-neutral-600">Status</th>
                <th className="text-left px-4 py-3 font-medium text-neutral-600 hidden sm:table-cell">Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {orders.map(order => (
                <tr key={order.id} className="hover:bg-neutral-50">
                  <td className="px-4 py-3 font-medium">{order.orderId}</td>
                  <td className="px-4 py-3 text-neutral-600">{order.customerName}</td>
                  <td className="px-4 py-3 font-medium">{formatCurrency(order.total)}</td>
                  <td className="px-4 py-3 text-neutral-500">M-Pesa</td>
                  <td className="px-4 py-3"><Badge variant={getStatusBadge(order.paymentStatus).variant}>{getStatusBadge(order.paymentStatus).label}</Badge></td>
                  <td className="px-4 py-3 text-neutral-500 hidden sm:table-cell">{formatDate(order.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function AdminSupport({ tickets }: { tickets: any[] }) {
  return (
    <div className="space-y-6 animate-fadeIn">
      <h1 className="text-2xl font-bold text-neutral-900">Support Tickets</h1>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
        <StatCard title="Open" value={tickets.filter(t => t.status === 'open').length.toString()} />
        <StatCard title="In Progress" value={tickets.filter(t => t.status === 'in_progress').length.toString()} />
        <StatCard title="Resolved" value={tickets.filter(t => t.status === 'resolved').length.toString()} />
        <StatCard title="Closed" value={tickets.filter(t => t.status === 'closed').length.toString()} />
      </div>
      <div className="space-y-3">
        {tickets.map(ticket => (
          <Card key={ticket.id} className="p-4">
            <div className="flex items-start justify-between">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs font-mono text-neutral-500">{ticket.ticketId}</span>
                  <Badge variant={getStatusBadge(ticket.status).variant}>{getStatusBadge(ticket.status).label}</Badge>
                </div>
                <p className="font-medium text-sm text-neutral-900">{ticket.subject}</p>
                <p className="text-xs text-neutral-500 mt-1">{ticket.customerName} | {ticket.category}</p>
              </div>
              <Button variant="ghost" size="sm">Open</Button>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

function AdminPromotions() {
  const promos = [
    { id: '1', name: 'Welcome Discount', code: 'HERSTEP10', type: '10% off', usage: '23/100', active: true },
    { id: '2', name: 'Summer Sale', code: 'SUMMER100', type: 'KSh 100 off', usage: '8/50', active: true },
  ];
  return (
    <div className="space-y-6 animate-fadeIn">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-neutral-900">Promotions</h1>
        <Button>Create Promotion</Button>
      </div>
      <div className="space-y-3">
        {promos.map(p => (
          <Card key={p.id} className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-neutral-900">{p.name}</p>
                <p className="text-xs text-neutral-500 mt-0.5">Code: {p.code} | {p.type} | Used: {p.usage}</p>
              </div>
              <Badge variant={p.active ? 'success' : 'default'}>{p.active ? 'Active' : 'Inactive'}</Badge>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

function AdminNotifications() {
  return (
    <div className="space-y-6 animate-fadeIn">
      <h1 className="text-2xl font-bold text-neutral-900">Notifications</h1>
      <Card className="p-6">
        <EmptyState title="No new notifications" description="All caught up. Notifications will appear here." />
      </Card>
    </div>
  );
}

function AdminSettings() {
  return (
    <div className="space-y-6 animate-fadeIn">
      <h1 className="text-2xl font-bold text-neutral-900">Settings</h1>
      <Card className="p-6">
        <div className="space-y-6">
          <div>
            <h3 className="font-semibold text-neutral-900 mb-4">Business Information</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Input label="Business Name" defaultValue="HerStep Collection" />
              <Input label="Phone" defaultValue="+254 799 021 089" />
              <Input label="WhatsApp" defaultValue="+254 106 624 924" />
              <Input label="Email" defaultValue="herstepcollection@gmail.com" />
            </div>
          </div>
          <div>
            <h3 className="font-semibold text-neutral-900 mb-4">Delivery Settings</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Input label="Juja Delivery Fee" defaultValue="100" type="number" />
              <Input label="Nearby Areas Fee" defaultValue="150" type="number" />
              <Input label="Nairobi Delivery Fee" defaultValue="250" type="number" />
            </div>
          </div>
          <Button>Save Settings</Button>
        </div>
      </Card>
    </div>
  );
}

function StatCard({ title, value, icon: Icon, trend, variant }: { title: string; value: string; icon?: any; trend?: string; variant?: string }) {
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs text-neutral-500">{title}</p>
        {Icon && <Icon className="w-4 h-4 text-neutral-400" />}
      </div>
      <p className="text-2xl font-bold text-neutral-900">{value}</p>
      {trend && <p className="text-xs text-emerald-600 mt-1">{trend}</p>}
    </Card>
  );
}
