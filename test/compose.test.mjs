import test from 'node:test'
import assert from 'node:assert/strict'
import { hardening, buildPrompt, finalizeReply, SARCASM, sarcasmReply, voiceRequested } from '../src/reply/compose.mjs'

const cfg = { botPrefix: '🤖', botName: 'Boaz', triggers: ['@boaz', '@בועז'], maxReplyChars: 1500 }

test('hardening names the bot, lists triggers, and states the untrusted/no-tools stance', () => {
  const h = hardening(cfg)
  assert.match(h, /Boaz/)
  assert.match(h, /@boaz/)
  assert.match(h, /untrusted/i)
  assert.match(h, /never/i)
})

test('buildPrompt delimits untrusted context and includes the question', () => {
  const p = buildPrompt({
    context: [{ sender_name: 'A', text: 'hello' }, { sender_name: 'B', text: '@boaz 2+2?' }],
    question: '@boaz 2+2?',
    quoted: null,
  })
  assert.match(p, /BEGIN UNTRUSTED/)
  assert.match(p, /END UNTRUSTED/)
  assert.match(p, /A: hello/)
  assert.match(p, /2\+2/)
})

test('buildPrompt includes the quoted message when present', () => {
  const p = buildPrompt({ context: [], question: '@boaz translate', quoted: { sender_name: 'C', text: 'hola' } })
  assert.match(p, /C: hola/)
})

test('finalizeReply caps total length and applies exactly one bot prefix', () => {
  const c = { botPrefix: '🤖', maxReplyChars: 10 }
  const capped = finalizeReply('hello world this is long', c)
  assert.ok(capped.startsWith('🤖 hello'), `got: ${capped}`)
  assert.ok(capped.endsWith('…'))
  assert.ok(capped.length <= c.maxReplyChars)
  assert.equal(finalizeReply('🤖 hi', c), '🤖 hi')
})

test('sarcasmReply escalates by violation and clamps to the last line, prefixed', () => {
  assert.equal(sarcasmReply(1, cfg), `🤖 ${SARCASM[0]}`)
  assert.equal(sarcasmReply(3, cfg), `🤖 ${SARCASM[2]}`)
  assert.equal(sarcasmReply(99, cfg), `🤖 ${SARCASM[SARCASM.length - 1]}`) // clamped
})

test('sarcasmReply respects config.sarcasmLevel (0 = off, N = ceiling)', () => {
  assert.equal(sarcasmReply(5, { ...cfg, sarcasmLevel: 0 }), null)          // disabled
  assert.equal(sarcasmReply(5, { ...cfg, sarcasmLevel: 1 }), `🤖 ${SARCASM[0]}`) // capped at line 1
})

test('voiceRequested detects spoken-reply asks in both languages', () => {
  assert.equal(voiceRequested('@boaz answer out loud'), true)
  assert.equal(voiceRequested('@בועז תענה בהקלטה'), true)
  assert.equal(voiceRequested('@בועז מה השעה'), false)
})
