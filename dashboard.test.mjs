import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import {
  percentile, mean, responseTimes, shortJid, displayName, truncate, escapeHtml,
  collectStats, renderHtml, readUsageLines,
} from './dashboard.mjs'

// A fresh in-memory db with the three tables the skill uses.
function freshDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, chat_jid TEXT, sender_jid TEXT, sender_name TEXT,
      ts INTEGER, kind TEXT, text TEXT, quoted_id TEXT, raw TEXT
    );
    CREATE TABLE outbox (
      msg_id TEXT PRIMARY KEY, chat_jid TEXT, sender_jid TEXT, sender_name TEXT,
      question TEXT, quoted_id TEXT, enqueued_ts INTEGER, status TEXT,
      reply TEXT, reply_msg_id TEXT, attempts INTEGER, updated_ts INTEGER
    );
    CREATE TABLE spam (
      sender_jid TEXT PRIMARY KEY, violations INTEGER,
      last_violation_ts INTEGER, last_sarcasm_ts INTEGER
    );
  `)
  return db
}

function addOutbox(db, r) {
  db.prepare(
    `INSERT INTO outbox (msg_id, chat_jid, sender_jid, sender_name, question, quoted_id,
       enqueued_ts, status, reply, reply_msg_id, attempts, updated_ts)
     VALUES (@msg_id,@chat_jid,@sender_jid,@sender_name,@question,NULL,
       @enqueued_ts,@status,@reply,@reply_msg_id,0,@updated_ts)`,
  ).run({
    chat_jid: 'g@g.us', sender_name: null, question: '', reply: null, reply_msg_id: null,
    ...r,
  })
}

// ── pure helpers ─────────────────────────────────────────────────────────────
test('percentile: empty → null, single → value, interpolates', () => {
  assert.equal(percentile([], 90), null)
  assert.equal(percentile([42], 90), 42)
  assert.equal(percentile([1, 2, 3, 4, 5], 50), 3)
  assert.equal(Math.round(percentile([1, 2, 3, 4, 5], 90) * 100) / 100, 4.6)
})

test('mean: null on empty, rounds otherwise', () => {
  assert.equal(mean([]), null)
  assert.equal(mean([1000, 2000, 3001]), 2000)
})

test('responseTimes: elapsed ms, drops negatives/non-finite', () => {
  const rows = [
    { enqueued_ts: 100, updated_ts: 400 },   // 300
    { enqueued_ts: 500, updated_ts: 500 },   // 0 (kept)
    { enqueued_ts: 900, updated_ts: 100 },   // negative → dropped
    { enqueued_ts: 1, updated_ts: null },    // NaN → dropped
  ]
  assert.deepEqual(responseTimes(rows), [300, 0])
})

test('shortJid / displayName / truncate / escapeHtml', () => {
  assert.equal(shortJid('972501234567@s.whatsapp.net'), '972501234567')
  assert.equal(shortJid('972501234567:12@s.whatsapp.net'), '972501234567')
  assert.equal(displayName('  ', 'abc@x'), 'abc')
  assert.equal(displayName('דנה', 'abc@x'), 'דנה')
  assert.equal(truncate('hello world', 100), 'hello world')
  assert.equal(truncate('hello world', 6), 'hello…')
  assert.equal(escapeHtml('<b>"x" & \'y\'</b>'), '&lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/b&gt;')
})

// ── collectStats ─────────────────────────────────────────────────────────────
test('collectStats: counts, response-time stats, leaderboards, recent Q&A', () => {
  const db = freshDb()
  // three done rows (200/400/600 ms), one queued, one failed
  addOutbox(db, { msg_id: 'a', sender_jid: 'u1@x', sender_name: 'דנה', question: 'מה השעה?', reply: 'שלוש', status: 'done', enqueued_ts: 1000, updated_ts: 1200 })
  addOutbox(db, { msg_id: 'b', sender_jid: 'u1@x', sender_name: 'דנה', question: 'ומחר?', reply: 'גשם', status: 'done', enqueued_ts: 2000, updated_ts: 2400 })
  addOutbox(db, { msg_id: 'c', sender_jid: 'u2@x', sender_name: 'Amir', question: 'hi', reply: 'hello', status: 'done', enqueued_ts: 3000, updated_ts: 3600 })
  addOutbox(db, { msg_id: 'd', sender_jid: 'u2@x', sender_name: 'Amir', question: 'wait', status: 'queued', enqueued_ts: 4000, updated_ts: 4000 })
  addOutbox(db, { msg_id: 'e', sender_jid: 'u3@x', sender_name: 'Noa', question: 'x', status: 'failed', enqueued_ts: 5000, updated_ts: 5100 })

  db.prepare(`INSERT INTO spam VALUES (?,?,?,?)`).run('u2@x', 5, 1, 1)
  db.prepare(`INSERT INTO spam VALUES (?,?,?,?)`).run('u1@x', 2, 1, 1)
  db.prepare(`INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?)`).run('m1', 'g@g.us', 'u2@x', 'Amir', 9, 'text', 'hi', null, '{}')

  const usage = [
    { event: 'sent' }, { event: 'sent' }, { event: 'sent' },
    { event: 'sarcasm' },
    { skipped: 'hourly-cap' }, { skipped: 'disabled' }, { skipped: 'cooldown' },
  ]

  const s = collectStats(db, usage, () => 1_700_000_000_000)

  assert.equal(s.kpis.sent, 3)
  assert.equal(s.kpis.sarcasm, 1)
  assert.equal(s.kpis.dropped, 2) // cap + disabled, cooldown excluded
  assert.equal(s.kpis.pending, 1) // one queued
  assert.equal(s.kpis.avgMs, 400) // (200+400+600)/3
  assert.ok(Number.isFinite(s.kpis.p90Ms))
  assert.ok(s.kpis.p90Ms >= 400 && s.kpis.p90Ms <= 600)

  // leaderboard: u1 and u2 each have 2 rows, u3 has 1
  assert.equal(s.leaderboard[0].count, 2)
  assert.equal(s.leaderboard.at(-1).count, 1)

  // outbox status always lists all four in order
  assert.deepEqual(s.outboxStatus.map((r) => r.status), ['done', 'queued', 'processing', 'failed'])
  const byStatus = Object.fromEntries(s.outboxStatus.map((r) => [r.status, r.count]))
  assert.deepEqual(byStatus, { done: 3, queued: 1, processing: 0, failed: 1 })

  // spam leaders sorted by violations desc, name resolved from messages when present
  assert.equal(s.spamLeaders[0].violations, 5)
  assert.equal(s.spamLeaders[0].name, 'Amir')

  // recent Q&A: only done rows, newest first
  assert.equal(s.recentQa.length, 3)
  assert.equal(s.recentQa[0].reply, 'hello') // updated_ts 3600 is newest
  assert.ok(s.recentQa.some((q) => q.question === 'מה השעה?')) // Hebrew preserved
})

test('collectStats: empty db does not throw and yields zeros', () => {
  const db = freshDb()
  const s = collectStats(db, [])
  assert.equal(s.kpis.sent, 0)
  assert.equal(s.kpis.pending, 0)
  assert.equal(s.kpis.avgMs, null)
  assert.equal(s.kpis.p90Ms, null)
  assert.deepEqual(s.leaderboard, [])
  assert.deepEqual(s.spamLeaders, [])
  assert.deepEqual(s.recentQa, [])
  assert.equal(s.outboxStatus.length, 4)
})

test('collectStats: missing tables degrade gracefully', () => {
  const db = new Database(':memory:') // no tables at all
  const s = collectStats(db, [{ event: 'sent' }])
  assert.equal(s.kpis.sent, 1)
  assert.equal(s.kpis.pending, 0)
  assert.deepEqual(s.leaderboard, [])
})

// ── renderHtml ───────────────────────────────────────────────────────────────
test('renderHtml: returns an HTML document with header + KPI labels', () => {
  const db = freshDb()
  addOutbox(db, { msg_id: 'a', sender_jid: 'u@x', sender_name: 'דנה', question: 'מה קורה?', reply: 'הכל טוב', status: 'done', enqueued_ts: 1, updated_ts: 201 })
  const html = renderHtml(collectStats(db, [{ event: 'sent' }]))
  assert.equal(typeof html, 'string')
  assert.ok(html.includes('<html'))
  assert.ok(html.includes('charset="utf-8"'))
  assert.ok(html.includes('Boaz — activity'))
  for (const label of ['Replies sent', 'Sarcasm posted', 'Dropped', 'Avg response', 'p90 response', 'Pending']) {
    assert.ok(html.includes(label), `missing KPI label: ${label}`)
  }
  assert.ok(html.includes('dir="auto"')) // RTL-safe rendering for Hebrew
  assert.ok(html.includes('מה קורה?')) // Hebrew question preserved
})

test('renderHtml: does not throw on empty / undefined stats', () => {
  assert.doesNotThrow(() => renderHtml({}))
  assert.doesNotThrow(() => renderHtml(undefined))
  const html = renderHtml({})
  assert.ok(html.includes('<html'))
  assert.ok(html.includes('Pending'))
})

// ── readUsageLines ───────────────────────────────────────────────────────────
test('readUsageLines: missing file → []', () => {
  assert.deepEqual(readUsageLines('/no/such/usage.jsonl'), [])
  assert.deepEqual(readUsageLines(null), [])
})
