import React, { useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';
import { Card, Button, Input, Badge, EmptyState } from './ui';

type CampaignHistory = {
  id: string;
  subject: string;
  headline: string;
  status: string;
  recipients: number;
  sent: number;
  failed: number;
  createdAt: string | null;
};

type CampaignForm = {
  format: 'html' | 'text';
  subject: string;
  headline: string;
  message: string;
  imageUrl: string;
  buttonLabel: string;
  buttonUrl: string;
};

const initialForm: CampaignForm = {
  format: 'html',
  subject: '',
  headline: '',
  message: '',
  imageUrl: '',
  buttonLabel: 'Shop Now',
  buttonUrl: '/shop',
};

function formatDate(value: string | null) {
  if (!value) return 'Just now';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

export default function AdminEmailCampaigns() {
  const [form, setForm] = useState<CampaignForm>(initialForm);
  const [eligibleRecipients, setEligibleRecipients] = useState(0);
  const [history, setHistory] = useState<CampaignHistory[]>([]);
  const [testTo, setTestTo] = useState('');
  const [confirmSend, setConfirmSend] = useState(false);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState<'upload' | 'test' | 'send' | null>(null);
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const data: any = await apiFetch('/api/admin/email-campaigns');
      setEligibleRecipients(Number(data?.eligibleRecipients) || 0);
      setHistory(Array.isArray(data?.campaigns) ? data.campaigns : []);
    } catch (error: any) {
      setNotice({ type: 'error', text: error?.message || 'Could not load campaign history.' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const patch = (key: keyof CampaignForm, value: string) => {
    setForm(current => ({ ...current, [key]: value }));
    setNotice(null);
  };

  const uploadImage = async (file?: File) => {
    if (!file) return;
    if (!file.type.startsWith('image/') || file.size > 8 * 1024 * 1024) {
      setNotice({ type: 'error', text: 'Choose an image up to 8 MB.' });
      return;
    }
    setWorking('upload');
    setNotice(null);
    try {
      const sign: any = await apiFetch('/api/media/sign-upload', {
        method: 'POST',
        body: JSON.stringify({ resourceType: 'image', fileName: file.name, bytes: file.size, purpose: 'email-campaigns' }),
      });
      const fd = new FormData();
      fd.append('file', file);
      fd.append('api_key', sign.apiKey);
      fd.append('timestamp', String(sign.timestamp));
      fd.append('signature', sign.signature);
      fd.append('folder', sign.folder);
      fd.append('public_id', sign.publicId);
      const response = await fetch(`https://api.cloudinary.com/v1_1/${sign.cloudName}/image/upload`, { method: 'POST', body: fd });
      const raw = await response.text();
      let uploaded: any = {};
      try { uploaded = JSON.parse(raw); } catch { /* provider may return a non-JSON error */ }
      if (!response.ok) throw new Error(uploaded?.error?.message || 'Image upload failed.');
      patch('imageUrl', String(uploaded.secure_url || ''));
      setNotice({ type: 'success', text: 'Image uploaded and added to the email preview.' });
    } catch (error: any) {
      setNotice({ type: 'error', text: error?.message || 'Could not upload that image.' });
    } finally {
      setWorking(null);
    }
  };

  const payload = () => ({
    ...form,
    mode: 'test',
    testTo: testTo.trim(),
  });

  const sendTest = async () => {
    setWorking('test');
    setNotice(null);
    try {
      const result: any = await apiFetch('/api/admin/email-campaigns', {
        method: 'POST',
        body: JSON.stringify(payload()),
      });
      if (!result.sent) throw new Error(result.detail || 'The test email could not be sent.');
      setNotice({ type: 'success', text: `Test email sent to ${result.to}.` });
    } catch (error: any) {
      setNotice({ type: 'error', text: error?.message || 'Could not send the test email.' });
    } finally {
      setWorking(null);
    }
  };

  const sendCampaign = async () => {
    if (!confirmSend) {
      setNotice({ type: 'error', text: 'Confirm that you want to send this campaign to opted-in customers.' });
      return;
    }
    if (eligibleRecipients < 1) {
      setNotice({ type: 'error', text: 'There are no eligible opted-in customers to receive this campaign.' });
      return;
    }
    setWorking('send');
    setNotice(null);
    try {
      const result: any = await apiFetch('/api/admin/email-campaigns', {
        method: 'POST',
        body: JSON.stringify({ ...form, mode: 'send' }),
      });
      setNotice({
        type: 'success',
        text: `Campaign queued for ${result.recipients} opted-in customer(s). Delivery runs in the background; check campaign history for progress.`,
      });
      setConfirmSend(false);
      await load();
    } catch (error: any) {
      setNotice({ type: 'error', text: error?.message || 'Could not queue this campaign.' });
    } finally {
      setWorking(null);
    }
  };

  const ready = form.subject.trim().length >= 3
    && form.headline.trim().length >= 2
    && form.message.trim().length >= 5
    && (form.format === 'text' || !form.imageUrl || /^https:\/\//i.test(form.imageUrl))
    && (!form.buttonLabel.trim() && !form.buttonUrl.trim()
      || Boolean(form.buttonLabel.trim() && form.buttonUrl.trim()));

  return (
    <div className="space-y-6 animate-fadeIn">
      <div>
        <h1 className="text-2xl font-bold text-neutral-900">Email campaigns</h1>
        <p className="text-sm text-neutral-500 mt-1">Send sales, new-stock announcements and HerStep news to customers who opted in to marketing emails.</p>
      </div>

      {notice && (
        <div role="status" className={`rounded-lg border px-4 py-3 text-sm ${notice.type === 'success' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-red-200 bg-red-50 text-red-700'}`}>
          {notice.text}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <Card className="p-4">
          <p className="text-sm text-neutral-500">Eligible recipients</p>
          <p className="mt-1 text-2xl font-bold text-neutral-900">{loading ? '…' : eligibleRecipients}</p>
          <p className="mt-1 text-xs text-neutral-500">Customers who opted in and have a valid email.</p>
        </Card>
        <Card className="p-4">
          <p className="text-sm text-neutral-500">Campaigns recorded</p>
          <p className="mt-1 text-2xl font-bold text-neutral-900">{loading ? '…' : history.length}</p>
          <p className="mt-1 text-xs text-neutral-500">Most recent 20 campaigns.</p>
        </Card>
        <Card className="p-4">
          <p className="text-sm text-neutral-500">Email format</p>
          <p className="mt-1 text-lg font-bold text-neutral-900">{form.format === 'html' ? 'Branded HTML' : 'Simple text'}</p>
          <p className="mt-1 text-xs text-neutral-500">You do not need to write or upload an HTML file.</p>
        </Card>
      </div>

      <Card className="p-5 space-y-5">
        <div>
          <h2 className="font-semibold text-neutral-900">Compose a campaign</h2>
          <p className="text-sm text-neutral-500 mt-1">Start with a short subject, a clear announcement and one useful link.</p>
        </div>

        <div className="flex flex-wrap gap-2" role="group" aria-label="Email format">
          <button type="button" onClick={() => patch('format', 'html')} className={`rounded-lg px-4 py-2 text-sm font-medium ${form.format === 'html' ? 'bg-neutral-900 text-white' : 'border border-neutral-200 bg-white text-neutral-700'}`}>Branded HTML</button>
          <button type="button" onClick={() => patch('format', 'text')} className={`rounded-lg px-4 py-2 text-sm font-medium ${form.format === 'text' ? 'bg-neutral-900 text-white' : 'border border-neutral-200 bg-white text-neutral-700'}`}>Simple text</button>
        </div>

        <Input label="Email subject" maxLength={140} value={form.subject} onChange={event => patch('subject', event.target.value)} placeholder="New arrivals are here at HerStep Collection" />
        <Input label="Headline" maxLength={160} value={form.headline} onChange={event => patch('headline', event.target.value)} placeholder="Meet your new favourite shoes" />

        <div className="space-y-1.5">
          <label htmlFor="campaign-message" className="block text-sm font-medium text-neutral-700">Message</label>
          <textarea id="campaign-message" rows={6} maxLength={4000} value={form.message} onChange={event => patch('message', event.target.value)} placeholder="Write your announcement here. New stock, a sale, a promo code or a feature update…" className="w-full rounded-lg border border-neutral-300 bg-white px-3.5 py-2.5 text-sm focus:border-neutral-900" />
          <p className="text-xs text-neutral-500">{form.message.length}/4000 characters</p>
        </div>

        {form.format === 'html' && (
          <div className="space-y-4 rounded-xl border border-neutral-200 p-4">
            <div>
              <h3 className="font-medium text-neutral-900">Image and call-to-action</h3>
              <p className="text-sm text-neutral-500 mt-1">Images appear inside the email. Some email apps may ask customers to load images.</p>
            </div>
            <div className="space-y-2">
              <label className="block text-sm font-medium text-neutral-700" htmlFor="campaign-image">Upload a banner or product photo (up to 8 MB)</label>
              <input id="campaign-image" type="file" accept="image/*" disabled={working !== null} onChange={event => { void uploadImage(event.target.files?.[0]); event.currentTarget.value = ''; }} className="block w-full text-sm text-neutral-700" />
              <Input label="Or paste a public HTTPS image URL" value={form.imageUrl} onChange={event => patch('imageUrl', event.target.value)} placeholder="https://…" />
              {form.imageUrl && (
                <div className="rounded-lg border border-neutral-200 p-2">
                  <img src={form.imageUrl} alt="Campaign image preview" className="max-h-56 max-w-full rounded object-contain" onError={event => { event.currentTarget.style.display = 'none'; }} />
                  <Button size="sm" variant="outline" onClick={() => patch('imageUrl', '')}>Remove image</Button>
                </div>
              )}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Input label="Button label (optional)" maxLength={60} value={form.buttonLabel} onChange={event => patch('buttonLabel', event.target.value)} placeholder="Shop Now" />
              <Input label="Button link (optional)" value={form.buttonUrl} onChange={event => patch('buttonUrl', event.target.value)} placeholder="/shop or https://…" />
            </div>
          </div>
        )}

        <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="font-semibold text-neutral-900">Preview</h3>
            <Badge variant="info">{form.format === 'html' ? 'HTML email' : 'Simple text email'}</Badge>
          </div>
          <div className="mx-auto max-w-xl overflow-hidden rounded-xl border border-neutral-200 bg-white">
            <div className={`px-5 py-4 text-center font-bold ${form.format === 'html' ? 'bg-neutral-900 text-white' : 'border-b border-neutral-200 text-neutral-900'}`}>HerStep Collection</div>
            <div className="p-5">
              <p className="text-xl font-bold text-neutral-900">{form.headline || 'Your headline appears here'}</p>
              {form.format === 'html' && form.imageUrl && <img src={form.imageUrl} alt="" className="mt-4 max-h-64 w-full rounded-lg object-contain" />}
              <p className="mt-4 whitespace-pre-wrap text-sm leading-6 text-neutral-700">{form.message || 'Your message appears here.'}</p>
              {form.format === 'html' && form.buttonLabel.trim() && form.buttonUrl.trim() && <div className="mt-5"><span className="inline-block rounded-lg bg-neutral-900 px-5 py-3 text-sm font-semibold text-white">{form.buttonLabel}</span></div>}
              <p className="mt-6 border-t border-neutral-100 pt-4 text-xs text-neutral-500">You received this because you opted in to HerStep Collection updates. An unsubscribe link will be included automatically.</p>
            </div>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="Send a test email to" value={testTo} onChange={event => setTestTo(event.target.value)} placeholder="you@example.com" />
          <div className="flex items-end">
            <Button variant="outline" onClick={sendTest} disabled={!ready || !testTo.trim() || working !== null} className="w-full">
              {working === 'test' ? 'Sending test…' : 'Send test email'}
            </Button>
          </div>
        </div>

        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 space-y-3">
          <p className="text-sm text-amber-900">Campaigns are sent only to customers who have opted in. Transactional order and account emails are not affected by marketing preferences.</p>
          <label className="flex items-start gap-2 text-sm text-neutral-800">
            <input type="checkbox" checked={confirmSend} onChange={event => setConfirmSend(event.target.checked)} className="mt-1 h-4 w-4" />
            <span>I have reviewed the subject, message, image and link, and I want to send this campaign to all {eligibleRecipients} eligible opted-in customer(s).</span>
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={sendCampaign} disabled={!ready || !confirmSend || eligibleRecipients < 1 || working !== null}>
              {working === 'send' ? 'Queueing campaign…' : 'Send campaign'}
            </Button>
            <Button variant="outline" onClick={() => { setForm(initialForm); setConfirmSend(false); setNotice(null); }}>Clear draft</Button>
          </div>
        </div>
      </Card>

      <Card className="p-5">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold text-neutral-900">Campaign history</h2>
            <p className="text-sm text-neutral-500 mt-1">Delivery counts update while the background send is running.</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>Refresh</Button>
        </div>
        {loading ? <p className="text-sm text-neutral-500">Loading campaign history…</p> : history.length === 0 ? (
          <EmptyState title="No campaigns yet" description="Your sent campaign history will appear here." />
        ) : (
          <div className="space-y-3">
            {history.map(campaign => (
              <div key={campaign.id} className="rounded-lg border border-neutral-200 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium text-neutral-900">{campaign.subject}</p>
                    <p className="mt-1 text-xs text-neutral-500">{campaign.headline} · {formatDate(campaign.createdAt)}</p>
                  </div>
                  <Badge variant={campaign.status === 'SENT' ? 'success' : campaign.status === 'FAILED' ? 'danger' : 'info'}>{campaign.status}</Badge>
                </div>
                <p className="mt-3 text-sm text-neutral-600">{campaign.sent} sent · {campaign.failed} failed · {campaign.recipients} recipients</p>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
