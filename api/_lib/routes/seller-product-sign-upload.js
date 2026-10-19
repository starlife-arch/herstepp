import crypto from 'node:crypto';
import { adminDb, requireUser } from '../firebase-admin.js';
import { clientError, methodNotAllowed } from '../http.js';

const allowedFormats = ['jpg', 'jpeg', 'png', 'webp'];
const maxBytes = 8 * 1024 * 1024;

export default async function sellerProductSignUpload(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
  const user = await requireUser(req);
  const seller = await adminDb.collection('sellers').doc(user.uid).get();
  if (!seller.exists || seller.data()?.status !== 'ACTIVE') {
    throw clientError('Only approved, active sellers can upload product images.', 403);
  }
  const { fileName, bytes } = req.body || {};
  if (typeof fileName !== 'string' || !Number.isInteger(bytes) || bytes < 1) {
    throw clientError('Upload request is invalid.');
  }
  const extension = fileName.split('.').pop().toLowerCase();
  if (!allowedFormats.includes(extension) || bytes > maxBytes) {
    throw clientError('Use JPG, PNG, or WEBP images up to 8 MB each.');
  }
  const names = ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'];
  const missing = names.filter(name => !process.env[name]?.trim());
  if (missing.length) throw clientError(`Server configuration is missing ${missing.join(', ')}.`, 503);
  const folder = 'herstep/seller-products/images';
  const publicId = `${user.uid.slice(0, 10)}-${crypto.randomUUID()}`;
  const timestamp = Math.floor(Date.now() / 1000);
  const formats = allowedFormats.join(',');
  const signature = crypto.createHash('sha1')
    .update(`allowed_formats=${formats}&folder=${folder}&public_id=${publicId}&timestamp=${timestamp}${process.env.CLOUDINARY_API_SECRET.trim()}`)
    .digest('hex');
  return res.status(200).json({
    cloudName: process.env.CLOUDINARY_CLOUD_NAME.trim(),
    apiKey: process.env.CLOUDINARY_API_KEY.trim(),
    timestamp, signature, folder, publicId,
    allowedFormats, maxBytes,
  });
}
