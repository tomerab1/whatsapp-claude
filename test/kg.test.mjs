import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { initKg, upsertNode, upsertEdge, mergeExtraction, kgEntities, kgSearch, kgStats, getWatermark, setWatermark } from '../src/kg/kg.mjs'

const db0 = () => initKg(new Database(':memory:'))

test('upsertNode inserts, then merges by id (union aliases + msg_ids)', () => {
  const db = db0()
  upsertNode(db, { id: 'plan:trip', type: 'plan', label: 'Greece trip', aliases: ['טיול'], summary: 'a trip', msg_ids: ['1'] })
  upsertNode(db, { id: 'plan:trip', type: 'plan', label: 'Greece trip (July)', aliases: ['יוון'], summary: 'trip in July', msg_ids: ['2'] })
  const rows = db.prepare('SELECT * FROM kg_nodes').all()
  assert.equal(rows.length, 1) // merged, not duplicated
  const n = rows[0]
  assert.equal(n.label, 'Greece trip (July)') // latest label wins
  assert.deepEqual(JSON.parse(n.aliases).sort(), ['טיול', 'יוון'].sort()) // union
  assert.deepEqual(JSON.parse(n.msg_ids).sort(), ['1', '2']) // union
})

test('upsertEdge dedups by (src,rel,dst), unioning msg_ids', () => {
  const db = db0()
  upsertEdge(db, { src: 'a', rel: 'brings', dst: 'b', note: 'tent', ts: 100, msg_ids: ['1'] })
  upsertEdge(db, { src: 'a', rel: 'brings', dst: 'b', note: 'tent+gas', ts: 200, msg_ids: ['2'] })
  const rows = db.prepare('SELECT * FROM kg_edges').all()
  assert.equal(rows.length, 1)
  assert.deepEqual(JSON.parse(rows[0].msg_ids).sort(), ['1', '2'])
})

test('mergeExtraction applies nodes+edges and advances the watermark', () => {
  const db = db0()
  mergeExtraction(db, { nodes: [{ id: 'p:x', type: 'p', label: 'X', msg_ids: ['1'] }], edges: [{ src: 'p:x', rel: 'is', dst: 'p:y', msg_ids: ['1'] }], throughTs: 500 })
  assert.equal(kgStats(db).nodes, 1)
  assert.equal(kgStats(db).edges, 1)
  assert.equal(getWatermark(db), 500)
})

test('kgSearch matches label/aliases/summary and returns neighbours', () => {
  const db = db0()
  upsertNode(db, { id: 'plan:trip', type: 'plan', label: 'Greece trip', aliases: ['יוון'], summary: 'a summer trip', msg_ids: ['1'] })
  upsertNode(db, { id: 'person:idan', type: 'person', label: 'Idan', aliases: [], summary: '', msg_ids: ['2'] })
  upsertEdge(db, { src: 'person:idan', rel: 'brings', dst: 'plan:trip', note: 'a tent', ts: 100, msg_ids: ['2'] })
  const hitByAlias = kgSearch(db, ['יוון'], 5)
  assert.ok(hitByAlias.nodes.some((n) => n.id === 'plan:trip'))
  assert.ok(hitByAlias.edges.some((e) => e.rel === 'brings')) // neighbour edge included
  assert.equal(kgSearch(db, ['nonexistentxyz'], 5).nodes.length, 0)
})

test('watermark round-trips (0 by default)', () => {
  const db = db0()
  assert.equal(getWatermark(db), 0)
  setWatermark(db, 1234)
  assert.equal(getWatermark(db), 1234)
})

test('kgEntities lists id/label/aliases for resolution', () => {
  const db = db0()
  upsertNode(db, { id: 'p:x', type: 'p', label: 'X', aliases: ['ex'], summary: '', msg_ids: [] })
  const ents = kgEntities(db)
  assert.equal(ents.length, 1)
  assert.equal(ents[0].id, 'p:x')
  assert.deepEqual(ents[0].aliases, ['ex'])
})
