import { clientError, methodNotAllowed } from '../http.js';

const firebaseConfigVariables = [
  'FIREBASE_API_KEY',
  'FIREBASE_AUTH_DOMAIN',
  'FIREBASE_PROJECT_ID',
  'FIREBASE_STORAGE_BUCKET',
  'FIREBASE_MESSAGING_SENDER_ID',
  'FIREBASE_APP_ID',
];

export default function firebaseConfig(req, res) {
  if (req.method !== 'GET') {
    return methodNotAllowed(res, 'GET');
  }

  const missing = firebaseConfigVariables.filter((name) => !process.env[name]?.trim());
  if (missing.length) {
    throw clientError(`Server configuration is missing ${missing.join(', ')}.`, 503);
  }

  res.setHeader('Cache-Control', 'public, max-age=300');
  return res.status(200).json({
    apiKey: process.env.FIREBASE_API_KEY.trim(),
    authDomain: process.env.FIREBASE_AUTH_DOMAIN.trim(),
    projectId: process.env.FIREBASE_PROJECT_ID.trim(),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET.trim(),
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID.trim(),
    appId: process.env.FIREBASE_APP_ID.trim(),
  });
}
