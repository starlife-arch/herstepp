import crypto from 'node:crypto';
import { requireUser } from '../firebase-admin.js';
import { clientError, methodNotAllowed } from '../http.js';

const imageFormats = ["jpg","jpeg","png","webp","gif","bmp","tif","tiff","avif","heic","heif","ico"];
const videoFormats = ['mp4', 'mov', 'webm', 'm4v'];
const formats = [...imageFormats, ...videoFormats];
const hits = new Map();

export default async function signRefundEvidenceUpload(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
  const user = await requireUser(req);
  const { fileName, bytes, mimeType } = req.body || {};
  const now = Date.now();
  const requests = (hits.get(user.uid) || []).filter(at => now - at < 3600000);
  if (requests.length >= 20) throw clientError('Too many upload requests. Please try again later.', 429);
  const extension = typeof fileName === 'string' ? fileName.split('.').pop().toLowerCase() : '';
  const normalizedMime = String(mimeType || '').toLowerCase();
  const isImage = imageFormats.includes(extension) && (normalizedMime.startsWith('image/') || normalizedMime === '' || normalizedMime === 'application/octet-stream');
  const isVideo = videoFormats.includes(extension) && ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v'].includes(String(mimeType || ''));
  const maxBytes = isVideo ? 20 * 1024 * 1024 : 5 * 1024 * 1024;
  if ((!isImage && !isVideo) || !Number.isInteger(bytes) || bytes < 1 || bytes > maxBytes) {
    throw clientError('Attach a supported photo or screenshot (JPEG, PNG, WebP, GIF, BMP, TIFF, AVIF, HEIC/HEIF or ICO) up to 5 MB, or MP4, MOV, WebM or M4V video up to 20 MB.');
  }
  const cloudName = String(process.env.CLOUDINARY_CLOUD_NAME || '').trim();
  const apiKey = String(process.env.CLOUDINARY_API_KEY || '').trim();
  const secret = String(process.env.CLOUDINARY_API_SECRET || '').trim();
  if (!cloudName || !apiKey || !secret) throw clientError('Refund evidence uploads are not configured.', 503);
  requests.push(now); hits.set(user.uid, requests);
  const folder = `herstep/refunds/${user.uid}`;
  const publicId = `${Date.now()}-${crypto.randomUUID()}`;
  const timestamp = Math.floor(now / 1000);
  const allowedFormats = formats.join(',');
  const signature = crypto.createHash('sha1')
    .update(`allowed_formats=${allowedFormats}&folder=${folder}&public_id=${publicId}&timestamp=${timestamp}${secret}`)
    .digest('hex');
  return res.json({ cloudName, apiKey, timestamp, signature, folder, publicId, resourceType: 'auto', type: isVideo ? 'video' : 'image', allowedFormats: formats, maxBytes });
}
