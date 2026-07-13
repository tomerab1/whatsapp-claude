import test from 'node:test'
import assert from 'node:assert/strict'
import { createGuardrails } from './guardrails.mjs'

const cfg = { enabled: true, perUserCooldownSec: 20, hourlyCap: 3 }

test('disabled blocks everyone', () => {
  const g = createGuardrails({ ...cfg, enabled: false }, () => 0)
  assert.deepEqual(g.check('u'), { allowed: false, reason: 'disabled' })
})

test('per-user cooldown blocks within the window, allows after', () => {
  let t = 0
  const g = createGuardrails(cfg, () => t)
  assert.equal(g.check('u').allowed, true)
  g.begin('u'); g.end()
  t = 10_000 // 10s < 20s
  assert.deepEqual(g.check('u'), { allowed: false, reason: 'cooldown' })
  assert.equal(g.check('other').allowed, true) // different sender unaffected
  t = 21_000 // > 20s
  assert.equal(g.check('u').allowed, true)
})

test('hourly cap blocks after N in the trailing hour', () => {
  let t = 0
  const g = createGuardrails(cfg, () => t)
  for (let i = 0; i < 3; i++) { assert.equal(g.check(`u${i}`).allowed, true); g.begin(`u${i}`); g.end() }
  assert.deepEqual(g.check('u9'), { allowed: false, reason: 'hourly-cap' })
  t = 3_600_001 // an hour later, window slides
  assert.equal(g.check('u9').allowed, true)
})

test('single-flight: busy while one is in progress', () => {
  const g = createGuardrails(cfg, () => 0)
  assert.equal(g.check('u').allowed, true)
  g.begin('u')
  assert.deepEqual(g.check('v'), { allowed: false, reason: 'busy' })
  g.end()
  assert.equal(g.check('v').allowed, true)
})
