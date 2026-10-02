import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Paperclip, Send, X } from 'lucide-react';
import { collection, onSnapshot, orderBy, query } from 'firebase/firestore';
import { apiFetch } from '../lib/api';
import { getFirebase } from '../lib/firebase';
import { toUiTicket } from '../lib/supportAdapter';
import { Badge, Button, Card, getStatusBadge } from './ui';

const imageTypes = ['image/jpeg', 'image/png', 'image/webp'];

export async function uploadSupportImages(files: File[]) {
  return Promise.all(files.map(async file => {
    const signed: any = await apiFetch('/api/support/sign-upload', { method: 'POST', body: JSON.stringify({ fileName: file.name, bytes: file.size }) });
    const form = new FormData();
    Object.entries({ api_key: signed.apiKey, timestamp: String(signed.timestamp), signature: signed.signature, folder: signed.folder, public_id: signed.publicId }).forEach(([key, value]) => form.append(key, value as string));
    form.append('file', file);
    const response = await fetch(`https://api.cloudinary.com/v1_1/${signed.cloudName}/image/upload`, { method: 'POST', body: form });
    if (!response.ok) throw new Error('Image upload failed.');
    const result = await response.json();
    return { url: result.secure_url, publicId: result.public_id, type: 'image' };
  }));
}

export function SupportChat({ ticket, onBack, admin = false, onTicket }: { ticket: any; onBack: () => void; admin?: boolean; onTicket?: (ticket: any) => void }) {
  const [current, setCurrent] = useState(ticket);
  const [message, setMessage] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let stop: undefined | (() => void);
    let timer: number | undefined;
    const start = async () => {
      const { db } = await getFirebase();
      stop = onSnapshot(query(collection(db, 'supportTickets', ticket.id, 'messages'), orderBy('createdAt', 'asc')), snap => {
        const messages = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        setCurrent((previous: any) => toUiTicket({ ...previous, status: previous.status.toUpperCase() }, messages));
      }, () => { timer = window.setInterval(() => apiFetch(admin ? '/api/admin/support' : '/api/support').then((result: any) => { const found = result.tickets?.find((item: any) => item.id === ticket.id); if (found) setCurrent((previous: any) => toUiTicket(found, previous.messages)); }).catch(() => undefined), 5000); });
    };
    start().catch(() => undefined);
    return () => { stop?.(); if (timer) window.clearInterval(timer); };
  }, [admin, ticket.id]);
  useEffect(() => { end.current?.scrollIntoView({ behavior: 'smooth' }); }, [current.messages]);

  const selectFiles = (event: React.ChangeEvent<HTMLInputElement>) => {
    const next = Array.from(event.target.files || []);
    if (next.some(file => !imageTypes.includes(file.type) || file.size > 5 * 1024 * 1024)) { setError('Images must be JPEG, PNG, or WebP files no larger than 5 MB.'); return; }
    setFiles(value => [...value, ...next].slice(0, 3)); setError(''); event.target.value = '';
  };
  const send = async () => {
    if ((!message.trim() && !files.length) || sending) return;
    setSending(true); setError('');
    try { const attachments = await uploadSupportImages(files); await apiFetch(admin ? '/api/admin/support/messages' : '/api/support/messages', { method: 'POST', body: JSON.stringify({ ticketDocumentId: current.id, message, attachments, clientMessageId: crypto.randomUUID().replace(/-/g, '') }) }); setMessage(''); setFiles([]); } catch (err: any) { setError(err.message || 'Could not send your message.'); } finally { setSending(false); }
  };

  return <div className="animate-fadeIn"><Card className="p-4 mb-4"><div className="flex items-center gap-3"><button onClick={onBack} className="p-2 rounded-lg hover:bg-neutral-100"><ArrowLeft className="w-5 h-5" /></button><div className="flex-1 min-w-0"><div className="flex items-center gap-2"><span className="text-xs font-mono text-neutral-500">{current.ticketId}</span><Badge variant={getStatusBadge(current.status).variant}>{getStatusBadge(current.status).label}</Badge></div><p className="font-medium text-neutral-900 text-sm truncate">{current.subject}</p></div><p className="text-xs text-neutral-400">{current.category}</p></div></Card><Card className="p-4 mb-4"><div className="h-[400px] sm:h-[500px] overflow-y-auto space-y-4">{current.messages.map((msg: any) => <div key={msg.id} className={`flex ${msg.senderRole === 'customer' ? 'justify-end' : 'justify-start'}`}><div className={`max-w-[80%] ${msg.senderRole === 'customer' ? 'chat-bubble-customer' : 'chat-bubble-admin'}`}>{msg.senderRole === 'admin' && <p className="text-xs font-medium mb-1 opacity-70">{msg.senderName}</p>}{msg.content && <p className="text-sm leading-relaxed">{msg.content}</p>}{msg.attachments?.map((attachment: any) => <a key={attachment.publicId} href={attachment.url} target="_blank" rel="noreferrer"><img className="rounded-lg mt-2 max-w-full w-32 h-32 object-cover" src={attachment.url} /></a>)}<p className="text-xs mt-1 opacity-50">{new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p></div></div>)}<div ref={end} /></div></Card>{current.status !== 'closed' ? <Card className="p-4">{files.length > 0 && <div className="flex gap-2 mb-3">{files.map((file, index) => <div key={`${file.name}-${index}`} className="relative"><img className="w-12 h-12 rounded-lg object-cover" src={URL.createObjectURL(file)} /><button onClick={() => setFiles(value => value.filter((_, item) => item !== index))} className="absolute -top-2 -right-2 bg-white rounded-full"><X className="w-4 h-4" /></button></div>)}</div>}{error && <p className="text-xs text-red-600 mb-2">{error}</p>}<div className="flex gap-3"><button onClick={() => input.current?.click()} className="p-2.5 rounded-lg border border-neutral-300 hover:bg-neutral-50 text-neutral-500"><Paperclip className="w-5 h-5" /></button><input ref={input} onChange={selectFiles} type="file" accept="image/jpeg,image/png,image/webp" multiple className="hidden" /><input type="text" value={message} onChange={event => setMessage(event.target.value)} onKeyDown={event => event.key === 'Enter' && send()} placeholder="Type your message..." className="flex-1 px-4 py-2.5 border border-neutral-300 rounded-xl text-sm focus:border-neutral-900" /><Button onClick={send} loading={sending} disabled={!message.trim() && !files.length}><Send className="w-4 h-4" /></Button></div></Card> : <Card className="p-4 text-center"><p className="text-sm text-neutral-500">This support ticket has been closed.</p><p className="text-xs text-neutral-400 mt-1">Create a new ticket if you need further assistance.</p></Card>}</div>;
}
