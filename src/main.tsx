import { createRoot } from 'react-dom/client';
import App from './App';
import './clipboard-bridge';
import './styles.css';

createRoot(document.getElementById('root')!).render(<App />);
