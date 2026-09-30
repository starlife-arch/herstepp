import { getFirebase } from './firebase';

export async function apiFetch(path: string, options: RequestInit = {}) {
  const { auth } = await getFirebase();
  const headers = new Headers(options.headers);
  const user = auth.currentUser;

  if (user) {
    headers.set('Authorization', `Bearer ${await user.getIdToken()}`);
  }
  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(path, { ...options, headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || 'We could not complete that request.');
  }

  return payload;
}
