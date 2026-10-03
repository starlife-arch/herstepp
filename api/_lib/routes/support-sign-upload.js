import crypto from 'node:crypto';
import { requireUser } from '../firebase-admin.js';
import { clientError, methodNotAllowed } from '../http.js';

const formats = ['jpg', 'jpeg', 'png', 'webp'];
const hits = new Map();

export default async function signSupportUpload(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
  const user = await requireUser(req);
  const { fileName, bytes } = req.body || {};
  const now = Date.now();
  const requests = (hits.get(user.uid) || []).filter(at => now - at < 3600000);
  if (requests.length >= 20) throw clientError('Too many upload requests. Please try again later.', 429);
  const extension = typeof fileName === 'string' ? fileName.split('.').pop().toLowerCase() : '';
  if (!formats.includes(extension) || !Number.isInteger(bytes) || bytes < 1 || bytes > 5 * 1024 * 1024) throw clientError('The selected file type or size is not allowed.');
  const cloudName = String(process.env.CLOUDINARY_CLOUD_NAME || '').trim();
  const apiKey = String(process.env.CLOUDINARY_API_KEY || '').trim();
  const secret = String(process.env.CLOUDINARY_API_SECRET || '').trim();
  if (!cloudName || !apiKey || !secret) throw clientError('Image uploads are not configured.', 503);
  requests.push(now); hits.set(user.uid, requests);
  const folder = `herstep/support/${user.uid}`;
  const publicId = `${Date.now()}-${crypto.randomUUID()}`;
  const timestamp = Math.floor(now / 1000);
  const signature = crypto.createHash('sha1').update(`allowed_formats=${formats.join(',')}&folder=${folder}&public_id=${publicId}&timestamp=${timestamp}${secret}`).digest('hex');
  return res.json({ cloudName, apiKey, timestamp, signature, folder, publicId, resourceType: 'image', allowedFormats: formats, maxBytes: 5 * 1024 * 1024 });
}
