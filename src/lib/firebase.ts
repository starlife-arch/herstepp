import { FirebaseApp, initializeApp } from 'firebase/app';
import { Auth, getAuth } from 'firebase/auth';
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
