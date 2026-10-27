import crypto from 'node:crypto';
import { requireAdmin } from '../firebase-admin.js';
import { clientError, methodNotAllowed } from '../http.js';

const rules = {
  image: { formats: ['jpg', 'jpeg', 'png', 'webp'], maxBytes: 8 * 1024 * 1024 },
  video: { formats: ['mp4', 'webm', 'mov', 'm4v'], maxBytes: 60 * 1024 * 1024 },
};

export default async function signUpload(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
  await requireAdmin(req);

  const { resourceType, fileName, bytes, purpose } = req.body || {};
  if (!rules[resourceType] || !['products', 'hero', 'email-campaigns'].includes(purpose) ||
      typeof fileName !== 'string' || !Number.isInteger(bytes) || bytes < 1) {
    throw clientError('Upload request is invalid.');
  }

  const config = rules[resourceType];
  const extension = fileName.split('.').pop().toLowerCase();
  if (!config.formats.includes(extension) || bytes > config.maxBytes) {
    throw clientError('The selected file type or size is not allowed.');
  }

  const names = ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'];
  const missing = names.filter(name => !process.env[name]?.trim());
  if (missing.length) {
    throw clientError(`Server configuration is missing ${missing.join(', ')}.`, 503);
  }

  const folder = `herstep/${purpose}/${resourceType}s`;
  const publicId = `${Date.now()}-${crypto.randomUUID()}`;
  const timestamp = Math.floor(Date.now() / 1000);
  const allowedFormats = config.formats.join(',');

  // Sign every upload parameter that the client sends to Cloudinary.
  // Keep the parameter names and alphabetical order identical to Cloudinary's
  // canonical string; omitting allowed_formats causes an Invalid Signature.
  const toSign = `allowed_formats=${allowedFormats}&folder=${folder}&public_id=${publicId}&timestamp=${timestamp}`;
  const signature = crypto.createHash('sha1')
    .update(toSign + process.env.CLOUDINARY_API_SECRET.trim())
    .digest('hex');

  return res.status(200).json({
    cloudName: process.env.CLOUDINARY_CLOUD_NAME.trim(),
    apiKey: process.env.CLOUDINARY_API_KEY.trim(),
    timestamp,
    signature,
    folder,
    publicId,
    resourceType,
    allowedFormats: config.formats,
    maxBytes: config.maxBytes,
  });
}
