import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Paperclip, Send, X } from 'lucide-react';
import { collection, onSnapshot, orderBy, query } from 'firebase/firestore';
import { apiFetch } from '../lib/api';
import { getFirebase } from '../lib/firebase';
import { toUiTicket } from '../lib/supportAdapter';
import { Badge, Button, Card, getStatusBadge } from './ui';

const imageExtensions = new Set(["jpg","jpeg","png","webp","gif","bmp","tif","tiff","avif","heic","heif","ico"]);
const imageTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/bmp', 'image/tiff', 'image/avif', 'image/heic', 'image/heif', 'image/x-icon', 'image/vnd.microsoft.icon']);
const isSupportedImage = (file: File) => {
  const extension = file.name.split('.').pop()?.toLowerCase() || '';
  return imageExtensions.has(extension) && (imageTypes.has(file.type.toLowerCase()) || !file.type || file.type === 'application/octet-stream');
};

export async function uploadSupportImages(files: File[]) {
  return Promise.all(files.map(async file => {
    const signed: any = await apiFetch('/api/support/sign-upload', {
      method: 'POST',
      body: JSON.stringify({ fileName: file.name, bytes: file.size, mimeType: file.type }),
    });
    const form = new FormData();
    const fields = {
      api_key: signed.apiKey,
      allowed_formats: signed.allowedFormats.join(','),
      folder: signed.folder,
      public_id: signed.publicId,
      timestamp: String(signed.timestamp),
      signature: signed.signature,
    };
    Object.entries(fields).forEach(([key, value]) => form.append(key, value));
    form.append('file', file);
    const response = await fetch(`https://api.cloudinary.com/v1_1/${signed.cloudName}/image/upload`, { method: 'POST', body: form });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error?.message || 'Image upload failed.');
    return { url: result.secure_url, publicId: result.public_id, type: 'image' };
  }));
}

export function SupportChat({ ticket, onBack, admin = false }: { ticket: any; onBack: () => void; admin?: boolean }) {
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
    getFirebase().then(({ db }) => {
      stop = onSnapshot(query(collection(db, 'supportTickets', ticket.id, 'messages'), orderBy('createdAt', 'asc')), snap => {
        setCurrent((previous: any) => toUiTicket({ ...previous, status: previous.status.toUpperCase() }, snap.docs.map(doc => ({ id: doc.id, ...doc.data() }))));
      }, () => {
        timer = window.setInterval(() => {
          apiFetch(admin ? '/api/admin/support' : '/api/support').then((result: any) => {
            const found = result.tickets?.find((item: any) => item.id === ticket.id);
            if (found) setCurrent((previous: any) => toUiTicket(found, previous.messages));
          }).catch(() => undefined);
        }, 5000);
      });
    }).catch(() => undefined);
    return () => { stop?.(); if (timer) window.clearInterval(timer); };
  }, [admin, ticket.id]);
  useEffect(() => { end.current?.scrollIntoView({ behavior: 'smooth' }); }, [current.messages]);

  const selectFiles = (event: React.ChangeEvent<HTMLInputElement>) => {
    const next = Array.from(event.target.files || []);
    if (next.some(file => !isSupportedImage(file) || file.size > 5 * 1024 * 1024)) {
      setError('Use a supported photo or screenshot (JPEG, PNG, WebP, GIF, BMP, TIFF, AVIF, HEIC/HEIF or ICO) up to 5 MB.');
      return;
    }
    setFiles(value => [...value, ...next].slice(0, 3));
    setError('');
    event.target.value = '';
  };
  const send = async () => {
    if (current.status === 'closed' || (!message.trim() && !files.length) || sending) return;
    setSending(true);
    setError('');
    try {
      const attachments = await uploadSupportImages(files);
      await apiFetch(admin ? '/api/admin/support/messages' : '/api/support/messages', { method: 'POST', body: JSON.stringify({ ticketDocumentId: current.id, message, attachments, clientMessageId: crypto.randomUUID().replace(/-/g, '') }) });
      setMessage('');
      setFiles([]);
    } catch (err: any) { setError(err.message || 'Could not send your message.'); }
    finally { setSending(false); }
  };

  return <div className="animate-fadeIn"><Card className="p-4 mb-4"><div className="flex items-center gap-3"><button onClick={onBack} className="p-2 rounded-lg hover:bg-neutral-100"><ArrowLeft className="w-5 h-5" /></button><div className="flex-1 min-w-0"><div className="flex items-center gap-2"><span className="text-xs font-mono text-neutral-500">{current.ticketId}</span><Badge variant={getStatusBadge(current.status).variant}>{getStatusBadge(current.status).label}</Badge></div><p className="font-medium text-neutral-900 text-sm truncate">{current.subject}</p></div><p className="text-xs text-neutral-400">{current.category}</p></div></Card><Card className="p-4 mb-4"><div className="h-[400px] sm:h-[500px] overflow-y-auto space-y-4">{current.messages.map((msg: any) => <div key={msg.id} className={`flex ${msg.senderRole === 'customer' ? 'justify-end' : 'justify-start'}`}><div className={`max-w-[80%] ${msg.senderRole === 'customer' ? 'chat-bubble-customer' : 'chat-bubble-admin'}`}>{msg.senderRole === 'admin' && <p className="text-xs font-medium mb-1 opacity-70">{msg.senderName}</p>}{msg.content && <p className="text-sm leading-relaxed">{msg.content}</p>}{msg.attachments?.map((attachment: any) => <a key={attachment.publicId} href={attachment.url} target="_blank" rel="noreferrer"><img className="rounded-lg mt-2 max-w-full w-32 h-32 object-cover" src={attachment.url} /></a>)}<p className="text-xs mt-1 opacity-50">{new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p></div></div>)}<div ref={end} /></div></Card>{current.status !== 'closed' ? <Card className="p-4"><div className="flex gap-3"><button onClick={() => input.current?.click()} className="p-2.5 rounded-lg border border-neutral-300 hover:bg-neutral-50 text-neutral-500"><Paperclip className="w-5 h-5" /></button><input ref={input} onChange={selectFiles} type="file" accept="image/*" multiple className="hidden" /><input type="text" value={message} onChange={event => setMessage(event.target.value)} onKeyDown={event => event.key === 'Enter' && send()} placeholder="Type your message..." className="flex-1 px-4 py-2.5 border border-neutral-300 rounded-xl text-sm focus:border-neutral-900" /><Button onClick={send} loading={sending} disabled={!message.trim() && !files.length}><Send className="w-4 h-4" /></Button></div>{files.length > 0 && <div className="mt-3 flex flex-wrap gap-3">{files.map((file, index) => <div key={file.name + index} className="relative w-24 rounded-lg border border-neutral-200 bg-white p-2"><img src={URL.createObjectURL(file)} alt={file.name} className="h-16 w-full rounded object-cover" /><p className="mt-1 truncate text-[11px] text-neutral-600" title={file.name}>{file.name}</p><button type="button" aria-label={'Remove ' + file.name} onClick={() => setFiles(current => current.filter((_, item) => item !== index))} className="absolute -right-2 -top-2 rounded-full bg-white p-1 shadow"><X className="h-3.5 w-3.5" /></button></div>)}</div>}{error && <p className="text-xs text-red-600 mt-2">{error}</p>}</Card> : <Card className="p-4 text-center"><p className="text-sm text-neutral-500">This support ticket has been closed.</p><p className="text-xs text-neutral-400 mt-1">Create a new ticket if you need further assistance.</p></Card>}</div>;
}
