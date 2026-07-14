// outbox.mjs — a persistent queue that guarantees every tag gets answered, in order,
// exactly once, even across restarts. Lifecycle of one row (pk = triggering msg_id):
//
//   queued → processing → (reply persisted) → done
//                       ↘ (send fails) → queued (retry) → … → failed after N attempts
//
// The generated reply is written BEFORE the send, so a crash between generate and send
// re-SENDS the saved reply on restart instead of paying for a fresh generation.
const now0 = () => Date.now()

export function initOutbox(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS outbox (
      msg_id       TEXT PRIMARY KEY,
      chat_jid     TEXT NOT NULL,
      sender_jid   TEXT,
      sender_name  TEXT,
      question     TEXT,
      quoted_id    TEXT,
      enqueued_ts  INTEGER,
      status       TEXT NOT NULL DEFAULT 'queued',
      reply        TEXT,
      reply_msg_id TEXT,
      attempts     INTEGER NOT NULL DEFAULT 0,
      updated_ts   INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox(status, enqueued_ts);
  `)
  return db
}

// Returns true if newly enqueued, false if this msg_id was already known (dedup).
export function enqueue(db, row, now = now0) {
  const t = now()
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO outbox
        (msg_id, chat_jid, sender_jid, sender_name, question, quoted_id, enqueued_ts, status, attempts, updated_ts)
       VALUES (@msg_id, @chat_jid, @sender_jid, @sender_name, @question, @quoted_id, @ts, 'queued', 0, @ts)`,
    )
    .run({
      msg_id: row.msgId,
      chat_jid: row.chatJid,
      sender_jid: row.senderJid ?? null,
      sender_name: row.senderName ?? null,
      question: row.question ?? '',
      quoted_id: row.quotedId ?? null,
      ts: t,
    })
  return info.changes > 0
}

// Atomically take the oldest queued row and mark it processing. Null if none.
export function claimNext(db, now = now0) {
  const tx = db.transaction(() => {
    const row = db
      .prepare(`SELECT * FROM outbox WHERE status = 'queued' ORDER BY enqueued_ts, rowid LIMIT 1`)
      .get()
    if (!row) return null
    db.prepare(`UPDATE outbox SET status = 'processing', updated_ts = ? WHERE msg_id = ?`).run(now(), row.msg_id)
    row.status = 'processing' // reflect the write in the returned object
    return row
  })
  return tx()
}

export function recordReply(db, msgId, reply, now = now0) {
  db.prepare(`UPDATE outbox SET reply = ?, updated_ts = ? WHERE msg_id = ?`).run(reply, now(), msgId)
}

export function markSent(db, msgId, replyMsgId, now = now0) {
  db.prepare(`UPDATE outbox SET status = 'done', reply_msg_id = ?, updated_ts = ? WHERE msg_id = ?`)
    .run(replyMsgId ?? null, now(), msgId)
}

// Bump attempts; requeue for retry, or mark failed once attempts reach maxAttempts.
// Returns the new status.
export function markFailed(db, msgId, maxAttempts, now = now0) {
  const tx = db.transaction(() => {
    const row = db.prepare(`SELECT attempts FROM outbox WHERE msg_id = ?`).get(msgId)
    const attempts = (row?.attempts ?? 0) + 1
    const status = attempts >= maxAttempts ? 'failed' : 'queued'
    db.prepare(`UPDATE outbox SET attempts = ?, status = ?, updated_ts = ? WHERE msg_id = ?`)
      .run(attempts, status, now(), msgId)
    return status
  })
  return tx()
}

// On startup, reset rows left 'processing' by a crash back to 'queued'. Any reply
// already saved is preserved, so the worker re-sends it instead of regenerating.
export function recover(db, now = now0) {
  const info = db.prepare(`UPDATE outbox SET status = 'queued', updated_ts = ? WHERE status = 'processing'`).run(now())
  return info.changes
}

export function pendingCount(db) {
  return db.prepare(`SELECT COUNT(*) c FROM outbox WHERE status IN ('queued','processing')`).get().c
}

export function statusCounts(db) {
  const rows = db.prepare(`SELECT status, COUNT(*) c FROM outbox GROUP BY status`).all()
  return Object.fromEntries(rows.map((r) => [r.status, r.c]))
}
