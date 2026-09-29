/**
 * HerStep Collection — Cloudinary Upload Signing API
 * 
 * POST /api/upload/sign
 * 
 * Generates a secure signature for client-side Cloudinary uploads.
 * This prevents exposing the API secret in frontend code.
 */

import crypto from 'crypto';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  try {
    const { folder, resourceType = 'image' } = req.body;

    if (!folder) {
      return res.status(400).json({ success: false, message: 'Folder is required' });
    }

    const cloudName = process.env.VITE_CLOUDINARY_CLOUD_NAME;
    const apiKey = process.env.CLOUDINARY_API_KEY;
    const apiSecret = process.env.CLOUDINARY_API_SECRET;

    if (!cloudName || !apiKey || !apiSecret) {
      return res.status(500).json({ success: false, message: 'Cloudinary not configured' });
    }

    // Generate timestamp (seconds since epoch)
    const timestamp = Math.round(Date.now() / 1000);

    // Create signature
    // Format: folder=folder_name&timestamp=timestamp+api_secret
    const signatureParams = `folder=${folder}&timestamp=${timestamp}`;
    const signature = crypto
      .createHash('sha1')
      .update(signatureParams + apiSecret)
      .digest('hex');

    return res.status(200).json({
      success: true,
      signature,
      timestamp,
      apiKey,
      cloudName,
      folder,
      resourceType,
    });

  } catch (error) {
    console.error('Upload signing error:', error);
    return res.status(500).json({ success: false, message: 'Signing failed' });
  }
}
