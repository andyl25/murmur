import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

// Follow the system appearance (the kit keys dark mode off a .dark class).
const media = window.matchMedia('(prefers-color-scheme: dark)');
const applyTheme = () => document.documentElement.classList.toggle('dark', media.matches);
applyTheme();
media.addEventListener('change', applyTheme);

createRoot(document.getElementById('root')!).render(<App />);
