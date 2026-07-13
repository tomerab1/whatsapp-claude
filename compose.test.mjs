import test from 'node:test'
import assert from 'node:assert/strict'
import { HARDENING, buildPrompt, finalizeReply } from './compose.mjs'

test('HARDENING states the untrusted-data and no-tools stance', () => {
  assert.match(HARDENING, /untrusted/i)
  assert.match(HARDENING, /never/i)
})

test('buildPrompt delimits untrusted context and includes the question', () => {
  const p = buildPrompt({
    context: [{ sender_name: 'A', text: 'hello' }, { sender_name: 'B', text: '@claude 2+2?' }],
    question: '@claude 2+2?',
    quoted: null,
  })
  assert.match(p, /BEGIN UNTRUSTED/)
  assert.match(p, /END UNTRUSTED/)
  assert.match(p, /A: hello/)
  assert.match(p, /2\+2/)
})

test('buildPrompt includes the quoted message when present', () => {
  const p = buildPrompt({ context: [], question: '@claude translate', quoted: { sender_name: 'C', text: 'hola' } })
  assert.match(p, /C: hola/)
})

test('finalizeReply caps total length and applies exactly one bot prefix', () => {
  const cfg = { botPrefix: '🤖', maxReplyChars: 10 }
  const capped = finalizeReply('hello world this is long', cfg)
  assert.ok(capped.startsWith('🤖 hello'), `got: ${capped}`)
  assert.ok(capped.endsWith('…'))
  assert.ok(capped.length <= cfg.maxReplyChars, `length ${capped.length} > ${cfg.maxReplyChars}`)
  // strips a model-echoed prefix so we never double it
  assert.equal(finalizeReply('🤖 hi', cfg), '🤖 hi')
})
