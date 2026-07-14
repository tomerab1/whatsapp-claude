import test from 'node:test'
import assert from 'node:assert/strict'
import { createGuardrails } from './guardrails.mjs'

const cfg = { enabled: true, perUserCooldownSec: 10, hourlyCap: 3 }

test('disabled blocks everyone', () => {
  const g = createGuardrails({ ...cfg, enabled: false }, () => 0)
  assert.deepEqual(g.check('u'), { allowed: false, reason: 'disabled' })
})

test('per-user cooldown blocks within the window, allows after', () => {
  let t = 0
  const g = createGuardrails(cfg, () => t)
  assert.equal(g.check('u').allowed, true)
  g.record('u')
  t = 5_000 // 5s < 10s
  assert.deepEqual(g.check('u'), { allowed: false, reason: 'cooldown' })
  assert.equal(g.check('other').allowed, true) // different sender unaffected
  t = 11_000 // > 10s
  assert.equal(g.check('u').allowed, true)
})

test('hourly cap blocks after N in the trailing hour', () => {
  let t = 0
  const g = createGuardrails(cfg, () => t)
  for (let i = 0; i < 3; i++) { assert.equal(g.check(`u${i}`).allowed, true); g.record(`u${i}`) }
  assert.deepEqual(g.check('u9'), { allowed: false, reason: 'hourly-cap' })
  t = 3_600_001 // an hour later, window slides
  assert.equal(g.check('u9').allowed, true)
})

test('setEnabled toggles admission live', () => {
  const g = createGuardrails(cfg, () => 0)
  assert.equal(g.check('u').allowed, true)
  g.setEnabled(false)
  assert.equal(g.check('u').allowed, false)
  g.setEnabled(true)
  assert.equal(g.check('u').allowed, true)
})

test('clearHourly resets ONLY the group cap, leaving per-user cooldowns intact', () => {
  let t = 0
  const g = createGuardrails(cfg, () => t)
  for (let i = 0; i < 3; i++) { g.check(`u${i}`); g.record(`u${i}`) } // fill the cap (3)
  assert.deepEqual(g.check('u9'), { allowed: false, reason: 'hourly-cap' })
  g.clearHourly()
  assert.equal(g.check('u9').allowed, true) // group cap cleared
  // u0's per-user cooldown is still in effect (was recorded at t=0, now still t=0)
  assert.deepEqual(g.check('u0'), { allowed: false, reason: 'cooldown' })
})
