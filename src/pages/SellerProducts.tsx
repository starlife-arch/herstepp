import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, ImagePlus, Loader2, PackagePlus, RefreshCw, Save, Store, Trash2 } from 'lucide-react';
import { Button, Card } from '../components/ui';
import { apiFetch } from '../lib/api';
import { usePageMeta } from '../hooks/usePageMeta';

type ImageItem = { url: string; publicId: string; resourceType: 'image' };
type Draft = { id: string; name: string; description?: string; categoryId: string; sku?: string; price: number; salePrice?: number | null; inventory?: { size: string; quantity: number; costPrice?: number | null }[]; images?: ImageItem[]; status: string; updatedAt?: string };
type Category = { id: string; name: string };

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
      if (!categoryId) {
        const first = Array.isArray(categoryResult) ? categoryResult[0] : categoryResult.categories?.[0];
        if (first?.id) setCategoryId(first.id);
      }
    } catch (err: any) {
      setError(err?.message || 'Could not load seller products.');
    } finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, []);

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

  return (
    <main className="max-w-6xl mx-auto px-4 sm:px-6 py-8 sm:py-10">
      <div className="flex items-center justify-between gap-3 mb-6">
        <div>
          <Link to="/seller/dashboard" className="inline-flex items-center gap-2 text-sm text-neutral-600 hover:text-neutral-900 mb-3"><ArrowLeft className="w-4 h-4" /> Seller dashboard</Link>
          <p className="text-xs font-semibold tracking-wide text-neutral-500">HERSTEP MARKETPLACE</p>
          <h1 className="text-3xl font-bold text-neutral-900 mt-1">My products</h1>
          <p className="text-sm text-neutral-600 mt-2">Create private drafts for review before seller listings are enabled.</p>
        </div>
        <Button variant="outline" onClick={() => void load()} disabled={loading}><RefreshCw className="w-4 h-4 mr-2" /> Refresh</Button>
      </div>

      <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 mb-6">
        <strong>Draft mode only.</strong> Saving a product does not publish it, start billing, or make it visible to customers. Publishing will remain disabled until plan limits, subscription expiry, and moderation are enforced.
      </div>
      {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 mb-5">{error}</div>}
      {message && <div role="status" className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800 mb-5">{message}</div>}

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
            {loading ? <p className="text-sm text-neutral-500 py-6 text-center">Loading drafts…</p> : drafts.length === 0 ? <div className="text-center py-8 text-sm text-neutral-500"><Store className="w-8 h-8 mx-auto mb-2 opacity-50" />No product drafts yet.</div> : <div className="space-y-3">{drafts.map(draft => <div key={draft.id} className="flex items-start gap-3 rounded-lg border border-neutral-200 p-3"><div className="rounded-lg bg-neutral-100 p-2"><PackagePlus className="w-5 h-5 text-neutral-600" /></div><div className="min-w-0 flex-1"><p className="font-medium text-sm break-words">{draft.name}</p><p className="text-xs text-neutral-500 mt-1">{money(draft.price)} · Private draft</p><p className="text-xs text-neutral-500 mt-1">Status: {draft.status}</p><button type="button" className="mt-2 text-sm font-medium underline" onClick={() => { setEditingId(draft.id); setName(draft.name); setDescription(draft.description || ''); setCategoryId(draft.categoryId); setSku(draft.sku || ''); setPrice(String(draft.price)); setSalePrice(draft.salePrice == null ? '' : String(draft.salePrice)); const first = draft.inventory?.[0]; setSize(first?.size || 'One Size'); setQuantity(String(first?.quantity ?? 1)); setCostPrice(first?.costPrice == null ? '' : String(first.costPrice)); setImages(draft.images || []); setError(''); setMessage('Editing a private draft.'); }}>Edit draft</button></div></div>)}</div>}
          </Card>
          <p className="text-xs text-neutral-500 mt-3">Product editing, multiple stock variants, bulk AI upload, and publishing will be added in later reviewed steps.</p>
        </section>
      </div>
    </main>
  );
}
