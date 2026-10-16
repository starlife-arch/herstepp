import React, { useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';
import { Card, Button, Input, Badge, EmptyState } from './ui';

type SmsCampaign = {
  id: string;
  name: string;
  message: string;
  status: string;
  recipients: number;
  sent: number;
  failed: number;
  createdAt: string | null;
};

const MAX_MESSAGE_LENGTH = 1800;

function formatDate(value: string | null) {
  if (!value) return 'Just now';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

export default function AdminSmsCampaigns() {
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [testPhone, setTestPhone] = useState('');
  const [eligibleRecipients, setEligibleRecipients] = useState(0);
  const [history, setHistory] = useState<SmsCampaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState<'test' | 'send' | null>(null);
  const [confirmSend, setConfirmSend] = useState(false);
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const data: any = await apiFetch('/api/admin/sms-campaigns');
      setEligibleRecipients(Number(data?.eligibleRecipients) || 0);
      setHistory(Array.isArray(data?.campaigns) ? data.campaigns : []);
    } catch (error: any) {
      setNotice({ type: 'error', text: error?.message || 'Could not load SMS campaigns.' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const sendTest = async () => {
    setWorking('test'); setNotice(null);
    try {
      const result: any = await apiFetch('/api/admin/sms-campaigns', {
        method: 'POST',
        body: JSON.stringify({ mode: 'test', name, message, testPhone }),
      });
      if (!result.sent) throw new Error(result.detail || 'HashBack could not send the test SMS.');
      setNotice({ type: 'success', text: `Test SMS sent to ${result.to}.` });
    } catch (error: any) {
      setNotice({ type: 'error', text: error?.message || 'Could not send the test SMS.' });
    } finally { setWorking(null); }
  };

  const sendCampaign = async () => {
    if (!confirmSend) {
      setNotice({ type: 'error', text: 'Confirm before sending to opted-in customers.' });
      return;
    }
    setWorking('send'); setNotice(null);
    try {
      const result: any = await apiFetch('/api/admin/sms-campaigns', {
        method: 'POST',
        body: JSON.stringify({ mode: 'send', name, message }),
      });
      setNotice({ type: 'success', text: `SMS campaign queued for ${result.recipients} opted-in customer(s). Check campaign history for delivery counts.` });
      setConfirmSend(false);
      await load();
    } catch (error: any) {
      setNotice({ type: 'error', text: error?.message || 'Could not queue the SMS campaign.' });
    } finally { setWorking(null); }
  };

  const ready = message.trim().length > 0 && message.length <= MAX_MESSAGE_LENGTH;

  return (
    <div className="space-y-6 animate-fadeIn">
      <div>
        <h1 className="text-2xl font-bold text-neutral-900">SMS campaigns</h1>
        <p className="mt-1 text-sm text-neutral-500">Send promotional SMS through the existing HashBack integration. Only customers who explicitly opted in to SMS marketing are eligible.</p>
      </div>

      {notice && <div role="status" className={`rounded-lg border px-4 py-3 text-sm ${notice.type === 'success' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-red-200 bg-red-50 text-red-700'}`}>{notice.text}</div>}

      <div className="grid gap-4 sm:grid-cols-3">
        <Card className="p-4">
          <p className="text-sm text-neutral-500">Eligible recipients</p>
          <p className="mt-1 text-2xl font-bold text-neutral-900">{loading ? '…' : eligibleRecipients}</p>
          <p className="mt-1 text-xs text-neutral-500">Opted-in customers with a valid Kenyan phone number.</p>
        </Card>
        <Card className="p-4">
          <p className="text-sm text-neutral-500">Campaign history</p>
          <p className="mt-1 text-2xl font-bold text-neutral-900">{loading ? '…' : history.length}</p>
          <p className="mt-1 text-xs text-neutral-500">Most recent 20 campaigns.</p>
        </Card>
        <Card className="p-4">
          <p className="text-sm text-neutral-500">Message length</p>
          <p className="mt-1 text-2xl font-bold text-neutral-900">{MAX_MESSAGE_LENGTH.toLocaleString()} characters</p>
          <p className="mt-1 text-xs text-neutral-500">Long messages may be split into multiple billable SMS parts by the provider.</p>
        </Card>
      </div>

      <Card className="space-y-5 p-5">
        <div>
          <h2 className="font-semibold text-neutral-900">Compose an SMS campaign</h2>
          <p className="mt-1 text-sm text-neutral-500">Keep messages clear. Add your shop link when useful; the recipient-specific opt-out link is appended automatically.</p>
        </div>
        <Input label="Campaign name (optional)" maxLength={100} value={name} onChange={event => setName(event.target.value)} placeholder="October new arrivals" />
        <div className="space-y-1.5">
          <label htmlFor="sms-campaign-message" className="block text-sm font-medium text-neutral-700">SMS message</label>
          <textarea id="sms-campaign-message" rows={8} maxLength={MAX_MESSAGE_LENGTH} value={message} onChange={event => { setMessage(event.target.value); setNotice(null); }} placeholder="Hello from HerStep Collection! Discover our latest arrivals at https://www.herstepcollection.shop/shop" className="w-full rounded-lg border border-neutral-300 bg-white px-3.5 py-2.5 text-sm focus:border-neutral-900" />
          <p className="text-xs text-neutral-500">{message.length.toLocaleString()}/{MAX_MESSAGE_LENGTH.toLocaleString()} characters. Opt-out link is appended at send time for each recipient.</p>
        </div>
        <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-4">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-neutral-500">Preview</p>
          <p className="whitespace-pre-wrap break-words text-sm text-neutral-800">{message || 'Your SMS preview appears here.'}</p>
          <p className="mt-3 border-t border-neutral-200 pt-3 text-xs text-neutral-500">Opt-out link will be added for each recipient. Essential order and payment SMS are unaffected by marketing preferences.</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="Send a test SMS to" value={testPhone} onChange={event => setTestPhone(event.target.value)} placeholder="071…, 01…, 254… or +254…" />
          <div className="flex items-end">
            <Button variant="outline" className="w-full" onClick={sendTest} disabled={!ready || !testPhone.trim() || working !== null}>{working === 'test' ? 'Sending test…' : 'Send test SMS'}</Button>
          </div>
        </div>
        <div className="space-y-3 rounded-lg border border-amber-200 bg-amber-50 p-4">
          <p className="text-sm text-amber-900">A real campaign sends to up to 100 opted-in customers. Long messages may cost more because carriers split them into multiple SMS parts.</p>
          <label className="flex items-start gap-2 text-sm text-neutral-800">
            <input type="checkbox" checked={confirmSend} onChange={event => setConfirmSend(event.target.checked)} className="mt-1 h-4 w-4" />
            <span>I reviewed this message and want to send it to all {eligibleRecipients} eligible SMS subscribers.</span>
          </label>
          <Button onClick={sendCampaign} disabled={!ready || !confirmSend || eligibleRecipients < 1 || working !== null}>{working === 'send' ? 'Queueing campaign…' : 'Send SMS campaign'}</Button>
        </div>
      </Card>

      <Card className="p-5">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div><h2 className="font-semibold text-neutral-900">SMS campaign history</h2><p className="mt-1 text-sm text-neutral-500">Delivery counts update while the send is running.</p></div>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>Refresh</Button>
        </div>
        {loading ? <p className="text-sm text-neutral-500">Loading campaign history…</p> : history.length === 0 ? <EmptyState title="No SMS campaigns yet" description="Sent campaign history will appear here." /> : (
          <div className="space-y-3">
            {history.map(campaign => (
              <div key={campaign.id} className="rounded-lg border border-neutral-200 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0"><p className="font-medium text-neutral-900">{campaign.name}</p><p className="mt-1 text-xs text-neutral-500">{formatDate(campaign.createdAt)}</p></div>
                  <Badge variant={campaign.status === 'SENT' ? 'success' : campaign.status === 'FAILED' ? 'danger' : 'info'}>{campaign.status}</Badge>
                </div>
                <p className="mt-3 text-sm text-neutral-600">{campaign.sent} sent · {campaign.failed} failed · {campaign.recipients} recipients</p>
                <p className="mt-2 whitespace-pre-wrap break-words text-xs text-neutral-500">{campaign.message}</p>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
