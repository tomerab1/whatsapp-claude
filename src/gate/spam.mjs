// spam.mjs — per-user spam bookkeeping. A "violation" is a tag that arrives while the
// user is still on cooldown (i.e. they're spamming). We persist a running count so the
// sarcasm can escalate, but we only actually POST sarcasm at most once per cooldown
// window per user — otherwise the anti-spam reply would itself be spam (and cost sends).
const now0 = () => Date.now()
const DECAY_MS = 3_600_000 // an hour of calm resets the escalation level

export function initSpam(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS spam (
      sender_jid        TEXT PRIMARY KEY,
      violations        INTEGER NOT NULL DEFAULT 0,
      last_violation_ts INTEGER,
      last_sarcasm_ts   INTEGER
    );
  `)
  return db
}

// Record a cooldown violation. Returns { violations, sarcasm } — sarcasm is true iff a
// sarcastic reply should be posted now (rate-limited to one per cooldown window).
export function noteSpam(db, senderJid, cooldownMs, now = now0) {
  const t = now()
  const cur = db
    .prepare(`SELECT violations, last_violation_ts, last_sarcasm_ts FROM spam WHERE sender_jid = ?`)
    .get(senderJid)

  let violations = cur?.violations ?? 0
  if (cur && t - (cur.last_violation_ts ?? 0) > DECAY_MS) violations = 0 // calmed down
  violations += 1

  const lastSarcasm = cur?.last_sarcasm_ts ?? null
  const sarcasm = lastSarcasm == null || t - lastSarcasm >= cooldownMs

  db.prepare(`
    INSERT INTO spam (sender_jid, violations, last_violation_ts, last_sarcasm_ts)
    VALUES (@s, @v, @t, @sar)
    ON CONFLICT(sender_jid) DO UPDATE SET violations = @v, last_violation_ts = @t, last_sarcasm_ts = @sar
  `).run({ s: senderJid, v: violations, t, sar: sarcasm ? t : lastSarcasm })

  return { violations, sarcasm }
}
