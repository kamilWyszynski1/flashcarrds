import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './index.css';
import { isLocalBackend } from './lib/api';
import { requestPersistentStorage } from './lib/db';

if (isLocalBackend) {
  void requestPersistentStorage();
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Service worker: production only (dev serves a no-op). Secure context required
// (https or localhost) – see README for reaching the phone.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('SW registration failed', e));
  });
}
