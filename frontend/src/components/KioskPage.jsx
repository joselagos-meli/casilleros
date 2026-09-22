import { useState, useEffect, useRef } from 'react'

const API = '/api'

function formatRut(raw) {
  const clean = raw.replace(/[^0-9kK]/g, '').toUpperCase()
  if (clean.length <= 1) return clean
  return `${clean.slice(0, -1)}-${clean.slice(-1)}`
}

function fmtDatetime(iso) {
  if (!iso) return '—'
  const [datePart, timePart = ''] = iso.split('T')
  const [y, m, d] = datePart.split('-')
  return `${d}-${m}-${y} | ${timePart}`
}

function fmtDate(dt) {
  // Formatea un objeto Date en DD-MM-YYYY | HH:MM:SS en zona Santiago
  const s = dt.toLocaleString('sv-SE', { timeZone: 'America/Santiago' }) // "2026-08-07 13:54:21"
  const [date, time] = s.split(' ')
  const [y, m, d] = date.split('-')
  return `${d}-${m}-${y} | ${time}`
}

function addSeconds(iso, secs) {
  if (!iso) return null
  const d = new Date(iso + 'Z') // iso viene como YYYY-MM-DDTHH:MM:SS (hora Santiago), agregar Z es incorrecto
  // iso es hora local Santiago → crear Date sin asumir UTC
  const local = new Date(iso.replace('T', ' '))
  local.setSeconds(local.getSeconds() + secs)
  return local
}

function Countdown({ initialSecs }) {
  const [secs, setSecs] = useState(initialSecs ?? 0)

  useEffect(() => {
    setSecs(initialSecs ?? 0)
  }, [initialSecs])

  useEffect(() => {
    if (secs <= 0) return
    const id = setInterval(() => setSecs(s => Math.max(0, s - 1)), 1000)
    return () => clearInterval(id)
  }, [secs > 0])

  if (secs === null) return null
  if (secs === 0) return <span style={{ color: '#4ade80', fontWeight: 700 }}>Liberando...</span>

  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const s = secs % 60
  const str = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
  const color = secs <= 10 ? '#fb923c' : secs <= 30 ? '#facc15' : '#e5e5e5'
  return (
    <span style={{ color, fontWeight: 700, fontSize: 18, fontVariantNumeric: 'tabular-nums', fontFamily: 'monospace', animation: secs <= 10 ? 'pulse 1s infinite' : 'none' }}>
      {str}
    </span>
  )
}

export default function KioskPage({ casillero }) {
  const [data,     setData]     = useState(null)
  const [loading,  setLoading]  = useState(true)
  const [rut,      setRut]      = useState('')
  const [saving,   setSaving]   = useState(false)
  const [error,    setError]    = useState(null)
  const [success,  setSuccess]  = useState(null)
  const inputRef = useRef()

  const fetchStatus = async () => {
    try {
      const res = await fetch(`${API}/public/casillero/${casillero}`)
      const d   = await res.json()
      if (!res.ok) { setError(d.error || 'Casillero no disponible'); return }
      // Si el casillero ya expiró pero sigue asignado, disparar cleanup
      if (d.ESTADO === 'Asignado' && parseInt(d.SECS_REMAINING ?? 0) <= 0) {
        await fetch(`${API}/public/casillero/${casillero}/cleanup`, { method: 'POST' }).catch(() => {})
        // Volver a obtener estado actualizado
        const res2 = await fetch(`${API}/public/casillero/${casillero}`)
        const d2   = await res2.json()
        setData(d2)
      } else {
        setData(d)
      }
    } catch { setError('Error al cargar el casillero') }
    finally { setLoading(false) }
  }

  useEffect(() => {
    fetchStatus()
    const id = setInterval(fetchStatus, 5000)
    return () => clearInterval(id)
  }, [casillero])

  useEffect(() => {
    if (data?.ESTADO === 'Libre') {
      setSuccess(null)
      setRut('')
      setError(null)
      setTimeout(() => inputRef.current?.focus(), 100)
    }
  }, [data?.ESTADO])

  const handleRut = e => {
    const v = e.target.value.replace(/[^0-9kK]/g, '').toUpperCase()
    setRut(formatRut(v))
    setError(null)
  }

  const handleAssign = async e => {
    e?.preventDefault()
    if (!rut || rut.length < 3) { setError('Ingresa un RUT válido'); return }
    if (data?.ESTADO === 'Asignado') { setError('El casillero ya está ocupado'); return }
    setSaving(true); setError(null)
    try {
      const res  = await fetch(`${API}/public/casillero/${casillero}/assign`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rut })
      })
      const d = await res.json()
      if (!res.ok) { setError(d.error || 'Error al registrar'); return }
      setSuccess(d.nombre)
      setRut('')
      await fetchStatus()
    } catch { setError('Error de conexión') }
    finally { setSaving(false) }
  }

  const isOcupado = data?.ESTADO === 'Asignado'

  return (
    <div style={{ minHeight: '100vh', background: '#111', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24, fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}>

      {/* Header */}
      <div style={{ textAlign: 'center', marginBottom: 24 }}>
        <img src="/logo.png" alt="MeLi" style={{ maxWidth: 200, objectFit: 'contain' }} />
      </div>

      {loading ? (
        <div style={{ color: '#888', fontSize: 16 }}>Cargando...</div>
      ) : !data ? (
        <div style={{ color: '#f87171', fontSize: 16 }}>Casillero no encontrado</div>
      ) : (
        <div style={{ width: '100%', maxWidth: 420, display: 'flex', flexDirection: 'column', gap: 20 }}>

          {/* Casillero badge */}
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 13, color: '#888', textTransform: 'uppercase', letterSpacing: 3, marginBottom: 8 }}>Casillero</div>
            <div style={{ fontSize: 72, fontWeight: 900, color: '#FFE600', lineHeight: 1 }}>{data.CASILLERO}</div>
            {data.AGENCIA && (
              <div style={{ fontSize: 13, color: '#888', marginTop: 4, letterSpacing: 1 }}>
                Casillero de <strong style={{ color: '#FFE600' }}>{data.AGENCIA}</strong>
              </div>
            )}
          </div>

          {/* Estado */}
          <div style={{ background: isOcupado ? '#2a0d0d' : '#0d2010', border: `2px solid ${isOcupado ? '#f87171' : '#4ade80'}`, borderRadius: 16, padding: '20px 24px', textAlign: 'center' }}>
            <div style={{ fontSize: 28, marginBottom: 8 }}>{isOcupado ? '🔴' : '🟢'}</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: isOcupado ? '#f87171' : '#4ade80', textTransform: 'uppercase', letterSpacing: 2 }}>
              {isOcupado ? 'Ocupado' : 'Libre'}
            </div>
          </div>

          {/* Si ocupado: info */}
          {isOcupado && (
            <div style={{ background: '#1a1a1a', border: '1px solid #2a2a2a', borderRadius: 16, padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 12 }}>
              <Row label="Nombre"     value={data.NOMBRE || '—'} />
              <Row label="RUT"        value={data.RUT || '—'} />
              <Row label="Asignado"  value={data.FECHA_ASIGNACION} />
              <Row label="Expira en" value={<Countdown initialSecs={parseInt(data.SECS_REMAINING ?? 0)} />} />
              <Row label="Expira"    value={data.FECHA_EXPIRACION || '—'} />
            </div>
          )}

          {/* Si libre: form */}
          {!isOcupado && (
            <form onSubmit={handleAssign} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {success && (
                <div style={{ background: '#0d2010', border: '1px solid #4ade80', borderRadius: 12, padding: '12px 16px', color: '#4ade80', fontSize: 14, textAlign: 'center' }}>
                  ✅ Registrado: <strong>{success}</strong>
                </div>
              )}
              <div style={{ fontSize: 13, color: '#888', textAlign: 'center' }}>Ingresa tu RUT para registrar este casillero</div>
              <input
                ref={inputRef}
                type="text"
                value={rut}
                onChange={handleRut}
                onKeyDown={e => e.key === 'Enter' && handleAssign()}
                placeholder="12345678-9"
                maxLength={12}
                style={{ background: '#222', border: '2px solid #444', borderRadius: 12, padding: '16px 20px', fontSize: 22, fontWeight: 600, color: '#fff', textAlign: 'center', outline: 'none', letterSpacing: 3, width: '100%', boxSizing: 'border-box' }}
                onFocus={e => e.target.style.borderColor = '#FFE600'}
                onBlur={e => e.target.style.borderColor = '#444'}
              />
              {error && <div style={{ color: '#f87171', fontSize: 13, textAlign: 'center' }}>{error}</div>}
              <button
                type="submit"
                disabled={saving || !rut}
                style={{ background: saving || !rut ? '#444' : '#FFE600', color: '#000', border: 'none', borderRadius: 12, padding: '16px', fontSize: 16, fontWeight: 700, cursor: saving || !rut ? 'not-allowed' : 'pointer', textTransform: 'uppercase', letterSpacing: 2, transition: 'background .2s' }}>
                {saving ? 'Registrando...' : 'Registrar casillero'}
              </button>
            </form>
          )}
        </div>
      )}

    </div>
  )
}

function Row({ label, value }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
      <span style={{ color: '#666', fontSize: 12, textTransform: 'uppercase', letterSpacing: 1, flexShrink: 0 }}>{label}</span>
      <span style={{ color: '#e5e5e5', fontSize: 14, fontWeight: 600, textAlign: 'right' }}>{value}</span>
    </div>
  )
}
