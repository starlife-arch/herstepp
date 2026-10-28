import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, ImagePlus, Loader2, PackagePlus, RefreshCw, Save, Store, Trash2, Sparkles, CreditCard } from 'lucide-react';
import { Button, Card } from '../components/ui';
import { apiFetch } from '../lib/api';
import { usePageMeta } from '../hooks/usePageMeta';

type ImageItem = { url: string; publicId: string; resourceType: 'image' };
type Draft = { id: string; name: string; description?: string; categoryId: string; sku?: string; price: number; salePrice?: number | null; inventory?: { size: string; quantity: number; costPrice?: number | null }[]; images?: ImageItem[]; status: string; updatedAt?: string };
type Category = { id: string; name: string };
type BulkImage = ImageItem & { key: string; fileName: string; state: 'ready' | 'working' | 'error'; error?: string };

const sizeOptions = [...Array.from({ length: 16 }, (_, i) => String(i + 30)), 'XS', 'S', 'M', 'L', 'XL', 'XXL', 'One Size', 'Free Size'];
const fieldClass = 'w-full rounded-lg border border-neutral-300 bg-white px-3 py-2.5 text-sm text-neutral-900 focus:outline-none focus:ring-2 focus:ring-neutral-400';
const money = (amount: number) => new Intl.NumberFormat('en-KE', { style: 'currency', currency: 'KES', maximumFractionDigits: 0 }).format(amount);

async function uploadProductImage(file: File): Promise<ImageItem> {
  const signed: any = await apiFetch('/api/sellers/products/sign-upload', {
    method: 'POST',
    body: JSON.stringify({ fileName: file.name, bytes: file.size }),
  });
  const form = new FormData();
  Object.entries({
    api_key: signed.apiKey,
    allowed_formats: signed.allowedFormats.join(','),
    folder: signed.folder,
    public_id: signed.publicId,
    timestamp: String(signed.timestamp),
    signature: signed.signature,
  }).forEach(([key, value]) => form.append(key, String(value)));
  form.append('file', file);
  const response = await fetch(`https://api.cloudinary.com/v1_1/${signed.cloudName}/image/upload`, { method: 'POST', body: form });
  const result: any = await response.json().catch(() => ({}));
  if (!response.ok || !result.secure_url || !result.public_id) throw new Error(result.error?.message || 'Image upload failed.');
  return { url: result.secure_url, publicId: result.public_id, resourceType: 'image' };
}

export default function SellerProducts() {
  usePageMeta('Seller Products | HerStep Collection', 'Create and manage private product drafts for the HerStep marketplace.');
  const [categories, setCategories] = useState<Category[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [publishingEnabled, setPublishingEnabled] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [sku, setSku] = useState('');
  const [price, setPrice] = useState('');
  const [salePrice, setSalePrice] = useState('');
  const [size, setSize] = useState('One Size');
  const [quantity, setQuantity] = useState('1');
  const [costPrice, setCostPrice] = useState('');
  const [images, setImages] = useState<ImageItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [publishingIds, setPublishingIds] = useState<string[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingPublished, setEditingPublished] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [bulkCredits, setBulkCredits] = useState(0);
  const [sellerRewardInfo, setSellerRewardInfo] = useState<any>(null);
  const [rewardPointsToRedeem, setRewardPointsToRedeem] = useState('100');
  const [rewardRedeemBusy, setRewardRedeemBusy] = useState(false);
  const [bulkPhone, setBulkPhone] = useState('');
  const [bulkPackage, setBulkPackage] = useState('50');
  const [customBulkCredits, setCustomBulkCredits] = useState('');
  const selectedBulkCredits = bulkPackage === 'custom' ? Number(customBulkCredits) : Number(bulkPackage);
  const selectedBulkAmount = selectedBulkCredits * 10;
  const [bulkPayment, setBulkPayment] = useState<any>(null);
  const [bulkImages, setBulkImages] = useState<BulkImage[]>([]);
  const [bulkUploadBusy, setBulkUploadBusy] = useState(false);
  const [bulkPaymentBusy, setBulkPaymentBusy] = useState(false);
  const [bulkCheckBusy, setBulkCheckBusy] = useState(false);
  const [bulkAnalyseBusy, setBulkAnalyseBusy] = useState(false);
  const [bulkError, setBulkError] = useState('');
  const [bulkMessage, setBulkMessage] = useState('');

  async function refreshBulkCredits() {
    try {
      const [result, rewards]: any[] = await Promise.all([
        apiFetch('/api/sellers/bulk-upload'),
        apiFetch('/api/rewards'),
      ]);
      setBulkCredits(Number(result.credits) || 0);
      setSellerRewardInfo(rewards);
    } catch { /* subscription or seller approval may not be active yet */ }
  }

  async function redeemSellerPointsForAiCredits() {
    const points = Number(rewardPointsToRedeem);
    if (!Number.isSafeInteger(points) || points < 100 || points % 100 !== 0) {
      setBulkError('Enter at least 100 points, in multiples of 100.');
      return;
    }
    if (!sellerRewardInfo?.redemptionEnabled || !sellerRewardInfo?.enabled) {
      setBulkError('Seller reward redemption is not enabled yet. Contact the administrator.');
      return;
    }
    if (points > Number(sellerRewardInfo.pointsBalance || 0)) {
      setBulkError('You do not have enough available reward points.');
      return;
    }
    setRewardRedeemBusy(true); setBulkError(''); setBulkMessage('');
    try {
      const result: any = await apiFetch('/api/sellers/bulk-upload', {
        method: 'POST',
        body: JSON.stringify({ action: 'redeemRewards', points, idempotencyKey: `ai-reward-${crypto.randomUUID()}` }),
      });
      setBulkCredits(Number(result.credits) || bulkCredits);
      setRewardPointsToRedeem('100');
      setBulkMessage(result.message || 'Reward points redeemed for AI credits.');
      await refreshBulkCredits();
    } catch (err: any) {
      setBulkError(err?.message || 'Could not redeem reward points for AI credits.');
    } finally { setRewardRedeemBusy(false); }
  }

  async function addBulkImages(files: FileList | null) {
    if (!files?.length) return;
    setBulkError(''); setBulkMessage('');
    const selected = Array.from(files);
    if (bulkImages.length + selected.length > 100) { setBulkError('You can queue up to 100 product images at a time. Remove some images before adding more.'); return; }
    if (selected.some(file => !/\.(jpe?g|png|webp)$/i.test(file.name) || file.size > 8 * 1024 * 1024)) { setBulkError('Use JPG, PNG, or WEBP images up to 8 MB each.'); return; }
    setBulkUploadBusy(true);
    try {
      const uploaded = await Promise.all(selected.map(async file => ({ ...(await uploadProductImage(file)), key: `${file.name}-${file.size}-${file.lastModified}-${crypto.randomUUID()}`, fileName: file.name, state: 'ready' as const })));
      setBulkImages(old => [...old, ...uploaded]);
      setBulkMessage(`${uploaded.length} image(s) uploaded. Review them, then run AI analysis. Images are saved as private drafts only after successful analysis.`);
    } catch (err: any) { setBulkError(err?.message || 'Could not upload the batch images.'); }
    finally { setBulkUploadBusy(false); }
  }

  async function buyBulkCredits() {
    if (!Number.isInteger(selectedBulkCredits) || selectedBulkCredits < 10 || selectedBulkCredits > 10000) { setBulkError('Choose at least 10 credits and no more than 10,000 credits.'); return; }
    if (!bulkPhone.trim()) { setBulkError(`Enter the M-Pesa number that should receive the KSh ${selectedBulkAmount.toLocaleString('en-KE')} prompt.`); return; }
    setBulkPaymentBusy(true); setBulkError(''); setBulkMessage('');
    try {
      const result: any = await apiFetch('/api/sellers/bulk-upload', { method: 'POST', body: JSON.stringify({ action: 'purchase', phone: bulkPhone.trim(), credits: selectedBulkCredits, idempotencyKey: `bulk-${crypto.randomUUID()}` }) });
      setBulkPayment(result.payment);
      setBulkMessage(`Approve the KSh ${selectedBulkAmount.toLocaleString('en-KE')} M-Pesa prompt. ${selectedBulkCredits.toLocaleString('en-KE')} credits are added only after payment is confirmed.`);
    } catch (err: any) { setBulkError(err?.message || 'Could not start the credit purchase.'); }
    finally { setBulkPaymentBusy(false); }
  }

  async function checkBulkPayment() {
    if (!bulkPayment?.paymentId) return;
    setBulkCheckBusy(true); setBulkError('');
    try {
      const result: any = await apiFetch(`/api/sellers/bulk-upload?paymentId=${encodeURIComponent(bulkPayment.paymentId)}`);
      setBulkPayment(result.payment); setBulkCredits(Number(result.credits) || 0);
      setBulkMessage(result.payment?.status === 'PAID' ? `Payment verified. ${Number(result.payment?.credits || selectedBulkCredits).toLocaleString('en-KE')} AI bulk-upload credits are available.` : ['FAILED','CANCELLED','TIMEOUT'].includes(result.payment?.status) ? (result.payment.failureReason || `Payment status: ${result.payment.status}`) : 'Payment is still pending. Approve the prompt, then check again.');
    } catch (err: any) { setBulkError(err?.message || 'Could not check the payment status.'); }
    finally { setBulkCheckBusy(false); }
  }

  async function analyseBulkImages() {
    const queue = bulkImages.filter(item => item.state === 'ready' || item.state === 'error');
    if (!queue.length) { setBulkError('Upload at least one image first.'); return; }
    if (queue.length > bulkCredits) { setBulkError(`You have ${bulkCredits} credits but selected ${queue.length} images. Purchase another batch or select fewer images.`); return; }
    setBulkAnalyseBusy(true); setBulkError(''); setBulkMessage('');
    let completed = 0;
    let attempted = 0;
    try {
      for (const item of queue) {
        if (attempted > 0) { setBulkMessage(`Rate-limit protection: waiting before analysing item ${attempted + 1} of ${queue.length}…`); await new Promise(resolve => setTimeout(resolve, 22000)); }
        attempted++;
        setBulkImages(old => old.map(row => row.key === item.key ? { ...row, state: 'working', error: undefined } : row));
        try {
          const result: any = await apiFetch('/api/sellers/bulk-upload', { method: 'POST', body: JSON.stringify({ action: 'analyze', imageUrl: item.url, publicId: item.publicId, fileName: item.fileName }) });
          setBulkCredits(Number(result.creditsRemaining) >= 0 ? Number(result.creditsRemaining) : Math.max(0, bulkCredits - 1));
          setBulkImages(old => old.filter(row => row.key !== item.key));
          completed++;
          setBulkMessage(`Saved private draft ${completed} of ${queue.length}: ${result.product?.name || item.fileName}. Review it in My products and drafts.`);
          await load();
        } catch (err: any) {
          setBulkImages(old => old.map(row => row.key === item.key ? { ...row, state: 'error', error: err?.message || 'AI analysis failed; no credit was used.' } : row));
        }
      }
      setBulkMessage(completed ? `Finished: ${completed} private draft(s) created. Failed images remain available to retry; unsuccessful AI analysis does not consume credits.` : 'No drafts were created. Check the errors and retry later; failed analysis does not consume credits.');
      await refreshBulkCredits();
    } finally { setBulkAnalyseBusy(false); }
  }

  async function load() {
    setLoading(true);
    setError('');
    try {
      const [categoryResult, productResult]: any[] = await Promise.all([
        apiFetch('/api/categories'),
        apiFetch('/api/sellers/products'),
      ]);
      setCategories(Array.isArray(categoryResult) ? categoryResult : categoryResult.categories || []);
      setDrafts(productResult.products || []);
      setPublishingEnabled(productResult.publishingEnabled === true);
      if (!categoryId) {
        const first = Array.isArray(categoryResult) ? categoryResult[0] : categoryResult.categories?.[0];
        if (first?.id) setCategoryId(first.id);
      }
    } catch (err: any) {
      setError(err?.message || 'Could not load seller products.');
    } finally { setLoading(false); }
  }

  useEffect(() => { void load(); void refreshBulkCredits(); }, []);

  async function addImages(files: FileList | null) {
    if (!files?.length) return;
    setError(''); setMessage('');
    const selected = Array.from(files);
    if (images.length + selected.length > 8) { setError('You can attach up to 8 images per draft.'); return; }
    if (selected.some(file => !/\.(jpe?g|png|webp)$/i.test(file.name) || file.size > 8 * 1024 * 1024)) {
      setError('Use JPG, PNG, or WEBP images up to 8 MB each.'); return;
    }
    setUploading(true);
    try {
      const uploaded = await Promise.all(selected.map(uploadProductImage));
      setImages(old => [...old, ...uploaded]);
      setMessage(`${uploaded.length} image(s) uploaded.`);
    } catch (err: any) {
      setError(err?.message || 'Could not upload images.');
    } finally { setUploading(false); }
  }

  async function saveDraft(event: React.FormEvent) {
    event.preventDefault(); setSaving(true); setError(''); setMessage('');
    try {
      const result: any = await apiFetch('/api/sellers/products', {
        method: editingId ? 'PATCH' : 'POST',
        body: JSON.stringify({
          ...(editingId ? { id: editingId } : {}),
          ...(editingPublished ? { action: 'UPDATE_PUBLISHED' } : {}),
          name, description, categoryId, sku: sku.toUpperCase(),
          price: Number(price),
          salePrice: salePrice.trim() ? Number(salePrice) : null,
          inventory: [{ size, quantity: Number(quantity), costPrice: costPrice.trim() ? Number(costPrice) : null }],
          images,
        }),
      });
      if (editingId) {
        // Refresh from the API because a published listing's public ID may
        // differ from the sellerProducts mirror document ID.
        await load();
      } else {
        setDrafts(old => [result.product, ...old]);
      }
      setEditingId(null); setEditingPublished(false);
      setName(''); setDescription(''); setSku(''); setPrice(''); setSalePrice('');
      setQuantity('1'); setCostPrice(''); setImages([]);
      setMessage(editingPublished ? 'Published listing updated successfully.' : editingId ? 'Private draft updated.' : 'Draft saved privately. It is not visible in the public shop.');
    } catch (err: any) {
      setError(err?.message || 'Could not save product draft.');
    } finally { setSaving(false); }
  }

  async function submitForReview(draft: Draft) {
    setError(''); setMessage('');
    setPublishingIds(old => [...old, draft.id]);
    try {
      const result: any = await apiFetch('/api/sellers/products', {
        method: 'PATCH',
        body: JSON.stringify({ id: draft.id, action: 'PUBLISH' }),
      });
      setDrafts(old => old.map(item => item.id === draft.id ? { ...item, ...(result.product || {}), status: result.product?.status || 'PUBLISHED' } : item));
      setMessage(result.message || `Published ${draft.name} successfully.`);
    } catch (err: any) {
      setError(err?.message || `Could not publish ${draft.name}.`);
    } finally {
      setPublishingIds(old => old.filter(id => id !== draft.id));
    }
  }

  return (
    <main className="max-w-6xl mx-auto px-4 sm:px-6 py-8 sm:py-10">
      <div className="flex items-center justify-between gap-3 mb-6">
        <div>
          <Link to="/seller/dashboard" className="inline-flex items-center gap-2 text-sm text-neutral-600 hover:text-neutral-900 mb-3"><ArrowLeft className="w-4 h-4" /> Seller dashboard</Link>
          <p className="text-xs font-semibold tracking-wide text-neutral-500">HERSTEP MARKETPLACE</p>
          <h1 className="text-3xl font-bold text-neutral-900 mt-1">My products</h1>
          <p className="text-sm text-neutral-600 mt-2">Save private drafts, then publish eligible listings directly. Routine admin approval is not required; automated checks and marketplace moderation still apply.</p>
        </div>
        <Button variant="outline" onClick={() => void load()} disabled={loading}><RefreshCw className="w-4 h-4 mr-2" /> Refresh</Button>
      </div>

      <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 mb-6">
        <strong>Private drafts stay hidden until you publish them. Routine listings publish without manual admin approval; marketplace moderation still applies. Published listings can be edited while your paid seller plan is active.</strong>
      </div>
      {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 mb-5">{error}</div>}
      {message && <div role="status" className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800 mb-5">{message}</div>}

      <Card className="p-5 sm:p-6 mb-6">
        <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
          <div className="flex-1">
            <h2 className="text-lg font-semibold text-neutral-900 flex items-center gap-2"><Sparkles className="w-5 h-5" /> AI bulk upload</h2>
            <p className="text-sm text-neutral-600 mt-1">Buy AI analysis credits at KSh 10 per credit. Each credit analyses one product photo. AI creates private drafts with a starting stock quantity of 1 per detected size. Review stock before publishing; failed AI analysis does not use a credit.</p>
            <p className="text-sm font-semibold mt-3">Available credits: {bulkCredits}</p>
          </div>
          <div className="w-full md:max-w-sm">
            <label htmlFor="seller-bulk-phone" className="block text-sm font-medium mb-1.5">M-Pesa phone number</label>
            <div className="mt-3">
              <p className="block text-sm font-semibold text-neutral-800 mb-2">Choose your AI token package</p>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2" role="group" aria-label="AI token packages">
                {[
                  { credits: '50', price: 'KSh 500' },
                  { credits: '100', price: 'KSh 1,000' },
                  { credits: '200', price: 'KSh 2,000' },
                  { credits: '500', price: 'KSh 5,000' },
                  { credits: '1000', price: 'KSh 10,000' },
                ].map(option => (
                  <button key={option.credits} type="button" aria-pressed={bulkPackage === option.credits} onClick={() => setBulkPackage(option.credits)} className={`rounded-xl border-2 p-3 text-left transition-colors ${bulkPackage === option.credits ? 'border-orange-600 bg-orange-50 ring-2 ring-orange-100' : 'border-neutral-200 bg-white hover:border-orange-300'}`}>
                    <span className="block text-base font-bold text-neutral-900">{Number(option.credits).toLocaleString('en-KE')} tokens</span>
                    <span className="block text-sm text-neutral-600 mt-1">{option.price}</span>
                    {bulkPackage === option.credits && <span className="block text-xs font-semibold text-orange-700 mt-1">Selected</span>}
                  </button>
                ))}
                <button type="button" aria-pressed={bulkPackage === 'custom'} onClick={() => setBulkPackage('custom')} className={`rounded-xl border-2 border-dashed p-3 text-left transition-colors ${bulkPackage === 'custom' ? 'border-orange-600 bg-orange-50 ring-2 ring-orange-100' : 'border-neutral-300 bg-neutral-50 hover:border-orange-300'}`}>
                  <span className="block text-base font-bold text-neutral-900">Custom amount</span>
                  <span className="block text-sm text-neutral-600 mt-1">Choose your own</span>
                  {bulkPackage === 'custom' && <span className="block text-xs font-semibold text-orange-700 mt-1">Selected</span>}
                </button>
              </div>
              {bulkPackage === 'custom' && <input aria-label="Custom AI token amount" className={fieldClass + " mt-2"} type="number" min="10" max="10000" step="1" value={customBulkCredits} onChange={e => setCustomBulkCredits(e.target.value)} placeholder="Enter tokens (10–10,000)" />}
            </div>
            <p className="text-sm text-neutral-600 mt-2">Total: <strong>{Number.isInteger(selectedBulkCredits) && selectedBulkCredits >= 10 && selectedBulkCredits <= 10000 ? money(selectedBulkAmount) : 'Enter a valid amount'}</strong></p>
            <input id="seller-bulk-phone" className={fieldClass + " mt-2"} type="tel" autoComplete="tel" value={bulkPhone} onChange={e => setBulkPhone(e.target.value)} placeholder="07XXXXXXXX or +2547XXXXXXXX" />
            <Button className="w-full mt-2" onClick={buyBulkCredits} disabled={bulkPaymentBusy || bulkPayment?.status === 'PENDING'}><CreditCard className="w-4 h-4 mr-2" />{bulkPaymentBusy ? 'Please wait…' : `Buy ${Number.isInteger(selectedBulkCredits) && selectedBulkCredits > 0 ? selectedBulkCredits.toLocaleString('en-KE') : 'credits'} · ${money(selectedBulkAmount || 0)}`}</Button>
            <div className="mt-3 rounded-lg border border-neutral-200 p-3">
              <p className="text-sm font-semibold text-neutral-900">Use seller reward points</p>
              <p className="mt-1 text-xs text-neutral-600">100 points = KSh 10 = 1 AI credit. This is separate from M-Pesa purchases.</p>
              <p className="mt-1 text-xs text-neutral-600">Available: {Number(sellerRewardInfo?.pointsBalance || 0).toLocaleString('en-KE')} points ({money(Number(sellerRewardInfo?.estimatedValueKes || 0))} estimated value)</p>
              <div className="mt-2 flex gap-2">
                <input aria-label="Reward points to redeem for AI credits" type="number" min="100" step="100" value={rewardPointsToRedeem} onChange={e => setRewardPointsToRedeem(e.target.value)} className={fieldClass + " min-w-0"} />
                <Button onClick={redeemSellerPointsForAiCredits} disabled={rewardRedeemBusy || !sellerRewardInfo?.redemptionEnabled || Number(sellerRewardInfo?.pointsBalance || 0) < 100}>
                  {rewardRedeemBusy ? 'Redeeming…' : 'Redeem points'}
                </Button>
              </div>
              {!sellerRewardInfo?.redemptionEnabled && <p className="mt-2 text-xs text-amber-700">Reward redemption is currently disabled by the administrator.</p>}
            </div>
            {bulkPayment && <div className="mt-2 rounded-lg border p-3 text-sm"><p>Payment status: <strong>{bulkPayment.status}</strong></p>{bulkPayment.status === 'PENDING' && <Button variant="outline" className="w-full mt-2" onClick={checkBulkPayment} disabled={bulkCheckBusy}><RefreshCw className="w-4 h-4 mr-2" />Check payment</Button>}</div>}
          </div>
        </div>
        <label className={`flex items-center justify-center gap-2 rounded-lg border border-dashed border-neutral-300 p-5 mt-5 text-sm cursor-pointer hover:bg-neutral-50 ${bulkUploadBusy ? 'opacity-60 pointer-events-none' : ''}`}>
          {bulkUploadBusy ? <Loader2 className="w-5 h-5 animate-spin" /> : <ImagePlus className="w-5 h-5" />}
          {bulkUploadBusy ? 'Processing…' : `Choose product photos (${bulkImages.length}/10)`}
          <input type="file" className="sr-only" accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp" multiple disabled={bulkUploadBusy || bulkImages.length >= 10} onChange={e => { void addBulkImages(e.target.files); e.currentTarget.value = ''; }} />
        </label>
        {bulkImages.length > 0 && <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mt-4">{bulkImages.map(item => <div key={item.key} className="rounded-lg border p-2 min-w-0"><img src={item.url} alt={item.fileName} className="aspect-square w-full object-cover rounded" /><p className="text-xs font-medium truncate mt-2" title={item.fileName}>{item.fileName}</p><p className="text-xs text-neutral-500 mt-1">{item.state === 'working' ? 'Analysing…' : item.state === 'error' ? 'Needs retry' : 'Ready'}</p>{item.error && <p className="text-xs text-red-700 mt-1">{item.error}</p>}<button type="button" className="text-xs underline mt-1" disabled={bulkUploadBusy} onClick={() => setBulkImages(old => old.filter(row => row.key !== item.key))}>Remove</button></div>)}</div>}
        {bulkError && <p role="alert" className="text-sm text-red-700 mt-3">{bulkError}</p>}
        {bulkMessage && <p role="status" className="text-sm text-neutral-700 mt-3">{bulkMessage}</p>}
        <Button className="w-full mt-4" onClick={analyseBulkImages} disabled={bulkAnalyseBusy || bulkImages.length === 0 || bulkCredits === 0}><Sparkles className="w-4 h-4 mr-2" />{bulkAnalyseBusy ? 'Processing batch…' : 'Analyse photos and create private drafts'}</Button>
        <p className="text-xs text-neutral-500 mt-2">AI-created drafts stay private until you choose Publish listing. Check the name, category, price, sizes and stock first. Eligible listings publish immediately; admins can still moderate listings that break marketplace rules.</p>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6 items-start">
        <Card className="p-5 sm:p-6 lg:col-span-3">
          <h2 className="text-lg font-semibold text-neutral-900 flex items-center gap-2 mb-5"><PackagePlus className="w-5 h-5" /> {editingPublished ? 'Edit published product' : editingId ? 'Edit product draft' : 'Create product draft'}</h2>
          <form onSubmit={saveDraft} className="space-y-4">
            <div><label className="block text-sm font-medium mb-1.5" htmlFor="seller-product-name">Product name</label><input id="seller-product-name" className={fieldClass} value={name} onChange={e => setName(e.target.value)} maxLength={160} required placeholder="e.g. Satin evening dress" /></div>
            <div><label className="block text-sm font-medium mb-1.5" htmlFor="seller-product-description">Description</label><textarea id="seller-product-description" className={fieldClass} value={description} onChange={e => setDescription(e.target.value)} maxLength={4000} rows={3} placeholder="Describe the product, material, fit, and care." /></div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div><label className="block text-sm font-medium mb-1.5" htmlFor="seller-product-category">Category</label><select id="seller-product-category" className={fieldClass} value={categoryId} onChange={e => setCategoryId(e.target.value)} required><option value="">Choose category</option>{categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
              <div><label className="block text-sm font-medium mb-1.5" htmlFor="seller-product-sku">Seller SKU</label><input id="seller-product-sku" className={fieldClass} value={sku} onChange={e => setSku(e.target.value.toUpperCase())} maxLength={80} required placeholder="e.g. DRESS-001" /></div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div><label className="block text-sm font-medium mb-1.5" htmlFor="seller-product-price">Price (KSh)</label><input id="seller-product-price" className={fieldClass} type="number" min="0" step="1" value={price} onChange={e => setPrice(e.target.value)} required /></div>
              <div><label className="block text-sm font-medium mb-1.5" htmlFor="seller-product-sale-price">Sale price (optional)</label><input id="seller-product-sale-price" className={fieldClass} type="number" min="0" step="1" value={salePrice} onChange={e => setSalePrice(e.target.value)} /></div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div><label className="block text-sm font-medium mb-1.5" htmlFor="seller-product-size">Size / variant</label><select id="seller-product-size" className={fieldClass} value={size} onChange={e => {
                const nextSize = e.target.value;
                setSize(nextSize);
                if (editingPublished && editingId) {
                  const currentProduct = drafts.find(item => item.id === editingId);
                  const variant = currentProduct?.inventory?.find(item => item.size === nextSize);
                  setQuantity(String(variant?.quantity ?? 1));
                  setCostPrice(variant?.costPrice == null ? '' : String(variant.costPrice));
                }
              }}>{sizeOptions.map(s => <option key={s} value={s}>{s}</option>)}</select>{editingPublished && <p className="text-xs text-neutral-500 mt-1">Choose an existing size to edit its stock, or choose a new size to add a variant.</p>}</div>
              <div><label className="block text-sm font-medium mb-1.5" htmlFor="seller-product-quantity">Quantity</label><input id="seller-product-quantity" className={fieldClass} type="number" min="0" step="1" value={quantity} onChange={e => setQuantity(e.target.value)} required /></div>
              <div><label className="block text-sm font-medium mb-1.5" htmlFor="seller-product-cost">Cost (optional)</label><input id="seller-product-cost" className={fieldClass} type="number" min="0" step="1" value={costPrice} onChange={e => setCostPrice(e.target.value)} /></div>
            </div>
            <div>
              <div className="flex items-center justify-between gap-3 mb-2"><label className="block text-sm font-medium">Product images (up to 8)</label><span className="text-xs text-neutral-500">{images.length}/8 uploaded</span></div>
              <label className={`flex items-center justify-center gap-2 rounded-lg border border-dashed border-neutral-300 p-5 text-sm cursor-pointer hover:bg-neutral-50 ${uploading ? 'opacity-60 pointer-events-none' : ''}`}>
                {uploading ? <Loader2 className="w-5 h-5 animate-spin" /> : <ImagePlus className="w-5 h-5" />}
                {uploading ? 'Uploading images…' : 'Choose JPG, PNG, or WEBP images'}
                <input type="file" className="sr-only" accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp" multiple disabled={uploading || images.length >= 8} onChange={e => { void addImages(e.target.files); e.currentTarget.value = ''; }} />
              </label>
              {images.length > 0 && <div className="grid grid-cols-3 sm:grid-cols-4 gap-3 mt-3">{images.map((image, index) => <div key={image.publicId} className="relative"><img src={image.url} alt={`Product upload ${index + 1}`} className="aspect-square w-full object-cover rounded-lg border" /><button type="button" onClick={() => setImages(old => old.filter((_, i) => i !== index))} className="absolute top-1 right-1 rounded-full bg-white p-1 shadow" aria-label="Remove image"><Trash2 className="w-4 h-4 text-red-600" /></button></div>)}</div>}
            </div>
            <Button type="submit" disabled={saving || uploading || !images.length || !categories.length} className="w-full"><Save className="w-4 h-4 mr-2" />{saving ? 'Saving…' : editingPublished ? 'Update published product' : editingId ? 'Update private draft' : 'Save private draft'}</Button>
            {editingId && <Button type="button" variant="outline" className="w-full" onClick={() => { setEditingId(null); setEditingPublished(false); setName(''); setDescription(''); setSku(''); setPrice(''); setSalePrice(''); setQuantity('1'); setCostPrice(''); setImages([]); }}>Cancel editing</Button>}
          </form>
        </Card>

        <section className="lg:col-span-2">
          <Card className="p-5 sm:p-6">
            <div className="flex items-center justify-between gap-3 mb-4"><h2 className="text-lg font-semibold">My saved drafts</h2><span className="text-xs rounded-full bg-neutral-100 px-2.5 py-1">{drafts.length}</span></div>
            {loading ? <p className="text-sm text-neutral-500 py-6 text-center">Loading drafts…</p> : drafts.length === 0 ? <div className="text-center py-8 text-sm text-neutral-500"><Store className="w-8 h-8 mx-auto mb-2 opacity-50" />No products or drafts yet.</div> : <div className="space-y-3">{drafts.map(draft => <div key={draft.id} className="flex items-start gap-3 rounded-lg border border-neutral-200 p-3"><div className="rounded-lg bg-neutral-100 p-2"><PackagePlus className="w-5 h-5 text-neutral-600" /></div><div className="min-w-0 flex-1"><p className="font-medium text-sm break-words">{draft.name}</p><p className="text-xs text-neutral-500 mt-1">{money(draft.price)} · Seller listing</p><p className="text-xs text-neutral-500 mt-1">Status: {draft.status === 'PENDING_REVIEW' ? 'Legacy listing awaiting review' : draft.status === 'APPROVED' ? 'Approved — awaiting publication' : draft.status === 'PUBLISHED' ? 'Published' : draft.status === 'REJECTED' ? 'Changes requested' : 'Private draft'}</p>{draft.status === 'REJECTED' && <p className="text-xs text-red-700 mt-1">Reason: {(draft as any).moderationReason || 'Please review and update your listing.'}</p>}<div className="flex flex-wrap gap-3 mt-2"><button type="button" className="text-sm font-medium underline" disabled={['PENDING_REVIEW','APPROVED'].includes(draft.status) || (draft.status === 'PUBLISHED' && !publishingEnabled)} onClick={() => { setEditingId(draft.id); setEditingPublished(draft.status === 'PUBLISHED'); setName(draft.name); setDescription(draft.description || ''); setCategoryId(draft.categoryId); setSku(draft.sku || ''); setPrice(String(draft.price)); setSalePrice(draft.salePrice == null ? '' : String(draft.salePrice)); const first = draft.inventory?.[0]; setSize(first?.size || 'One Size'); setQuantity(String(first?.quantity ?? 1)); setCostPrice(first?.costPrice == null ? '' : String(first.costPrice)); setImages(draft.images || []); setError(''); setMessage(draft.status === 'PUBLISHED' ? 'Editing a live marketplace listing.' : 'Editing a private draft.'); }}>{draft.status === 'PUBLISHED' ? 'Edit published product' : 'Edit draft'}</button>{['DRAFT','REJECTED'].includes(draft.status) && <Button size="sm" disabled={!publishingEnabled || publishingIds.includes(draft.id)} onClick={() => void submitForReview(draft)}>{publishingIds.includes(draft.id) ? 'Publishing…' : 'Publish listing'}</Button>}</div></div></div>)}</div>}
          </Card>
          <p className="text-xs text-neutral-500 mt-3">AI bulk upload creates private drafts. Product editing, stock management, moderation and publishing remain separate guarded steps.</p>
        </section>
      </div>
    </main>
  );
}
