import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { BigQuery } from '@google-cloud/bigquery'

const app = express()
const PORT = process.env.PORT || 3002

app.use(cors({ origin: true, credentials: true }))
app.use(express.json())

// ── BigQuery ───────────────────────────────────────────────────────────────
const bq = new BigQuery({
  credentials: process.env.GCP_SA_JSON ? JSON.parse(process.env.GCP_SA_JSON) : undefined,
  projectId: process.env.BQ_PROJECT_ID || 'meli-bi-data',
})

const PERSONAS              = '`meli-sbox.ARGOS.TARGOS_AA_APP_BBDD_PERSONAS`'
const NUEVOS_INGRESOS_TABLE = '`meli-sbox.ARGOS.TARGOS_AA_APP_NUEVOS_INGRESOS`'
const CASILLEROS_TABLE      = '`meli-sbox.ARGOS.TARGOS_AA_APP_CASILLEROS`'
const CASILLEROS_HIST       = '`meli-sbox.ARGOS.TARGOS_AA_APP_CASILLEROS_HISTORIAL`'

// Cambiar EXPIRY_SECONDS para ajustar el tiempo de expiración
const EXPIRY_SECONDS = 11 * 60 * 60 // 11 horas

// Agencias habilitadas para registro público vía kiosko
const KIOSKO_AGENCIAS = new Set(['ADECCO', 'EUROFIRMS', 'MANPOWER'])

// Convierte BigQueryDate/DateTime a string plano
const serialize = row => Object.fromEntries(
  Object.entries(row).map(([k, v]) => [k, v && typeof v === 'object' && 'value' in v ? v.value : v])
)

async function runQuery(sql, params) {
  const opts = { query: sql, location: 'US' }
  if (params && Object.keys(params).length) opts.params = params
  const [rows] = await bq.query(opts)
  return rows.map(serialize)
}

// Registra una asignación en el historial
async function historialAsignar(casillero, agencia, rut, nombre) {
  try {
    // Deduplicación: si ya existe un registro activo para este casillero+RUT
    // creado en los últimos 15 segundos, no crear otro
    const reciente = await runQuery(
      `SELECT COUNT(*) AS cnt FROM ${CASILLEROS_HIST}
       WHERE CASILLERO = @cas AND UPPER(REPLACE(RUT,'-','')) = UPPER(@rutClean)
         AND FECHA_LIBERACION IS NULL
         AND DATETIME_DIFF(DATETIME(CURRENT_TIMESTAMP(),'America/Santiago'), FECHA_ASIGNACION, SECOND) < 15`,
      { cas: String(casillero), rutClean: (rut||'').replace(/[-\.]/g,'') }
    )
    if (parseInt(reciente[0]?.cnt || 0) > 0) return // ya existe, saltar

    // Cerrar registro abierto previo si existe (de otra persona o anterior)
    await bq.query({ query: `UPDATE ${CASILLEROS_HIST} SET FECHA_LIBERACION=DATETIME(CURRENT_TIMESTAMP(),'America/Santiago'), MOTIVO_LIBERACION='REASIGNACION' WHERE CASILLERO=@cas AND FECHA_LIBERACION IS NULL`, location:'US', params:{cas:String(casillero)} })
    const reg = Date.now()
    await bq.query({ query: `INSERT INTO ${CASILLEROS_HIST} (REGISTRO,CASILLERO,AGENCIA,RUT,NOMBRE,FECHA_ASIGNACION,FECHA_LIBERACION,MOTIVO_LIBERACION) VALUES (@reg,@cas,@ag,@rut,@nom,DATETIME(CURRENT_TIMESTAMP(),'America/Santiago'),NULL,NULL)`, location:'US', params:{reg, cas:String(casillero), ag:agencia||null, rut:rut||null, nom:nombre||null} })
  } catch(e) { console.error('[historial asignar]', e.message) }
}

// Registra una liberación en el historial
async function historialLiberar(casillero, motivo = 'MANUAL') {
  try {
    await bq.query({ query: `UPDATE ${CASILLEROS_HIST} SET FECHA_LIBERACION=DATETIME(CURRENT_TIMESTAMP(),'America/Santiago'), MOTIVO_LIBERACION=@motivo WHERE CASILLERO=@cas AND FECHA_LIBERACION IS NULL`, location:'US', params:{cas:String(casillero), motivo} })
  } catch(e) { console.error('[historial liberar]', e.message) }
}

// ── Kiosko público (sin auth) ─────────────────────────────────────────────────
app.get('/api/public/casillero/:numero', async (req, res) => {
  const num = parseInt(req.params.numero)
  try {
    const rows = await runQuery(
      `SELECT CASILLERO, TIPO, AGENCIA, RUT, NOMBRE, ESTADO,
              FORMAT_DATETIME('%d-%m-%Y | %H:%M:%S', FECHA_ULTIMO_CAMBIO) AS FECHA_ASIGNACION,
              FORMAT_DATETIME('%d-%m-%Y | %H:%M:%S', DATETIME_ADD(FECHA_ULTIMO_CAMBIO, INTERVAL @expiry SECOND)) AS FECHA_EXPIRACION,
              GREATEST(0, @expiry - DATETIME_DIFF(DATETIME(CURRENT_TIMESTAMP(),'America/Santiago'), FECHA_ULTIMO_CAMBIO, SECOND)) AS SECS_REMAINING,
              REGISTRO
       FROM ${CASILLEROS_TABLE}
       WHERE CAST(CASILLERO AS INT64) = @num AND TIPO = 'REP' LIMIT 1`,
      { num, expiry: EXPIRY_SECONDS }
    )
    if (!rows.length) return res.status(404).json({ error: 'Casillero no encontrado' })
    const agencia = rows[0].AGENCIA || ''
    if (!KIOSKO_AGENCIAS.has(agencia.toUpperCase())) {
      return res.status(403).json({ error: `Este casillero pertenece a ${agencia || 'una agencia'} y no está habilitado para registro en línea.` })
    }
    res.json({ ...rows[0], expirySec: EXPIRY_SECONDS })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.post('/api/public/casillero/:numero/cleanup', async (req, res) => {
  const num = parseInt(req.params.numero)
  try {
    const expired = await runQuery(
      `SELECT REGISTRO FROM ${CASILLEROS_TABLE}
       WHERE CAST(CASILLERO AS INT64) = @num AND TIPO = 'REP' AND ESTADO = 'Asignado'
         AND DATETIME_DIFF(DATETIME(CURRENT_TIMESTAMP(),'America/Santiago'), FECHA_ULTIMO_CAMBIO, SECOND) >= @expiry`,
      { num, expiry: EXPIRY_SECONDS }
    )
    if (expired.length) {
      const ids = expired.map(r => r.REGISTRO).join(',')
      await bq.query({ query: `UPDATE ${CASILLEROS_TABLE} SET RUT=NULL, NOMBRE=NULL, MODALIDAD=NULL, ESTADO='Libre', FECHA_ULTIMO_CAMBIO=DATETIME(CURRENT_TIMESTAMP(),'America/Santiago') WHERE REGISTRO IN (${ids})`, location: 'US' })
      historialLiberar(num, 'AUTO-EXPIRACION')
    }
    res.json({ ok: true, cleared: expired.length })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.post('/api/public/casillero/:numero/assign', async (req, res) => {
  const num = parseInt(req.params.numero)
  const { rut } = req.body
  if (!rut?.trim()) return res.status(400).json({ error: 'RUT requerido' })
  try {
    // Verificar estado del casillero
    const cas = await runQuery(`SELECT REGISTRO, ESTADO FROM ${CASILLEROS_TABLE} WHERE CAST(CASILLERO AS INT64) = @num AND TIPO = 'REP' LIMIT 1`, { num })
    if (!cas.length) return res.status(404).json({ error: 'Casillero no encontrado' })
    if (cas[0].ESTADO === 'Asignado') return res.status(409).json({ error: 'Casillero ocupado' })

    // Validar RUT en personas (con fallback a Nuevos Ingresos, para gente aún no migrada a Personas)
    const rutClean = rut.trim().replace(/[-\.]/g,'').toUpperCase()
    let ps = await runQuery(`SELECT TRIM(CONCAT(COALESCE(NOMBRES,''),' ',COALESCE(APELLIDOS,''))) AS NOMBRE, MODALIDAD, AGENCIA FROM ${PERSONAS} WHERE UPPER(REPLACE(REPLACE(RUT,'-',''),'.','')) = @rutClean LIMIT 1`, { rutClean })
    if (!ps.length) {
      ps = await runQuery(`SELECT TRIM(CONCAT(COALESCE(NOMBRES,''),' ',COALESCE(APELLIDOS,''))) AS NOMBRE, MODALIDAD, AGENCIA FROM ${NUEVOS_INGRESOS_TABLE} WHERE UPPER(REPLACE(REPLACE(RUT,'-',''),'.','')) = @rutClean LIMIT 1`, { rutClean })
    }
    if (!ps.length) return res.status(400).json({ error: 'RUT no encontrado en el sistema' })

    const { NOMBRE, MODALIDAD, AGENCIA: personaAgencia } = ps[0]

    // Validar que la agencia del RUT coincida con la del casillero
    const casInfo = await runQuery(`SELECT AGENCIA, CASILLERO FROM ${CASILLEROS_TABLE} WHERE CAST(CASILLERO AS INT64) = @num AND TIPO = 'REP' LIMIT 1`, { num })
    const casAgencia = casInfo[0]?.AGENCIA
    if (casAgencia && personaAgencia && casAgencia.toUpperCase() !== personaAgencia.toUpperCase()) {
      return res.status(403).json({ error: `Este casillero es de ${casAgencia}. Tu agencia es ${personaAgencia}.` })
    }

    // Verificar si el RUT ya tiene otro casillero asignado
    const rutEnOtroCasillero = await runQuery(
      `SELECT CASILLERO FROM ${CASILLEROS_TABLE} WHERE UPPER(REPLACE(REPLACE(RUT,'-',''),'.','')) = @rutClean AND ESTADO = 'Asignado' AND CAST(CASILLERO AS INT64) != @num LIMIT 1`,
      { rutClean, num }
    )
    if (rutEnOtroCasillero.length) {
      return res.status(409).json({ error: `Tu RUT ya tiene asignado el casillero ${rutEnOtroCasillero[0].CASILLERO}.` })
    }
    await bq.query({
      query: `UPDATE ${CASILLEROS_TABLE} SET RUT=@rut, NOMBRE=@nombre, MODALIDAD=@modalidad, ESTADO='Asignado', FECHA_ULTIMO_CAMBIO=DATETIME(CURRENT_TIMESTAMP(),'America/Santiago') WHERE CAST(CASILLERO AS INT64) = @num AND TIPO = 'REP'`,
      location: 'US',
      params: { rut: rut.trim(), nombre: NOMBRE, modalidad: MODALIDAD || null, num }
    })
    historialAsignar(num, casAgencia, rut.trim(), NOMBRE)
    res.json({ ok: true, nombre: NOMBRE })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// Vercel: exportar app en vez de escuchar
if (process.env.VERCEL) {
  // Vercel maneja el servidor
} else {
  app.listen(PORT, () => console.log(`Servidor Argos Kiosko en http://localhost:${PORT}`))
}

export default app
