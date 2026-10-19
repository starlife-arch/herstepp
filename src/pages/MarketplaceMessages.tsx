import React, { FormEvent, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { MessageCircle, Send, RefreshCw } from 'lucide-react';
import { Button, Card, EmptyState, Skeleton } from '../components/ui';
import { apiFetch } from '../lib/api';
import { useApp } from '../context/AppContext';
import { usePageMeta } from '../hooks/usePageMeta';

type Conversation = {
  id: string; productId: string; productName: string; productImage?: string;
  customerUid: string; sellerUid: string; sellerDisplayName?: string; status: string;
  lastMessage?: string; updatedAt?: string;
};
type Message = { id: string; senderUid: string; senderRole: string; text: string; createdAt?: string };

const when = (value?: string) => value ? new Date(value).toLocaleString('en-KE', { dateStyle: 'short', timeStyle: 'short' }) : '';

export default function MarketplaceMessages() {
  usePageMeta('Marketplace Messages | HerStep Collection', 'Message sellers and customers on the HerStep marketplace.');
  const [params, setParams] = useSearchParams();
  const { state } = useApp();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const loadConversations = useCallback(async () => {
    const result: any = await apiFetch('/api/marketplace/messages');
    const rows: Conversation[] = Array.isArray(result.conversations) ? result.conversations : [];
    setConversations(rows);
    return rows;
  }, []);

  const loadMessages = useCallback(async (id: string) => {
    const result: any = await apiFetch('/api/marketplace/messages?conversationId=' + encodeURIComponent(id));
    setSelected(result.conversation || null);
    setMessages(Array.isArray(result.messages) ? result.messages : []);
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true); setError('');
      try {
        const result: any = await apiFetch('/api/marketplace/messages');
        if (!active) return;
        const rows: Conversation[] = Array.isArray(result.conversations) ? result.conversations : [];
        setConversations(rows);
        const id = params.get('conversationId');
        const found = rows.find(row => row.id === id) || (id ? null : rows[0]) || null;
        if (found) {
          const detail: any = await apiFetch('/api/marketplace/messages?conversationId=' + encodeURIComponent(found.id));
          if (!active) return;
          setSelected(detail.conversation || found);
          setMessages(Array.isArray(detail.messages) ? detail.messages : []);
          if (id !== found.id) setParams({ conversationId: found.id }, { replace: true });
        } else {
          setSelected(null); setMessages([]);
        }
      } catch (err: any) {
        if (active) setError(err?.message || 'Could not load marketplace messages.');
      } finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, [params, setParams]);

  async function selectConversation(row: Conversation) {
    setSelected(row); setParams({ conversationId: row.id });
    setError(''); setNotice('');
    try { await loadMessages(row.id); }
    catch (err: any) { setError(err?.message || 'Could not load this conversation.'); }
  }

  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    if (!selected || !draft.trim() || busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await apiFetch('/api/marketplace/messages', { method: 'POST', body: JSON.stringify({ conversationId: selected.id, message: draft.trim() }) });
      setDraft('');
      await loadMessages(selected.id);
      await loadConversations();
    } catch (err: any) { setError(err?.message || 'Message could not be sent.'); }
    finally { setBusy(false); }
  }

  async function refresh() {
    setBusy(true); setError('');
    try {
      const rows = await loadConversations();
      const current = rows.find(row => row.id === selected?.id);
      if (current) await loadMessages(current.id);
    } catch (err: any) { setError(err?.message || 'Could not refresh messages.'); }
    finally { setBusy(false); }
  }

  if (loading) return <div className="max-w-6xl mx-auto px-4 py-10"><Skeleton className="h-10 w-1/3 mb-5" /><Skeleton className="h-96 rounded-2xl" /></div>;

  return <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
    <div className="flex items-center justify-between gap-3 mb-6">
      <div><p className="text-xs font-semibold tracking-wide text-neutral-500">HERSTEP MARKETPLACE</p><h1 className="text-3xl font-bold text-neutral-900 mt-1">Messages</h1><p className="text-sm text-neutral-600 mt-2">Ask questions about listings and communicate with the other participant.</p></div>
      <Button variant="outline" onClick={refresh} disabled={busy}><RefreshCw className="w-4 h-4 mr-2" /> Refresh</Button>
    </div>
    {error && <p role="alert" className="rounded-lg bg-red-50 border border-red-200 text-red-700 p-3 text-sm mb-4">{error}</p>}
    {notice && <p role="status" className="text-sm text-neutral-600 mb-4">{notice}</p>}
    {conversations.length === 0 ? <EmptyState title="No marketplace messages yet" description="Open a marketplace product and choose Message seller to start a conversation." /> :
      <div className="grid grid-cols-1 md:grid-cols-[300px_minmax(0,1fr)] gap-4">
        <Card className="p-2 h-fit">
          <h2 className="font-semibold text-neutral-900 px-3 py-2">Conversations</h2>
          <div className="space-y-1">{conversations.map(row => <button key={row.id} onClick={() => void selectConversation(row)} className={'w-full text-left rounded-xl p-3 flex gap-3 hover:bg-neutral-50 ' + (selected?.id === row.id ? 'bg-neutral-100' : '')}>
            {row.productImage ? <img src={row.productImage} alt="" className="w-12 h-12 rounded-lg object-cover bg-neutral-100" /> : <span className="w-12 h-12 rounded-lg bg-neutral-100 flex items-center justify-center"><MessageCircle className="w-5 h-5" /></span>}
            <span className="min-w-0 flex-1"><span className="block font-medium text-sm text-neutral-900 truncate">{row.productName || 'Marketplace listing'}</span><span className="block text-xs text-neutral-500 truncate">{row.sellerDisplayName || 'Seller'} · {row.status}</span><span className="block text-xs text-neutral-500 truncate mt-1">{row.lastMessage || 'Conversation started'}</span></span>
          </button>)}</div>
        </Card>
        <Card className="p-4 sm:p-5 min-h-[480px] flex flex-col">
          {selected ? <>
            <div className="border-b border-neutral-100 pb-4 mb-4 flex items-center gap-3">{selected.productImage && <img src={selected.productImage} alt="" className="w-12 h-12 rounded-lg object-cover bg-neutral-100" />}<div><h2 className="font-semibold text-neutral-900">{selected.productName || 'Marketplace conversation'}</h2><p className="text-xs text-neutral-500 mt-1">{selected.status === 'OPEN' ? 'Conversation open' : 'Conversation closed'}</p></div></div>
            <div className="flex-1 space-y-3 overflow-y-auto max-h-[480px] pr-1">{messages.map(message => <div key={message.id} className={'flex ' + (message.senderUid === state.user?.id ? 'justify-end' : 'justify-start')}><div className={'max-w-[85%] rounded-2xl px-4 py-3 ' + (message.senderUid === state.user?.id ? 'bg-neutral-900 text-white' : 'bg-neutral-100 text-neutral-900')}><p className="text-sm whitespace-pre-wrap break-words">{message.text}</p><p className={'text-[10px] mt-2 ' + (message.senderUid === state.user?.id ? 'text-neutral-300' : 'text-neutral-500')}>{message.senderRole} · {when(message.createdAt)}</p></div></div>)}
              {messages.length === 0 && <p className="text-sm text-neutral-500 text-center py-8">No messages yet. Send the first message below.</p>}</div>
            {selected.status === 'OPEN' ? <form onSubmit={sendMessage} className="border-t border-neutral-100 pt-4 mt-4"><label htmlFor="marketplace-message" className="text-sm font-medium text-neutral-700">Your message</label><textarea id="marketplace-message" value={draft} onChange={event => setDraft(event.target.value)} maxLength={2000} rows={3} placeholder="Ask a question about this listing…" className="w-full mt-2 rounded-xl border border-neutral-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-neutral-500" /><div className="flex justify-between items-center gap-3 mt-2"><span className="text-xs text-neutral-500">{draft.length}/2000</span><Button type="submit" disabled={busy || !draft.trim()}><Send className="w-4 h-4 mr-2" />{busy ? 'Sending…' : 'Send message'}</Button></div></form> : <p className="text-sm text-neutral-500 mt-4">This conversation is closed and cannot receive new messages.</p>}
          </> : <div className="flex-1 flex items-center justify-center text-center text-sm text-neutral-500">Choose a conversation to view messages.</div>}
        </Card>
      </div>}
  </div>;
}
