// dashboard.mjs — a self-contained, warm-dark HTML activity dashboard for the Boaz bot.
// Reads the skill's SQLite store (messages/outbox/spam) plus the JSONL usage log and
// renders one static HTML document. No external assets/CDN — inline CSS only.
//
// Composition:
//   collectStats(db, usageLines) — pure summary over an OPEN db + parsed usage objects.
//   renderHtml(stats)            — pure HTML string from that summary.
//   renderDashboard(path, path)  — opens the db read-only, reads the log, composes both.
import Database from 'better-sqlite3'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DATA_DIR, DB_PATH, USAGE_PATH } from './config.mjs'

// ── domain constants ────────────────────────────────────────────────────────
const BOT_NAME = 'Boaz'
const MEMORY = ':memory:'

// outbox.status values
const STATUS_DONE = 'done'
const STATUS_QUEUED = 'queued'
const STATUS_PROCESSING = 'processing'
const STATUS_FAILED = 'failed'
const STATUS_ORDER = [STATUS_DONE, STATUS_QUEUED, STATUS_PROCESSING, STATUS_FAILED]
const PENDING_STATUSES = [STATUS_QUEUED, STATUS_PROCESSING]

// usage.jsonl event / skipped values
const EVENT_SENT = 'sent'
const EVENT_SARCASM = 'sarcasm'
const SKIP_HOURLY_CAP = 'hourly-cap'
const SKIP_DISABLED = 'disabled'
const DROPPED_SKIPS = [SKIP_HOURLY_CAP, SKIP_DISABLED]

const P90 = 90
const LEADERBOARD_LIMIT = 10
const SPAM_LIMIT = 10
const RECENT_QA_LIMIT = 15
const QUESTION_MAX = 160
const REPLY_MAX = 280

const TABLE_MESSAGES = 'messages'
const TABLE_OUTBOX = 'outbox'
const TABLE_SPAM = 'spam'

const DEFAULT_OUT = join(DATA_DIR, 'dashboard.html')

// ── tiny pure helpers (exported for testing) ────────────────────────────────
export function percentile(nums, p) {
  const xs = (nums || []).filter((n) => Number.isFinite(n)).sort((a, b) => a - b)
  if (xs.length === 0) return null
  if (xs.length === 1) return xs[0]
  const rank = (p / 100) * (xs.length - 1)
  const lo = Math.floor(rank)
  const hi = Math.ceil(rank)
  if (lo === hi) return xs[lo]
  return xs[lo] + (xs[hi] - xs[lo]) * (rank - lo)
}

export function mean(nums) {
  const xs = (nums || []).filter((n) => Number.isFinite(n))
  if (xs.length === 0) return null
  return Math.round(xs.reduce((a, b) => a + b, 0) / xs.length)
}

// enqueued_ts → updated_ts elapsed (ms) for each done outbox row, positive only.
export function responseTimes(rows) {
  return (rows || [])
    .map((r) => Number(r.updated_ts) - Number(r.enqueued_ts))
    .filter((d) => Number.isFinite(d) && d >= 0)
}

export function shortJid(jid) {
  if (!jid) return 'unknown'
  return String(jid).split('@')[0].split(':')[0]
}

export function displayName(name, jid) {
  const n = (name || '').trim()
  return n || shortJid(jid)
}

export function truncate(str, max) {
  const s = String(str ?? '')
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + '…'
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
export function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c])
}

// ── formatting ──────────────────────────────────────────────────────────────
const DASH = '—'
const fmtInt = (n) => (Number.isFinite(n) ? Number(n).toLocaleString('en-US') : '0')

function fmtDuration(ms) {
  if (ms == null || !Number.isFinite(ms)) return DASH
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`
}

function fmtDateTime(ts) {
  if (!Number.isFinite(ts)) return DASH
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
}

// ── db reads (each guarded so a missing table degrades to empty, never throws) ─
function tableExists(db, name) {
  const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name)
  return !!row
}

function readDoneRows(db) {
  if (!tableExists(db, TABLE_OUTBOX)) return []
  return db
    .prepare(`SELECT enqueued_ts, updated_ts FROM outbox WHERE status = ? AND updated_ts IS NOT NULL`)
    .all(STATUS_DONE)
}

function pendingOutbox(db) {
  if (!tableExists(db, TABLE_OUTBOX)) return 0
  const marks = PENDING_STATUSES.map(() => '?').join(',')
  return db.prepare(`SELECT COUNT(*) c FROM outbox WHERE status IN (${marks})`).get(...PENDING_STATUSES).c
}

function countEvents(usage, pred) {
  return usage.reduce((n, u) => n + (pred(u) ? 1 : 0), 0)
}

function collectKpis(db, usage) {
  const times = responseTimes(readDoneRows(db))
  return {
    sent: countEvents(usage, (u) => u.event === EVENT_SENT),
    sarcasm: countEvents(usage, (u) => u.event === EVENT_SARCASM),
    dropped: countEvents(usage, (u) => DROPPED_SKIPS.includes(u.skipped)),
    avgMs: mean(times),
    p90Ms: percentile(times, P90),
    pending: pendingOutbox(db),
  }
}

// who summons Boaz most — every outbox row grouped by sender.
function collectLeaderboard(db) {
  if (!tableExists(db, TABLE_OUTBOX)) return []
  const rows = db
    .prepare(
      `SELECT sender_jid, MAX(sender_name) sender_name, COUNT(*) c
         FROM outbox GROUP BY sender_jid ORDER BY c DESC, sender_jid LIMIT ?`,
    )
    .all(LEADERBOARD_LIMIT)
  return rows.map((r) => ({ name: displayName(r.sender_name, r.sender_jid), jid: r.sender_jid, count: r.c }))
}

function collectOutboxStatus(db) {
  const counts = Object.create(null)
  if (tableExists(db, TABLE_OUTBOX)) {
    for (const r of db.prepare(`SELECT status, COUNT(*) c FROM outbox GROUP BY status`).all()) {
      counts[r.status] = r.c
    }
  }
  return STATUS_ORDER.map((status) => ({ status, count: counts[status] ?? 0 }))
}

function collectSpamLeaders(db) {
  if (!tableExists(db, TABLE_SPAM)) return []
  const hasNames = tableExists(db, TABLE_MESSAGES)
  const nameExpr = hasNames
    ? `(SELECT m.sender_name FROM messages m
         WHERE m.sender_jid = s.sender_jid AND m.sender_name IS NOT NULL
         ORDER BY m.ts DESC LIMIT 1)`
    : `NULL`
  const rows = db
    .prepare(
      `SELECT s.sender_jid, s.violations, ${nameExpr} sender_name
         FROM spam s ORDER BY s.violations DESC, s.sender_jid LIMIT ?`,
    )
    .all(SPAM_LIMIT)
  return rows.map((r) => ({
    name: displayName(r.sender_name, r.sender_jid),
    jid: r.sender_jid,
    violations: r.violations,
  }))
}

function collectRecentQa(db) {
  if (!tableExists(db, TABLE_OUTBOX)) return []
  const rows = db
    .prepare(
      `SELECT sender_jid, sender_name, question, reply, updated_ts
         FROM outbox WHERE status = ? AND reply IS NOT NULL
         ORDER BY updated_ts DESC LIMIT ?`,
    )
    .all(STATUS_DONE, RECENT_QA_LIMIT)
  return rows.map((r) => ({
    name: displayName(r.sender_name, r.sender_jid),
    jid: r.sender_jid,
    question: r.question || '',
    reply: r.reply || '',
    ts: r.updated_ts,
  }))
}

// Pure summary over an OPEN db handle + already-parsed usage objects.
export function collectStats(db, usageLines = [], now = () => Date.now()) {
  const usage = Array.isArray(usageLines) ? usageLines : []
  return {
    botName: BOT_NAME,
    generatedAt: now(),
    kpis: collectKpis(db, usage),
    leaderboard: collectLeaderboard(db),
    outboxStatus: collectOutboxStatus(db),
    spamLeaders: collectSpamLeaders(db),
    recentQa: collectRecentQa(db),
  }
}

// ── theme + view ─────────────────────────────────────────────────────────────
const THEME = {
  bg: '#1b1a16',
  panel: '#24231e',
  panelAlt: '#2b2a24',
  ink: '#f0eee6',
  muted: '#a8a396',
  accent: '#d97757',
  border: 'rgba(240,238,230,0.09)',
  track: 'rgba(240,238,230,0.06)',
}
const STATUS_COLORS = {
  [STATUS_DONE]: '#7fae7c',
  [STATUS_QUEUED]: '#d9a441',
  [STATUS_PROCESSING]: '#6fa8c7',
  [STATUS_FAILED]: '#d9615a',
}
const FONT_SANS = `'Familjen Grotesk','Styrene',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif`
const FONT_SERIF = `'Source Serif 4','Tiempos',Georgia,'Times New Roman',serif`
const FONT_MONO = `'IBM Plex Mono',ui-monospace,'SF Mono',Menlo,monospace`

const KPI_LABELS = {
  sent: 'Replies sent',
  sarcasm: 'Sarcasm posted',
  dropped: 'Dropped',
  avgResponse: 'Avg response',
  p90Response: 'p90 response',
  pending: 'Pending',
}

const styles = () => `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: ${THEME.bg}; color: ${THEME.ink};
    font-family: ${FONT_SANS}; font-size: 14px; line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 1120px; margin: 0 auto; padding: 40px 28px 64px; }
  header { margin-bottom: 28px; }
  h1 {
    font-family: ${FONT_SERIF}; font-weight: 600; font-size: 30px;
    letter-spacing: -0.01em; margin: 0;
  }
  h1 .accent { color: ${THEME.accent}; }
  .sub { color: ${THEME.muted}; font-family: ${FONT_MONO}; font-size: 12px; margin-top: 6px; }
  h2 {
    font-family: ${FONT_SANS}; font-weight: 600; font-size: 12px; text-transform: uppercase;
    letter-spacing: 0.08em; color: ${THEME.muted}; margin: 0 0 14px;
  }
  .kpis { display: grid; grid-template-columns: repeat(6, 1fr); gap: 12px; margin-bottom: 28px; }
  .tile {
    background: ${THEME.panel}; border: 1px solid ${THEME.border}; border-radius: 12px;
    padding: 16px 16px 14px; text-align: center;
  }
  .tile .val { font-family: ${FONT_SERIF}; font-size: 26px; font-weight: 600; letter-spacing: -0.01em; }
  .tile .lbl { color: ${THEME.muted}; font-size: 11px; margin-top: 4px; letter-spacing: 0.02em; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
  .panel {
    background: ${THEME.panel}; border: 1px solid ${THEME.border}; border-radius: 14px; padding: 20px 20px 22px;
  }
  .panel.full { grid-column: 1 / -1; }
  .rows { display: flex; flex-direction: column; gap: 10px; }
  .row { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 12px; }
  .row .name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row .count { font-family: ${FONT_MONO}; font-size: 12px; color: ${THEME.muted}; }
  .bar { grid-column: 1 / -1; height: 4px; border-radius: 3px; background: ${THEME.track}; overflow: hidden; }
  .bar > span { display: block; height: 100%; background: ${THEME.accent}; border-radius: 3px; }
  .bar.spam > span { background: ${THEME.accent}; opacity: 0.85; }
  .status-row { display: grid; grid-template-columns: 14px 1fr auto; align-items: center; gap: 10px; }
  .dot { width: 9px; height: 9px; border-radius: 50%; }
  .status-track { height: 6px; border-radius: 4px; background: ${THEME.track}; overflow: hidden; }
  .status-track > span { display: block; height: 100%; border-radius: 4px; }
  .qa { display: flex; flex-direction: column; gap: 14px; max-height: 440px; overflow-y: auto; padding-right: 8px; }
  .qa::-webkit-scrollbar { width: 8px; }
  .qa::-webkit-scrollbar-thumb { background: ${THEME.border}; border-radius: 4px; }
  .qa::-webkit-scrollbar-track { background: transparent; }
  .qa { scrollbar-width: thin; scrollbar-color: ${THEME.border} transparent; }
  .qa-item { border-top: 1px solid ${THEME.border}; padding-top: 14px; }
  .qa-item:first-child { border-top: 0; padding-top: 0; }
  .qa-meta { display: flex; justify-content: space-between; gap: 12px; margin-bottom: 6px; }
  .qa-meta .who { color: ${THEME.accent}; font-weight: 600; font-size: 13px; }
  .qa-meta .when { font-family: ${FONT_MONO}; font-size: 11px; color: ${THEME.muted}; }
  .qa-q { font-family: ${FONT_SERIF}; font-size: 15px; }
  .qa-a { color: ${THEME.muted}; font-size: 13.5px; margin-top: 5px; padding-left: 12px; border-left: 2px solid ${THEME.border}; }
  .empty { color: ${THEME.muted}; font-style: italic; }
  @media (max-width: 900px) { .kpis { grid-template-columns: repeat(3, 1fr); } .grid { grid-template-columns: 1fr; } }
  @media (max-width: 560px) { .kpis { grid-template-columns: repeat(2, 1fr); } }
`

const tile = (value, label) => `
  <div class="tile"><div class="val">${escapeHtml(value)}</div><div class="lbl">${escapeHtml(label)}</div></div>`

function kpiSection(k) {
  return `<section class="kpis">
    ${tile(fmtInt(k.sent), KPI_LABELS.sent)}
    ${tile(fmtInt(k.sarcasm), KPI_LABELS.sarcasm)}
    ${tile(fmtInt(k.dropped), KPI_LABELS.dropped)}
    ${tile(fmtDuration(k.avgMs), KPI_LABELS.avgResponse)}
    ${tile(fmtDuration(k.p90Ms), KPI_LABELS.p90Response)}
    ${tile(fmtInt(k.pending), KPI_LABELS.pending)}
  </section>`
}

const pct = (n, max) => (max > 0 ? Math.max(2, Math.round((n / max) * 100)) : 0)
const emptyNote = (msg) => `<div class="empty">${escapeHtml(msg)}</div>`

function leaderboardPanel(rows) {
  const body = rows.length === 0
    ? emptyNote('No summons yet.')
    : `<div class="rows">${rows.map((r) => {
        const max = rows[0].count
        return `<div class="row">
          <span class="name" dir="auto">${escapeHtml(r.name)}</span>
          <span class="count">${fmtInt(r.count)}</span>
          <span class="bar"><span style="width:${pct(r.count, max)}%"></span></span>
        </div>`
      }).join('')}</div>`
  return panel('Who summons Boaz most', body)
}

function outboxStatusPanel(rows) {
  const total = rows.reduce((n, r) => n + r.count, 0)
  const body = `<div class="rows">${rows.map((r) => {
    const color = STATUS_COLORS[r.status]
    const width = total > 0 ? Math.round((r.count / total) * 100) : 0
    return `<div class="status-row">
        <span class="dot" style="background:${color}"></span>
        <span class="status-track"><span style="width:${width}%;background:${color}"></span></span>
        <span class="count" style="min-width:56px;text-align:right">${escapeHtml(r.status)} ${fmtInt(r.count)}</span>
      </div>`
  }).join('')}</div>`
  return panel('Outbox status', body)
}

function spamPanel(rows) {
  const body = rows.length === 0
    ? emptyNote('No spammers. Calm group.')
    : `<div class="rows">${rows.map((r) => {
        const max = rows[0].violations
        return `<div class="row">
          <span class="name" dir="auto">${escapeHtml(r.name)}</span>
          <span class="count">${fmtInt(r.violations)}</span>
          <span class="bar spam"><span style="width:${pct(r.violations, max)}%"></span></span>
        </div>`
      }).join('')}</div>`
  return panel('Spam leaderboard', body)
}

function recentQaPanel(items) {
  const body = items.length === 0
    ? emptyNote('No answered questions yet.')
    : `<div class="qa">${items.map((it) => `
        <div class="qa-item">
          <div class="qa-meta">
            <span class="who" dir="auto">${escapeHtml(it.name)}</span>
            <span class="when">${escapeHtml(fmtDateTime(it.ts))}</span>
          </div>
          <div class="qa-q" dir="auto">${escapeHtml(truncate(it.question, QUESTION_MAX))}</div>
          <div class="qa-a" dir="auto">${escapeHtml(truncate(it.reply, REPLY_MAX))}</div>
        </div>`).join('')}</div>`
  return panel('Recent Q&amp;A', body, true)
}

function panel(title, bodyHtml, full = false) {
  return `<section class="panel${full ? ' full' : ''}"><h2>${title}</h2>${bodyHtml}</section>`
}

export function renderHtml(stats) {
  const s = stats || {}
  const kpis = s.kpis || {}
  const name = s.botName || BOT_NAME
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(name)} — activity</title>
<style>${styles()}</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>${escapeHtml(name)} <span class="accent">— activity</span></h1>
    <div class="sub">updated ${escapeHtml(fmtDateTime(s.generatedAt))}</div>
  </header>
  ${kpiSection(kpis)}
  <div class="grid">
    ${leaderboardPanel(s.leaderboard || [])}
    ${outboxStatusPanel(s.outboxStatus || [])}
    ${spamPanel(s.spamLeaders || [])}
    ${recentQaPanel(s.recentQa || [])}
  </div>
</div>
</body>
</html>
`
}

// ── I/O composition ──────────────────────────────────────────────────────────
export function readUsageLines(usagePath) {
  if (!usagePath || !existsSync(usagePath)) return []
  const out = []
  for (const line of readFileSync(usagePath, 'utf8').split('\n')) {
    const s = line.trim()
    if (!s) continue
    try {
      out.push(JSON.parse(s))
    } catch {
      /* skip malformed line */
    }
  }
  return out
}

function openDbForRead(dbPath) {
  if (dbPath === MEMORY || !existsSync(dbPath)) return new Database(MEMORY)
  return new Database(dbPath, { readonly: true, fileMustExist: true })
}

// Full HTML document string. Accepts a db path (or ':memory:'); never throws on
// missing file / empty tables / missing log.
export function renderDashboard(dbPath = DB_PATH, usagePath = USAGE_PATH) {
  const db = openDbForRead(dbPath)
  try {
    return renderHtml(collectStats(db, readUsageLines(usagePath)))
  } finally {
    db.close()
  }
}

// ── live server ──────────────────────────────────────────────────────────────
const DEFAULT_PORT = 8199

// Serve a fresh dashboard on every request; the page reloads itself on an interval.
export function serveDashboard(port = DEFAULT_PORT, refreshMs = 15000) {
  const reloader = `<script>setTimeout(function(){location.reload()}, ${refreshMs})</script>`
  const server = createServer((req, res) => {
    if (req.url && req.url !== '/') { res.writeHead(204); res.end(); return } // ignore favicon etc.
    try {
      const html = renderDashboard().replace('</body>', reloader + '</body>')
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(html)
    } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end('dashboard error: ' + (e?.message || e))
    }
  })
  server.listen(port, () => process.stdout.write(`Boaz dashboard live → http://localhost:${port}  (auto-refresh ${Math.round(refreshMs / 1000)}s)\n`))
  return server
}

// ── CLI ────────────────────────────────────────────────────────────────────
function main(argv) {
  if (argv[2] === 'serve') {
    const port = Number(argv[3]) || DEFAULT_PORT
    const refreshMs = (Number(process.env.DASH_REFRESH_SEC) || 15) * 1000
    serveDashboard(port, refreshMs)
    return
  }
  const outFile = argv[2] || DEFAULT_OUT
  const html = renderDashboard()
  mkdirSync(dirname(outFile), { recursive: true })
  writeFileSync(outFile, html)
  process.stdout.write(resolve(outFile) + '\n')
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) main(process.argv)
