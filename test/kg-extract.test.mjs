import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { initKg, upsertNode } from '../src/kg/kg.mjs'
import { nextBatch, buildExtractPrompt, parseExtraction } from '../src/kg/extract.mjs'

const JID = 'g@g.us'
function seed() {
  const db = initKg(new Database(':memory:'))
  db.exec(`CREATE TABLE messages (id TEXT PRIMARY KEY, chat_jid TEXT, sender_name TEXT, ts INTEGER, kind TEXT, text TEXT)`)
  const ins = db.prepare('INSERT INTO messages (id,chat_jid,sender_name,ts,kind,text) VALUES (?,?,?,?,?,?)')
  ins.run('1', JID, 'Idan', 100, 'text', 'סיכמנו טיול ליוון')
  ins.run('2', JID, 'Roy', 200, 'text', 'מי מביא אוהל')
  ins.run('3', JID, 'Idan', 300, 'text', 'אני מביא אוהל')
  return db
}

test('nextBatch returns messages after the watermark with the through-ts + remaining', () => {
  const db = seed()
  const b = nextBatch(db, JID, 100, 2) // since ts 100 → msgs 2,3
  assert.equal(b.messages.length, 2)
  assert.equal(b.messages[0].id, '2')
  assert.equal(b.throughTs, 300) // max ts in the batch
  assert.equal(b.remaining, 0)
})

test('nextBatch includes known entities for resolution', () => {
  const db = seed()
  upsertNode(db, { id: 'plan:trip', type: 'plan', label: 'Greece trip', aliases: ['יוון'], summary: '', msg_ids: ['1'] })
  const b = nextBatch(db, JID, 0, 10)
  assert.ok(b.entities.some((e) => e.id === 'plan:trip'))
})

test('buildExtractPrompt embeds the messages, entities, and asks for JSON', () => {
  const p = buildExtractPrompt({
    messages: [{ id: '2', sender_name: 'Roy', ts: 200, text: 'מי מביא אוהל' }],
    entities: [{ id: 'plan:trip', label: 'Greece trip', aliases: ['יוון'] }],
  })
  assert.match(p, /מי מביא אוהל/)
  assert.match(p, /plan:trip/)
  assert.match(p, /nodes/)
  assert.match(p, /edges/)
  assert.match(p, /JSON/i)
})

test('parseExtraction pulls JSON from a fenced block or bare text', () => {
  const fenced = 'sure!\n```json\n{"nodes":[{"id":"a:b","type":"a","label":"B"}],"edges":[]}\n```\ndone'
  const r1 = parseExtraction(fenced)
  assert.equal(r1.nodes[0].id, 'a:b')
  const bare = 'noise {"nodes":[],"edges":[{"src":"x","rel":"is","dst":"y"}]} trailing'
  const r2 = parseExtraction(bare)
  assert.equal(r2.edges[0].rel, 'is')
  assert.deepEqual(parseExtraction('no json here'), { nodes: [], edges: [] })
})
