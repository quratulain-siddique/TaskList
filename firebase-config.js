/**
 * Paste your Firebase web app config from the Firebase console.
 * Project settings → Your apps → SDK setup and configuration.
 *
 * Leave placeholders as-is until configured; the app still works as a guest
 * (localStorage only). Sign-in requires a real project.
 */
export const firebaseConfig = {
  apiKey: "AIzaSyBtxaVvS1De_dI_pnDzanoh_sHiZFoBW3k",
  authDomain: "tasklist-8347c.firebaseapp.com",
  projectId: "tasklist-8347c",
  storageBucket: "tasklist-8347c.firebasestorage.app",
  messagingSenderId: "1057786868146",
  appId: "1:1057786868146:web:aa1b53c19e859ce9cf34ab"
};
export function isFirebaseConfigured() {
  return (
    firebaseConfig.apiKey &&
    !firebaseConfig.apiKey.startsWith("YOUR_") &&
    firebaseConfig.projectId &&
    !firebaseConfig.projectId.startsWith("YOUR_")
  );
}
