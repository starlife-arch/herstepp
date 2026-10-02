import React, { useState, useRef, useEffect } from 'react';
import { Send, Paperclip, X, Plus, MessageSquare, Clock, CheckCircle, ArrowLeft } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { toUiTicket } from '../lib/supportAdapter';
import { Card, Button, Badge, Input, formatDateTime, getStatusBadge, EmptyState } from '../components/ui';

export default function Support() {
  const [tickets, setTickets] = useState<any[]>([]);
  const [error, setError] = useState('');
  const [view, setView] = useState<'list' | 'chat' | 'new'>('list');
  const [selectedTicket, setSelectedTicket] = useState<any>(null);

  const handleOpenTicket = (ticket: any) => {
    setSelectedTicket(ticket);
    setView('chat');
  };

  useEffect(() => {
    const load = async () => {
      try {
        const result: any = await apiFetch('/api/support');
        setTickets((result.tickets || []).map((ticket: any) => toUiTicket(ticket, [])));
        setError('');
      } catch (err: any) { setError(err.message || 'Could not load support tickets.'); }
    };
    load();
    const interval = window.setInterval(load, 5000);
    return () => window.clearInterval(interval);
  }, []);

  const handleNewTicket = (ticket: any) => {
    setTickets(current => [ticket, ...current]);
    setSelectedTicket(ticket);
    setView('chat');
  };

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 animate-fadeIn">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-neutral-900">Support</h1>
          <p className="text-sm text-neutral-500 mt-1">Get help with your orders, payments, or products</p>
        </div>
        {view === 'list' && (
          <Button onClick={() => setView('new')}>
            <Plus className="w-4 h-4 mr-2" />
            New Request
          </Button>
        )}
      </div>

      {error && <p className="text-sm text-red-600 mb-4">{error}</p>}
      {view === 'list' && <TicketList tickets={tickets} onOpen={handleOpenTicket} />}
      {view === 'chat' && selectedTicket && (
        <ChatView ticket={selectedTicket} onBack={() => setView('list')} />
      )}
      {view === 'new' && <NewTicketForm onSubmit={handleNewTicket} onCancel={() => setView('list')} />}
    </div>
  );
}

function TicketList({ tickets, onOpen }: { tickets: any[]; onOpen: (t: any) => void }) {
  const openTickets = tickets.filter(t => t.status !== 'closed');
  const closedTickets = tickets.filter(t => t.status === 'closed');

  return (
    <div className="space-y-6">
      {openTickets.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-neutral-500 mb-3">Open Tickets</h3>
          <div className="space-y-3">
            {openTickets.map(ticket => (
              <Card key={ticket.id} hover className="p-4" >
                <div onClick={() => onOpen(ticket)} className="cursor-pointer">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-xs font-mono text-neutral-500">{ticket.ticketId}</span>
                        <Badge variant={getStatusBadge(ticket.status).variant}>{getStatusBadge(ticket.status).label}</Badge>
                      </div>
                      <p className="font-medium text-neutral-900 text-sm">{ticket.subject}</p>
                      <p className="text-xs text-neutral-500 mt-1 truncate">
                        {ticket.messages[ticket.messages.length - 1]?.content}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-xs text-neutral-400">{formatDateTime(ticket.updatedAt)}</p>
                      <p className="text-xs text-neutral-500 mt-1">{ticket.messages.length} messages</p>
                    </div>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}

      {closedTickets.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-neutral-500 mb-3">Closed Tickets</h3>
          <div className="space-y-3">
            {closedTickets.map(ticket => (
              <Card key={ticket.id} className="p-4 opacity-70">
                <div onClick={() => onOpen(ticket)} className="cursor-pointer">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-mono text-neutral-500">{ticket.ticketId}</span>
                    <Badge variant="default">Closed</Badge>
                  </div>
                  <p className="font-medium text-neutral-900 text-sm">{ticket.subject}</p>
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}

      {tickets.length === 0 && (
        <Card className="p-8">
          <EmptyState title="No support tickets" description="Create a new support request if you need help." />
        </Card>
      )}
    </div>
  );
}

function ChatView({ ticket, onBack }: { ticket: any; onBack: () => void }) {
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [ticket.messages]);

  const handleSend = async () => {
    if (!message.trim()) return;
    setSending(true);
    try {
      await apiFetch('/api/support/messages', { method: 'POST', body: JSON.stringify({ ticketDocumentId: ticket.id, message, attachments: [], clientMessageId: crypto.randomUUID().replace(/-/g, '') }) });
      ticket.messages.push({ id: crypto.randomUUID(), senderId: '', senderName: 'You', senderRole: 'customer', content: message, attachments: [], timestamp: new Date().toISOString() });
      setMessage('');
    } finally { setSending(false); }
  };

  return (
    <div className="animate-fadeIn">
      {/* Chat Header */}
      <Card className="p-4 mb-4">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="p-2 rounded-lg hover:bg-neutral-100">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono text-neutral-500">{ticket.ticketId}</span>
              <Badge variant={getStatusBadge(ticket.status).variant}>{getStatusBadge(ticket.status).label}</Badge>
            </div>
            <p className="font-medium text-neutral-900 text-sm truncate">{ticket.subject}</p>
          </div>
          <p className="text-xs text-neutral-400">{ticket.category}</p>
        </div>
      </Card>

      {/* Messages */}
      <Card className="p-4 mb-4" >
        <div className="h-[400px] sm:h-[500px] overflow-y-auto space-y-4">
          {ticket.messages.map((msg: any) => (
            <div key={msg.id} className={`flex ${msg.senderRole === 'customer' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[80%] ${msg.senderRole === 'customer' ? 'chat-bubble-customer' : 'chat-bubble-admin'}`}>
                {msg.senderRole === 'admin' && (
                  <p className="text-xs font-medium mb-1 opacity-70">{msg.senderName}</p>
                )}
                <p className="text-sm leading-relaxed">{msg.content}</p>
                <p className="text-xs mt-1 opacity-50">{new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
              </div>
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>
      </Card>

      {/* Input */}
      {ticket.status !== 'closed' ? (
        <Card className="p-4">
          <div className="flex gap-3">
            <button className="p-2.5 rounded-lg border border-neutral-300 hover:bg-neutral-50 text-neutral-500">
              <Paperclip className="w-5 h-5" />
            </button>
            <input
              type="text"
              value={message}
              onChange={e => setMessage(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSend()}
              placeholder="Type your message..."
              className="flex-1 px-4 py-2.5 border border-neutral-300 rounded-xl text-sm focus:border-neutral-900"
            />
            <Button onClick={handleSend} loading={sending} disabled={!message.trim()}>
              <Send className="w-4 h-4" />
            </Button>
          </div>
        </Card>
      ) : (
        <Card className="p-4 text-center">
          <p className="text-sm text-neutral-500">This support ticket has been closed.</p>
          <p className="text-xs text-neutral-400 mt-1">Create a new ticket if you need further assistance.</p>
        </Card>
      )}
    </div>
  );
}

function NewTicketForm({ onSubmit, onCancel }: { onSubmit: (t: any) => void; onCancel: () => void }) {
  const [subject, setSubject] = useState('');
  const [category, setCategory] = useState('');
  const [message, setMessage] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!subject || !category || !message) return;
    const clientMessageId = crypto.randomUUID().replace(/-/g, '');
    apiFetch('/api/support/create', { method: 'POST', body: JSON.stringify({ subject, category, message, attachments: [], clientMessageId }) })
      .then((result: any) => onSubmit(toUiTicket({ id: result.ticket.id, ticketId: result.ticket.ticketId, subject, category, status: 'OPEN', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, [{ id: clientMessageId, senderRole: 'CUSTOMER', senderName: 'You', body: message, createdAt: new Date().toISOString() }])))
      .catch(() => undefined);
  };

  return (
    <Card className="p-6 animate-fadeIn">
      <div className="flex items-center gap-3 mb-6">
        <button onClick={onCancel} className="p-2 rounded-lg hover:bg-neutral-100">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h2 className="text-lg font-semibold text-neutral-900">New Support Request</h2>
      </div>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-neutral-700 mb-1.5">Category</label>
          <select value={category} onChange={e => setCategory(e.target.value)} className="w-full px-3.5 py-2.5 border border-neutral-300 rounded-lg text-sm bg-white" required>
            <option value="">Select category</option>
            <option value="Order Issue">Order Issue</option>
            <option value="Payment Issue">Payment Issue</option>
            <option value="Delivery Issue">Delivery Issue</option>
            <option value="Product Issue">Product Issue</option>
            <option value="Return/Exchange">Return/Exchange</option>
            <option value="General Enquiry">General Enquiry</option>
            <option value="Other">Other</option>
          </select>
        </div>
        <Input label="Subject" value={subject} onChange={e => setSubject(e.target.value)} placeholder="Brief description of your issue" required />
        <div>
          <label className="block text-sm font-medium text-neutral-700 mb-1.5">Message</label>
          <textarea
            value={message}
            onChange={e => setMessage(e.target.value)}
            className="w-full px-3.5 py-2.5 border border-neutral-300 rounded-lg text-sm h-32 resize-none"
            placeholder="Describe your issue in detail..."
            required
          />
        </div>
        <div className="flex gap-3 pt-2">
          <Button type="submit">Submit Request</Button>
          <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
        </div>
      </form>
    </Card>
  );
}
