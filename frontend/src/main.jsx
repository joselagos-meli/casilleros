import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import KioskPage from './components/KioskPage.jsx'

const kioskMatch = window.location.pathname.match(/^\/casillero\/(\d+)$/)

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {kioskMatch
      ? <KioskPage casillero={kioskMatch[1]} />
      : <div style={{ minHeight: '100vh', background: '#111', color: '#888', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'sans-serif' }}>
          Escanea el código QR de un casillero para continuar.
        </div>
    }
  </StrictMode>,
)
