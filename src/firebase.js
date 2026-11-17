import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
  "apiKey": "AIzaSyDu3myB-tXFBLmUY8oaCCchuXNhVbVAD1I",
  "authDomain": "al-sayyad-transport.firebaseapp.com",
  "projectId": "al-sayyad-transport",
  "storageBucket": "al-sayyad-transport.firebasestorage.app",
  "messagingSenderId": "974063562821",
  "appId": "1:974063562821:web:7682d0990cb309956a332c"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
