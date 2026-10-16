import { apiFetch } from './api';

export type RefundEvidence = { url: string; publicId: string; type: 'image' | 'video' };

export async function uploadRefundEvidence(files: File[]): Promise<RefundEvidence[]> {
  return Promise.all(files.map(async file => {
    const signed: any = await apiFetch('/api/refunds/sign-upload', {
      method: 'POST',
      body: JSON.stringify({ fileName: file.name, bytes: file.size, mimeType: file.type }),
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
    const response = await fetch(`https://api.cloudinary.com/v1_1/${signed.cloudName}/auto/upload`, { method: 'POST', body: form });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error?.message || 'Evidence upload failed. Please try again.');
    return {
      url: String(result.secure_url || ''),
      publicId: String(result.public_id || ''),
      type: result.resource_type === 'video' ? 'video' : 'image',
    };
  }));
}
