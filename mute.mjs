// mute.mjs — per-user mutes (owner can silence a member for a while). Persistent.
const now0 = () => Date.now()

export function initMutes(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS mutes (sender_jid TEXT PRIMARY KEY, until_ts INTEGER)`)
  return db
}

export function setMute(db, jid, untilTs) {
  db.prepare(`INSERT INTO mutes (sender_jid, until_ts) VALUES (?, ?)
              ON CONFLICT(sender_jid) DO UPDATE SET until_ts = ?`).run(jid, untilTs, untilTs)
}

export function clearMute(db, jid) {
  db.prepare(`DELETE FROM mutes WHERE sender_jid = ?`).run(jid)
}

export function isMuted(db, jid, now = now0) {
  const r = db.prepare(`SELECT until_ts FROM mutes WHERE sender_jid = ?`).get(jid)
  return !!(r && r.until_ts > now())
}
