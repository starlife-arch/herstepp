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

// Download a protected file (e.g. an invoice PDF) with the Bearer token and
// trigger a browser download through a temporary <a download> link — no
// window.open and no popups. Errors are thrown so callers can show them
// inline next to the button that failed.
export async function apiDownload(path: string, filename: string) {
  const { auth } = await getFirebase();
  const headers = new Headers();
  const user = auth.currentUser;
  if (user) {
    headers.set('Authorization', `Bearer ${await user.getIdToken()}`);
  }

  const response = await fetch(path, { headers });
  if (!response.ok) {
    let message = 'We could not download that file.';
    try {
      const payload = await response.json();
      if (payload?.error) message = String(payload.error);
    } catch {
      /* non-JSON error body — keep the default message */
    }
    throw new Error(message);
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
