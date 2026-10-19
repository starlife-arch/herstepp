import crypto from 'node:crypto';
import { requireUser } from '../firebase-admin.js';
import { clientError, methodNotAllowed } from '../http.js';

const formats = ['jpg', 'jpeg', 'png', 'webp', 'avif'];
const hits = new Map();

export default async function signReviewUpload(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
  const user = await requireUser(req);
  const { fileName, bytes, mimeType } = req.body || {};
  const now = Date.now();
  const requests = (hits.get(user.uid) || []).filter(at => now - at < 3600000);
  if (requests.length >= 12) throw clientError('Too many photo uploads. Please try again later.', 429);
  const extension = typeof fileName === 'string' ? fileName.split('.').pop().toLowerCase() : '';
  const normalizedMime = String(mimeType || '').toLowerCase();
  if (!formats.includes(extension) || !['image/jpeg', 'image/png', 'image/webp', 'image/avif'].includes(normalizedMime) || !Number.isInteger(bytes) || bytes < 1 || bytes > 5 * 1024 * 1024) {
    throw clientError('Choose a JPEG, PNG, WebP or AVIF photo up to 5 MB.');
  }
  const cloudName = String(process.env.CLOUDINARY_CLOUD_NAME || '').trim();
  const apiKey = String(process.env.CLOUDINARY_API_KEY || '').trim();
  const secret = String(process.env.CLOUDINARY_API_SECRET || '').trim();
  if (!cloudName || !apiKey || !secret) throw clientError('Photo uploads are not configured.', 503);
  requests.push(now);
  hits.set(user.uid, requests);
  const folder = `herstep/reviews/${user.uid}`;
  const publicId = `${Date.now()}-${crypto.randomUUID()}`;
  const timestamp = Math.floor(now / 1000);
  const signature = crypto.createHash('sha1').update(`allowed_formats=${formats.join(',')}&folder=${folder}&public_id=${publicId}&timestamp=${timestamp}${secret}`).digest('hex');
  return res.json({ cloudName, apiKey, timestamp, signature, folder, publicId, resourceType: 'image', allowedFormats: formats, maxBytes: 5 * 1024 * 1024 });
}
