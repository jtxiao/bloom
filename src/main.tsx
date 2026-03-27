import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

try {
  const saved = localStorage.getItem('power-tree-autosave');
  if (saved) {
    const t = JSON.parse(saved).theme;
    if (t === 'dark' || t === 'light') document.documentElement.setAttribute('data-theme', t);
  }
} catch { /* */ }

createRoot(document.getElementById('root')!).render(
  <App />,
)
