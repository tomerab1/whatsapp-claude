import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import {
  initOutbox, enqueue, claimNext, recordReply, markSent, markFailed, recover, pendingCount, statusCounts,
} from '../src/queue/outbox.mjs'

const db0 = () => initOutbox(new Database(':memory:'))
const row = (id, q) => ({ msgId: id, chatJid: 'g@g.us', senderJid: 's@x', senderName: 'S', question: q, quotedId: null })

test('enqueue dedups by msg_id', () => {
  const db = db0()
  let clock = 100
  assert.equal(enqueue(db, row('a', 'q1'), () => clock++), true)
  assert.equal(enqueue(db, row('a', 'q1-again'), () => clock++), false) // same id ignored
  assert.equal(pendingCount(db), 1)
})

test('claimNext returns oldest queued, marks processing, then the next', () => {
  const db = db0()
  let clock = 0
  enqueue(db, row('a', 'first'), () => (clock += 10))
  enqueue(db, row('b', 'second'), () => (clock += 10))
  const r1 = claimNext(db, () => clock++)
  assert.equal(r1.msg_id, 'a')
  assert.equal(r1.status, 'processing')
  const r2 = claimNext(db, () => clock++)
  assert.equal(r2.msg_id, 'b')
  assert.equal(claimNext(db, () => clock++), null) // nothing left queued
})

test('happy path: claim → recordReply → markSent → done', () => {
  const db = db0()
  enqueue(db, row('a', 'q'))
  claimNext(db)
  recordReply(db, 'a', 'the answer')
  markSent(db, 'a', 'REPLYID')
  assert.deepEqual(statusCounts(db), { done: 1 })
  assert.equal(pendingCount(db), 0)
})

test('markFailed retries then fails after maxAttempts', () => {
  const db = db0()
  enqueue(db, row('a', 'q'))
  claimNext(db)
  assert.equal(markFailed(db, 'a', 3), 'queued') // attempt 1 → retry
  claimNext(db)
  assert.equal(markFailed(db, 'a', 3), 'queued') // attempt 2 → retry
  claimNext(db)
  assert.equal(markFailed(db, 'a', 3), 'failed') // attempt 3 → give up
  assert.deepEqual(statusCounts(db), { failed: 1 })
})

test('recover requeues interrupted processing rows but keeps their saved reply', () => {
  const db = db0()
  enqueue(db, row('a', 'q'))
  claimNext(db)               // now processing
  recordReply(db, 'a', 'generated but not yet sent')
  assert.equal(recover(db), 1) // restart
  const r = claimNext(db)
  assert.equal(r.status, 'processing')
  assert.equal(r.reply, 'generated but not yet sent') // preserved → will re-send, not re-generate
})
