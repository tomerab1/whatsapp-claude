import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { wantsCatchup, catchupContext, keywordsFrom, searchHistory } from '../src/recall/memory.mjs'

const JID = 'g@g.us'
function seed() {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE messages (id TEXT PRIMARY KEY, chat_jid TEXT, sender_jid TEXT, sender_name TEXT, ts INTEGER, kind TEXT, text TEXT, quoted_id TEXT, raw TEXT)`)
  const ins = db.prepare(`INSERT INTO messages (id,chat_jid,sender_name,ts,text) VALUES (?,?,?,?,?)`)
  ins.run('1', JID, 'Idan', 100, 'סיכמנו שהטיול ליוון ביולי')
  ins.run('2', JID, 'Libo', 200, 'מגניב')
  ins.run('3', JID, 'Roy', 300, 'מי מביא את האוהל')
  ins.run('4', JID, 'Idan', 400, 'אני אביא אוהל וגז')
  return db
}

test('wantsCatchup detects summary intents in both languages', () => {
  assert.equal(wantsCatchup('@boaz summarize what I missed'), true)
  assert.equal(wantsCatchup('@בועז סכם מה פספסתי'), true)
  assert.equal(wantsCatchup('@בועז מה מזג האוויר'), false)
})

test('catchupContext returns a wide recent window oldest→newest', () => {
  const db = seed()
  const ctx = catchupContext(db, JID, 3)
  assert.deepEqual(ctx.map((r) => r.text), ['מגניב', 'מי מביא את האוהל', 'אני אביא אוהל וגז'])
})

test('keywordsFrom drops stopwords + trigger words, keeps salient terms', () => {
  const kw = keywordsFrom('@בועז מה סיכמנו על הטיול ליוון', ['@boaz', '@בועז'])
  assert.ok(kw.includes('סיכמנו'))
  assert.ok(kw.includes('הטיול') || kw.includes('ליוון'))
  assert.ok(!kw.includes('בועז'))
  assert.ok(!kw.includes('מה'))
})

test('searchHistory recalls older messages matching keywords', () => {
  const db = seed()
  const hits = searchHistory(db, JID, ['אוהל'], { limit: 5 })
  assert.equal(hits.length, 2) // both אוהל messages
  assert.ok(hits.every((h) => h.text.includes('אוהל')))
  // sinceTs excludes the recent window
  const older = searchHistory(db, JID, ['אוהל'], { limit: 5, sinceTs: 400 })
  assert.equal(older.length, 1) // only ts<400
})
