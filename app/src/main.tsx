import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { routeLinksOutside } from './lib/module';
import './styles.css';

routeLinksOutside();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
