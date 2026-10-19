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
  const [editingId, setEditingId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [bulkCredits, setBulkCredits] = useState(0);
  const [bulkPhone, setBulkPhone] = useState('');
  const [bulkPayment, setBulkPayment] = useState<any>(null);
  const [bulkImages, setBulkImages] = useState<BulkImage[]>([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState('');
  const [bulkMessage, setBulkMessage] = useState('');

  async function refreshBulkCredits() {
    try {
      const result: any = await apiFetch('/api/sellers/bulk-upload');
      setBulkCredits(Number(result.credits) || 0);
    } catch { /* subscription or seller approval may not be active yet */ }
  }

  async function addBulkImages(files: FileList | null) {
    if (!files?.length) return;
    setBulkError(''); setBulkMessage('');
    const selected = Array.from(files);
    if (bulkImages.length + selected.length > 10) { setBulkError('A paid batch supports up to 10 product images. Remove some images before adding more.'); return; }
    if (selected.some(file => !/\.(jpe?g|png|webp)$/i.test(file.name) || file.size > 8 * 1024 * 1024)) { setBulkError('Use JPG, PNG, or WEBP images up to 8 MB each.'); return; }
    setBulkBusy(true);
    try {
      const uploaded = await Promise.all(selected.map(async file => ({ ...(await uploadProductImage(file)), key: `${file.name}-${file.size}-${file.lastModified}-${crypto.randomUUID()}`, fileName: file.name, state: 'ready' as const })));
      setBulkImages(old => [...old, ...uploaded]);
      setBulkMessage(`${uploaded.length} image(s) uploaded. Review them, then run AI analysis. Images are saved as private drafts only after successful analysis.`);
    } catch (err: any) { setBulkError(err?.message || 'Could not upload the batch images.'); }
    finally { setBulkBusy(false); }
  }

  async function buyBulkCredits() {
    if (!bulkPhone.trim()) { setBulkError('Enter the M-Pesa number that should receive the KSh 100 prompt.'); return; }
    setBulkBusy(true); setBulkError(''); setBulkMessage('');
    try {
      const result: any = await apiFetch('/api/sellers/bulk-upload', { method: 'POST', body: JSON.stringify({ action: 'purchase', phone: bulkPhone.trim(), idempotencyKey: `bulk-${crypto.randomUUID()}` }) });
      setBulkPayment(result.payment);
      setBulkMessage('Approve the KSh 100 M-Pesa prompt. Ten credits are added only after PrintPay confirms payment.');
    } catch (err: any) { setBulkError(err?.message || 'Could not start the credit purchase.'); }
    finally { setBulkBusy(false); }
  }

  async function checkBulkPayment() {
    if (!bulkPayment?.paymentId) return;
    setBulkBusy(true); setBulkError('');
    try {
      const result: any = await apiFetch(`/api/sellers/bulk-upload?paymentId=${encodeURIComponent(bulkPayment.paymentId)}`);
      setBulkPayment(result.payment); setBulkCredits(Number(result.credits) || 0);
      setBulkMessage(result.payment?.status === 'PAID' ? 'Payment verified. Ten AI bulk-upload credits are available.' : ['FAILED','CANCELLED','TIMEOUT'].includes(result.payment?.status) ? (result.payment.failureReason || `Payment status: ${result.payment.status}`) : 'Payment is still pending. Approve the prompt, then check again.');
    } catch (err: any) { setBulkError(err?.message || 'Could not check the payment status.'); }
    finally { setBulkBusy(false); }
  }

  async function analyseBulkImages() {
    const queue = bulkImages.filter(item => item.state === 'ready' || item.state === 'error');
    if (!queue.length) { setBulkError('Upload at least one image first.'); return; }
    if (queue.length > bulkCredits) { setBulkError(`You have ${bulkCredits} credits but selected ${queue.length} images. Purchase another batch or select fewer images.`); return; }
    setBulkBusy(true); setBulkError(''); setBulkMessage('');
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
          setBulkMessage(`Saved private draft ${completed} of ${queue.length}: ${result.product?.name || item.fileName}. Review it in My saved drafts.`);
          await load();
        } catch (err: any) {
          setBulkImages(old => old.map(row => row.key === item.key ? { ...row, state: 'error', error: err?.message || 'AI analysis failed; no credit was used.' } : row));
        }
      }
      setBulkMessage(completed ? `Finished: ${completed} private draft(s) created. Failed images remain available to retry; unsuccessful AI analysis does not consume credits.` : 'No drafts were created. Check the errors and retry later; failed analysis does not consume credits.');
      await refreshBulkCredits();
    } finally { setBulkBusy(false); }
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
          name, description, categoryId, sku: sku.toUpperCase(),
          price: Number(price),
          salePrice: salePrice.trim() ? Number(salePrice) : null,
          inventory: [{ size, quantity: Number(quantity), costPrice: costPrice.trim() ? Number(costPrice) : null }],
          images,
        }),
      });
      setDrafts(old => editingId ? old.map(item => item.id === editingId ? result.product : item) : [result.product, ...old]);
      setEditingId(null);
      setName(''); setDescription(''); setSku(''); setPrice(''); setSalePrice('');
      setQuantity('1'); setCostPrice(''); setImages([]);
      setMessage(editingId ? 'Private draft updated.' : 'Draft saved privately. It is not visible in the public shop.');
    } catch (err: any) {
      setError(err?.message || 'Could not save product draft.');
    } finally { setSaving(false); }
  }

  async function submitForReview(draft: Draft) {
    setError(''); setMessage('');
    try {
      const result: any = await apiFetch('/api/sellers/products', {
        method: 'PATCH',
        body: JSON.stringify({ id: draft.id, action: 'SUBMIT_FOR_REVIEW' }),
      });
      setDrafts(old => old.map(item => item.id === draft.id ? { ...item, status: 'PENDING_REVIEW' } : item));
      setMessage(result.message || 'Product submitted for admin review.');
    } catch (err: any) {
      setError(err?.message || 'Could not submit this product for review.');
    }
  }

  return (
    <main className="max-w-6xl mx-auto px-4 sm:px-6 py-8 sm:py-10">
      <div className="flex items-center justify-between gap-3 mb-6">
        <div>
          <Link to="/seller/dashboard" className="inline-flex items-center gap-2 text-sm text-neutral-600 hover:text-neutral-900 mb-3"><ArrowLeft className="w-4 h-4" /> Seller dashboard</Link>
          <p className="text-xs font-semibold tracking-wide text-neutral-500">HERSTEP MARKETPLACE</p>
          <h1 className="text-3xl font-bold text-neutral-900 mt-1">My products</h1>
          <p className="text-sm text-neutral-600 mt-2">Save drafts, then submit them for admin review when your paid seller plan is active. Approved listings are published by marketplace admin after plan-limit checks.</p>
        </div>
        <Button variant="outline" onClick={() => void load()} disabled={loading}><RefreshCw className="w-4 h-4 mr-2" /> Refresh</Button>
      </div>

      <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 mb-6">
        <strong>Draft mode only.</strong> Saving a product does not publish it, start billing, or make it visible to customers. Publishing will remain disabled until plan limits, subscription expiry, and moderation are enforced.
      </div>
      {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 mb-5">{error}</div>}
      {message && <div role="status" className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800 mb-5">{message}</div>}

      <Card className="p-5 sm:p-6 mb-6">
        <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
          <div className="flex-1">
            <h2 className="text-lg font-semibold text-neutral-900 flex items-center gap-2"><Sparkles className="w-5 h-5" /> AI bulk upload</h2>
            <p className="text-sm text-neutral-600 mt-1">KSh 100 buys 10 AI analysis credits. Upload up to 10 product photos, review the AI suggestions in private drafts, and set stock before submitting for moderation. Failed AI analysis does not use a credit.</p>
            <p className="text-sm font-semibold mt-3">Available credits: {bulkCredits}</p>
          </div>
          <div className="w-full md:max-w-sm">
            <label htmlFor="seller-bulk-phone" className="block text-sm font-medium mb-1.5">M-Pesa phone number</label>
            <input id="seller-bulk-phone" className={fieldClass} type="tel" autoComplete="tel" value={bulkPhone} onChange={e => setBulkPhone(e.target.value)} placeholder="07XXXXXXXX or +2547XXXXXXXX" />
            <Button className="w-full mt-2" onClick={buyBulkCredits} disabled={bulkBusy || bulkPayment?.status === 'PENDING'}><CreditCard className="w-4 h-4 mr-2" />{bulkBusy ? 'Please wait…' : 'Buy 10 credits · KSh 100'}</Button>
            {bulkPayment && <div className="mt-2 rounded-lg border p-3 text-sm"><p>Payment status: <strong>{bulkPayment.status}</strong></p>{bulkPayment.status === 'PENDING' && <Button variant="outline" className="w-full mt-2" onClick={checkBulkPayment} disabled={bulkBusy}><RefreshCw className="w-4 h-4 mr-2" />Check payment</Button>}</div>}
          </div>
        </div>
        <label className={`flex items-center justify-center gap-2 rounded-lg border border-dashed border-neutral-300 p-5 mt-5 text-sm cursor-pointer hover:bg-neutral-50 ${bulkBusy ? 'opacity-60 pointer-events-none' : ''}`}>
          {bulkBusy ? <Loader2 className="w-5 h-5 animate-spin" /> : <ImagePlus className="w-5 h-5" />}
          {bulkBusy ? 'Processing…' : `Choose product photos (${bulkImages.length}/10)`}
          <input type="file" className="sr-only" accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp" multiple disabled={bulkBusy || bulkImages.length >= 10} onChange={e => { void addBulkImages(e.target.files); e.currentTarget.value = ''; }} />
        </label>
        {bulkImages.length > 0 && <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mt-4">{bulkImages.map(item => <div key={item.key} className="rounded-lg border p-2 min-w-0"><img src={item.url} alt={item.fileName} className="aspect-square w-full object-cover rounded" /><p className="text-xs font-medium truncate mt-2" title={item.fileName}>{item.fileName}</p><p className="text-xs text-neutral-500 mt-1">{item.state === 'working' ? 'Analysing…' : item.state === 'error' ? 'Needs retry' : 'Ready'}</p>{item.error && <p className="text-xs text-red-700 mt-1">{item.error}</p>}<button type="button" className="text-xs underline mt-1" disabled={bulkBusy} onClick={() => setBulkImages(old => old.filter(row => row.key !== item.key))}>Remove</button></div>)}</div>}
        {bulkError && <p role="alert" className="text-sm text-red-700 mt-3">{bulkError}</p>}
        {bulkMessage && <p role="status" className="text-sm text-neutral-700 mt-3">{bulkMessage}</p>}
        <Button className="w-full mt-4" onClick={analyseBulkImages} disabled={bulkBusy || bulkImages.length === 0 || bulkCredits === 0}><Sparkles className="w-4 h-4 mr-2" />{bulkBusy ? 'Processing batch…' : 'Analyse photos and create private drafts'}</Button>
        <p className="text-xs text-neutral-500 mt-2">AI-created drafts are not published automatically. Verify the name, category, price and sizes, add inventory, and submit through the normal review process.</p>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6 items-start">
        <Card className="p-5 sm:p-6 lg:col-span-3">
          <h2 className="text-lg font-semibold text-neutral-900 flex items-center gap-2 mb-5"><PackagePlus className="w-5 h-5" /> {editingId ? 'Edit product draft' : 'Create product draft'}</h2>
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
              <div><label className="block text-sm font-medium mb-1.5" htmlFor="seller-product-size">Size / variant</label><select id="seller-product-size" className={fieldClass} value={size} onChange={e => setSize(e.target.value)}>{sizeOptions.map(s => <option key={s} value={s}>{s}</option>)}</select></div>
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
            <Button type="submit" disabled={saving || uploading || !images.length || !categories.length} className="w-full"><Save className="w-4 h-4 mr-2" />{saving ? 'Saving draft…' : editingId ? 'Update private draft' : 'Save private draft'}</Button>
            {editingId && <Button type="button" variant="outline" className="w-full" onClick={() => { setEditingId(null); setName(''); setDescription(''); setSku(''); setPrice(''); setSalePrice(''); setQuantity('1'); setCostPrice(''); setImages([]); }}>Cancel editing</Button>}
          </form>
        </Card>

        <section className="lg:col-span-2">
          <Card className="p-5 sm:p-6">
            <div className="flex items-center justify-between gap-3 mb-4"><h2 className="text-lg font-semibold">My saved drafts</h2><span className="text-xs rounded-full bg-neutral-100 px-2.5 py-1">{drafts.length}</span></div>
            {loading ? <p className="text-sm text-neutral-500 py-6 text-center">Loading drafts…</p> : drafts.length === 0 ? <div className="text-center py-8 text-sm text-neutral-500"><Store className="w-8 h-8 mx-auto mb-2 opacity-50" />No product drafts yet.</div> : <div className="space-y-3">{drafts.map(draft => <div key={draft.id} className="flex items-start gap-3 rounded-lg border border-neutral-200 p-3"><div className="rounded-lg bg-neutral-100 p-2"><PackagePlus className="w-5 h-5 text-neutral-600" /></div><div className="min-w-0 flex-1"><p className="font-medium text-sm break-words">{draft.name}</p><p className="text-xs text-neutral-500 mt-1">{money(draft.price)} · Seller listing</p><p className="text-xs text-neutral-500 mt-1">Status: {draft.status === 'PENDING_REVIEW' ? 'Awaiting admin review' : draft.status === 'APPROVED' ? 'Approved — awaiting publication' : draft.status === 'PUBLISHED' ? 'Published' : draft.status === 'REJECTED' ? 'Changes requested' : 'Private draft'}</p>{draft.status === 'REJECTED' && <p className="text-xs text-red-700 mt-1">Reason: {(draft as any).moderationReason || 'Please review and update your listing.'}</p>}<div className="flex flex-wrap gap-3 mt-2"><button type="button" className="text-sm font-medium underline" disabled={['PENDING_REVIEW','APPROVED','PUBLISHED'].includes(draft.status)} onClick={() => { setEditingId(draft.id); setName(draft.name); setDescription(draft.description || ''); setCategoryId(draft.categoryId); setSku(draft.sku || ''); setPrice(String(draft.price)); setSalePrice(draft.salePrice == null ? '' : String(draft.salePrice)); const first = draft.inventory?.[0]; setSize(first?.size || 'One Size'); setQuantity(String(first?.quantity ?? 1)); setCostPrice(first?.costPrice == null ? '' : String(first.costPrice)); setImages(draft.images || []); setError(''); setMessage('Editing a private draft.'); }}>Edit draft</button>{['DRAFT','REJECTED'].includes(draft.status) && <Button size="sm" disabled={!publishingEnabled} onClick={() => void submitForReview(draft)}>Submit for review</Button>}</div></div></div>)}</div>}
          </Card>
          <p className="text-xs text-neutral-500 mt-3">AI bulk upload creates private drafts. Product editing, stock management, moderation and publishing remain separate guarded steps.</p>
        </section>
      </div>
    </main>
  );
}
