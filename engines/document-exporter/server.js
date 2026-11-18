// ReportHub document exporter.
//
// Opens the frontend print route (/print/:id) in headless Chromium and saves it as PDF. Page size and
// orientation come from the page's own CSS @page rules (one named page per section orientation), so
// the PDF matches the on-screen preview exactly.
//
// API (the contract the backend's docbuilder engine speaks):
//   GET  /healthz
//   GET  /api/documents/:ref             -> { id }               (numeric ids only)
//   GET  /api/export/pdf/:id?t=..[&p.x=..]  -> application/pdf   (synchronous)
//   POST /api/export/pdf/:id/jobs?t=..      -> { jobId }         (asynchronous)
//
// `t` is the print token the backend signs per export (document id + tenant/project + requesting
// user, short-lived). It is passed to the print page, which hands it to the backend's public print
// endpoint; the exporter itself holds no secret and cannot read any document without one.
//   GET  /api/export/jobs/:jobId         -> { status, error? }   queued | running | done | error
//   GET  /api/export/jobs/:jobId/file    -> application/pdf
import express from 'express'
import { randomUUID } from 'node:crypto'
import { chromium } from 'playwright'

const PORT = Number(process.env.PORT || 3200)
// Browser-reachable address of the ReportHub frontend, including any base path (e.g. http://web:3000/reportstudio).
const PRINT_BASE = (process.env.PRINT_BASE || 'http://localhost:3000').replace(/\/+$/, '')
const RENDER_TIMEOUT_MS = Number(process.env.RENDER_TIMEOUT_MS || 300000)
const JOB_TTL_MS = 60 * 60 * 1000

let browserPromise = null
function browser() {
  if (!browserPromise) {
    const p = chromium.launch({ args: ['--no-sandbox', '--font-render-hinting=none'] }).then((b) => {
      // Chromium crashed or was killed: forget it so the next render launches a fresh one.
      b.on('disconnected', () => {
        if (browserPromise === p) browserPromise = null
      })
      return b
    }).catch((e) => {
      if (browserPromise === p) browserPromise = null
      throw e
    })
    browserPromise = p
  }
  return browserPromise
}

function isBrowserGone(e) {
  const m = String((e && e.message) || e)
  return /Target (page, context or browser )?(has been )?closed|Browser (has been )?closed|browser has disconnected|Protocol error/i.test(m)
}

// Retry once on a dead browser: the first attempt after a crash fails with "Target closed".
async function renderPdfWithRetry(id, token, params) {
  try {
    return await renderPdf(id, token, params)
  } catch (e) {
    if (!isBrowserGone(e)) throw e
    console.warn('[export] browser gone, relaunching:', e.message)
    const old = browserPromise
    browserPromise = null
    if (old) old.then((b) => b.close()).catch(() => {})
    return await renderPdf(id, token, params)
  }
}

// Short, client-safe message (no stack, no internal URLs).
function publicMessage(e) {
  const m = String((e && e.message) || 'Export failed').split('\n')[0]
  return m.replace(/https?:\/\/\S+/g, '').slice(0, 200).trim() || 'Export failed'
}

function printUrl(id, token, params) {
  const q = new URLSearchParams({ token })
  for (const [k, v] of Object.entries(params || {})) q.set(`p.${k}`, String(v))
  return `${PRINT_BASE}/print/${encodeURIComponent(id)}?${q}`
}

async function renderPdf(id, token, params) {
  const b = await browser()
  const ctx = await b.newContext({ deviceScaleFactor: 1 })
  const page = await ctx.newPage()
  try {
    await page.goto(printUrl(id, token, params), { waitUntil: 'domcontentloaded', timeout: 60000 })
    // The print page sets window.__DOC_READY__ once data is loaded and pagination has settled,
    // or window.__DOC_ERROR__ when the document could not be loaded.
    await page.waitForFunction(() => window.__DOC_READY__ === true || !!window.__DOC_ERROR__, null, {
      timeout: RENDER_TIMEOUT_MS,
    })
    const err = await page.evaluate(() => window.__DOC_ERROR__ || null)
    if (err) throw new Error(String(err))
    await page.evaluate(() => document.fonts && document.fonts.ready)
    await page.emulateMedia({ media: 'print' })
    return await page.pdf({ preferCSSPageSize: true, printBackground: true })
  } finally {
    await ctx.close().catch(() => {})
  }
}

// One render at a time keeps memory flat; queued jobs wait their turn.
let chain = Promise.resolve()
function enqueue(fn) {
  const run = chain.then(fn, fn)
  chain = run.catch(() => {})
  return run
}

const jobs = new Map()
function sweep() {
  const now = Date.now()
  for (const [k, j] of jobs) if (now - j.created > JOB_TTL_MS) jobs.delete(k)
}

function paramsFrom(query) {
  const out = {}
  for (const [k, v] of Object.entries(query || {})) if (k.startsWith('p.')) out[k.slice(2)] = v
  return out
}

const app = express()
app.use(express.json({ limit: '1mb' }))

app.get('/healthz', (_req, res) => res.send('ok'))

app.get('/api/documents/:ref', (req, res) => {
  if (!/^\d+$/.test(req.params.ref)) return res.status(404).json({ error: 'only numeric document ids are supported' })
  res.json({ id: Number(req.params.ref) })
})

app.get('/api/export/pdf/:id', async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).send('numeric document id required')
  if (!req.query.t) return res.status(400).send('print token (t) required')
  try {
    const pdf = await enqueue(() => renderPdfWithRetry(req.params.id, String(req.query.t), paramsFrom(req.query)))
    res.type('application/pdf').send(pdf)
  } catch (e) {
    console.error('[export] failed', req.params.id, e.stack || e.message)
    res.status(500).send(publicMessage(e))
  }
})

app.post('/api/export/pdf/:id/jobs', (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'numeric document id required' })
  if (!req.query.t) return res.status(400).json({ error: 'print token (t) required' })
  const token = String(req.query.t)
  sweep()
  const jobId = randomUUID()
  const job = { status: 'queued', created: Date.now(), pdf: null, error: null }
  jobs.set(jobId, job)
  const params = { ...paramsFrom(req.query), ...(req.body && req.body.params ? req.body.params : {}) }
  enqueue(async () => {
    job.status = 'running'
    try {
      job.pdf = await renderPdfWithRetry(req.params.id, token, params)
      job.status = 'done'
    } catch (e) {
      console.error('[export] job failed', req.params.id, e.stack || e.message)
      job.status = 'error'
      job.error = publicMessage(e)
    }
  })
  res.status(202).json({ jobId })
})

app.get('/api/export/jobs/:jobId', (req, res) => {
  const j = jobs.get(req.params.jobId)
  if (!j) return res.status(404).json({ error: 'unknown job' })
  res.json({ status: j.status, error: j.error || undefined })
})

app.get('/api/export/jobs/:jobId/file', (req, res) => {
  const j = jobs.get(req.params.jobId)
  if (!j || j.status !== 'done') return res.status(404).send('not ready')
  res.type('application/pdf').send(j.pdf)
})

app.listen(PORT, () => console.log(`document-exporter on :${PORT}, print base ${PRINT_BASE}`))
