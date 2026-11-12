import { getApps, initializeApp, App, cert } from 'firebase-admin/app';
import { getFirestore, Firestore } from 'firebase-admin/firestore';
import { getAuth, Auth } from 'firebase-admin/auth';
import firebaseConfig from '../../firebase-applet-config.json';

// Initialize the app with the project ID from config
// In AI Studio, this will use the environment's default credentials (ADC)
const app: App = !getApps().length 
  ? initializeApp({ 
      projectId: firebaseConfig.projectId 
    }) 
  : getApps()[0];

// Export Firestore with the specific database ID
// Important: In AI Studio Build, the database is often a named one.
export const adminDb: Firestore = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const adminAuth: Auth = getAuth(app);
