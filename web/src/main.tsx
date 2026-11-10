import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'
document.addEventListener('contextmenu', (e) => e.preventDefault())
document.addEventListener('selectstart', (e) => e.preventDefault())
createRoot(document.getElementById('root')!).render(<App />)
