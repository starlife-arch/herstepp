import { FirebaseApp, initializeApp } from 'firebase/app';
import {
  Auth,
  GoogleAuthProvider,
  User,
  getAuth,
  getRedirectResult,
  signInWithPopup,
  signInWithRedirect,
} from 'firebase/auth';
import { Firestore, getFirestore } from 'firebase/firestore';

interface FirebaseConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
}

let firebasePromise: Promise<{ app: FirebaseApp; auth: Auth; db: Firestore }> | undefined;

export function getFirebase() {
  if (!firebasePromise) {
    firebasePromise = fetch('/api/firebase-config')
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(payload.error || 'Unable to load Firebase configuration.');
        }
        return payload as FirebaseConfig;
      })
      .then((config) => {
        const app = initializeApp(config);
        return { app, auth: getAuth(app), db: getFirestore(app) };
      });
  }

  return firebasePromise;
}

// ---- Google sign-in --------------------------------------------------------
// The auth object is only available once /api/firebase-config has resolved,
// so every helper below awaits getFirebase() instead of a passed-in Auth.
export type GoogleSignInOutcome = 'signed-in' | 'cancelled' | 'redirecting';

function authErrorCode(error: unknown) {
  return typeof error === 'object' && error && 'code' in error ? String((error as { code: unknown }).code) : '';
}

// True when the user simply closed the Google popup — never an error message.
export function isGooglePopupCancelled(error: unknown) {
  const code = authErrorCode(error);
  return code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request';
}

let redirectResultPromise: Promise<User | null> | undefined;

// Handles the result of a completed signInWithRedirect on app load. Runs at
// most once per page load and NEVER rejects (a failed redirect resolves to
// null; callers surface errors through continueWithGoogle instead).
export function handleGoogleRedirectResult(): Promise<User | null> {
  if (!redirectResultPromise) {
    redirectResultPromise = getFirebase()
      .then(({ auth }) => getRedirectResult(auth))
      .then(result => result?.user ?? null)
      .catch(() => null);
  }

  return redirectResultPromise;
}

// "Continue with Google": popup first (so we can honour the F2 return-to-page
// flow), falling back to a full-page redirect when popups are blocked or the
// environment does not support them (e.g. some mobile in-app browsers).
// Resolves 'signed-in' / 'cancelled' / 'redirecting', or throws for real
// failures (the caller maps codes like auth/account-exists-with-different-
// credential to friendly text).
export async function continueWithGoogle(): Promise<GoogleSignInOutcome> {
  const { auth } = await getFirebase();
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });

  try {
    await signInWithPopup(auth, provider);
    return 'signed-in';
  } catch (error) {
    const code = authErrorCode(error);
    if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
      return 'cancelled';
    }
    if (code === 'auth/popup-blocked' || code === 'auth/operation-not-supported-in-this-environment') {
      // Fire-and-forget: the browser navigates away and the result is picked
      // up by handleGoogleRedirectResult() on the next page load.
      void signInWithRedirect(auth, provider).catch(() => { /* surfaced on return */ });
      return 'redirecting';
    }
    throw error;
  }
}
