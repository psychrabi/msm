import { createRoot } from 'react-dom/client';
import App from './App';
import { ThemeProvider } from './components/theme-provider';
import './clipboard-bridge';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <ThemeProvider defaultTheme="dark">
    <App />
  </ThemeProvider>,
);
