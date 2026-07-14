import test from 'node:test'
import assert from 'node:assert/strict'
import {
  POLL_KEYWORDS, MAX_OPTIONS, parsePollCommand, extractPollFromReply, buildPollMessage,
} from './poll.mjs'

const TRIGGERS = ['@boaz', '@בועז']

test('POLL_KEYWORDS exposes both languages and stays extensible', () => {
  assert.deepEqual(POLL_KEYWORDS, ['poll', 'סקר'])
  assert.equal(MAX_OPTIONS, 12)
})

// ---- parsePollCommand: form (1), a direct group command ----

test('parses a Hebrew command: keyword + colon, "?" ends the question', () => {
  const r = parsePollCommand('@בועז סקר: פיצה או סושי? פיצה, סושי, שווארמה', TRIGGERS)
  assert.deepEqual(r, { question: 'פיצה או סושי?', options: ['פיצה', 'סושי', 'שווארמה'] })
})

test('parses an English command: "poll:" + "?" then comma options', () => {
  const r = parsePollCommand('@boaz poll: best movie? Godfather, Matrix, Inception', TRIGGERS)
  assert.deepEqual(r, { question: 'best movie?', options: ['Godfather', 'Matrix', 'Inception'] })
})

test('parses a Hebrew command with the keyword mid-sentence and a colon separator', () => {
  const r = parsePollCommand('@בועז תפתח סקר על היעד לטיול: יוון, איטליה, ספרד', TRIGGERS)
  assert.deepEqual(r, { question: 'על היעד לטיול', options: ['יוון', 'איטליה', 'ספרד'] })
})

test('parses newline-separated options', () => {
  const text = '@boaz poll: best pet?\ndog\ncat\nfish'
  assert.deepEqual(parsePollCommand(text, TRIGGERS), {
    question: 'best pet?',
    options: ['dog', 'cat', 'fish'],
  })
})

test('is case-insensitive on the keyword and trigger', () => {
  const r = parsePollCommand('@Boaz POLL: tea or coffee? tea, coffee', TRIGGERS)
  assert.deepEqual(r, { question: 'tea or coffee?', options: ['tea', 'coffee'] })
})

test('commas inside the question (before "?") do not become options', () => {
  const r = parsePollCommand('@boaz poll: hot, cold, or warm? tea, coffee', TRIGGERS)
  assert.deepEqual(r, { question: 'hot, cold, or warm?', options: ['tea', 'coffee'] })
})

test('trims, de-dupes, and caps options at MAX_OPTIONS', () => {
  const many = Array.from({ length: 15 }, (_, i) => `opt${i}`).join(', ')
  const text = `@boaz poll: pick?  a ,  a ,  b ,  ${many}`
  const r = parsePollCommand(text, TRIGGERS)
  assert.equal(r.options.length, MAX_OPTIONS)
  assert.deepEqual(r.options.slice(0, 3), ['a', 'b', 'opt0']) // 'a' de-duped, whitespace trimmed
})

test('returns null when the message is not a poll request', () => {
  assert.equal(parsePollCommand('@boaz what is 2+2', TRIGGERS), null)
  assert.equal(parsePollCommand('just chatting, no keyword', TRIGGERS), null)
  assert.equal(parsePollCommand('', TRIGGERS), null)
  assert.equal(parsePollCommand(null, TRIGGERS), null)
})

test('returns null with fewer than two options', () => {
  assert.equal(parsePollCommand('@boaz poll: only one? single', TRIGGERS), null) // one option
  assert.equal(parsePollCommand('@boaz poll: no options here?', TRIGGERS), null) // zero options
})

test('does not match the keyword inside a larger word', () => {
  assert.equal(parsePollCommand('@boaz polling stations? a, b', TRIGGERS), null)
})

// ---- extractPollFromReply: form (2), a fenced ```poll block ----

test('extracts a fenced poll with a question line and bullet options', () => {
  const reply = [
    'Sure, here is a poll:',
    '```poll',
    'question: Where should we travel?',
    '- Greece',
    '- Italy',
    '- Spain',
    '```',
  ].join('\n')
  assert.deepEqual(extractPollFromReply(reply), {
    question: 'Where should we travel?',
    options: ['Greece', 'Italy', 'Spain'],
  })
})

test('extracts a fenced poll using an "options:" comma list', () => {
  const reply = '```poll\nquestion: Lunch?\noptions: pizza, sushi, shawarma\n```'
  assert.deepEqual(extractPollFromReply(reply), {
    question: 'Lunch?',
    options: ['pizza', 'sushi', 'shawarma'],
  })
})

test('extracts a Hebrew fenced poll and de-dupes/trims its options', () => {
  const reply = '```poll\nquestion: לאן טסים?\n- יוון\n-  יוון \n* איטליה\n```'
  assert.deepEqual(extractPollFromReply(reply), {
    question: 'לאן טסים?',
    options: ['יוון', 'איטליה'],
  })
})

test('returns null when the reply has no fenced poll block', () => {
  assert.equal(extractPollFromReply('just a normal text answer'), null)
  assert.equal(extractPollFromReply('```js\nconsole.log(1)\n```'), null)
  assert.equal(extractPollFromReply(''), null)
  assert.equal(extractPollFromReply(null), null)
})

test('returns null for an invalid fenced block (missing question or too few options)', () => {
  assert.equal(extractPollFromReply('```poll\n- only\n- these\n```'), null) // no question
  assert.equal(extractPollFromReply('```poll\nquestion: Q?\n- one\n```'), null) // one option
})

// ---- buildPollMessage: the Baileys send payload + its validation ----

test('builds the Baileys poll payload shape with a default selectableCount', () => {
  const msg = buildPollMessage({ question: 'Lunch?', options: ['pizza', 'sushi'] })
  assert.deepEqual(msg, { poll: { name: 'Lunch?', values: ['pizza', 'sushi'], selectableCount: 1 } })
})

test('passes through a custom selectableCount and trims question/options', () => {
  const msg = buildPollMessage({ question: '  Pick two  ', options: [' a ', 'b', ' c'], selectableCount: 2 })
  assert.deepEqual(msg, { poll: { name: 'Pick two', values: ['a', 'b', 'c'], selectableCount: 2 } })
})

test('throws on an empty question', () => {
  assert.throws(() => buildPollMessage({ question: '   ', options: ['a', 'b'] }), /non-empty/)
})

test('throws with fewer than two options', () => {
  assert.throws(() => buildPollMessage({ question: 'Q?', options: ['only'] }), /at least 2/)
  assert.throws(() => buildPollMessage({ question: 'Q?', options: [] }), /at least 2/)
})

test('throws with more than MAX_OPTIONS options (not silently capped)', () => {
  const options = Array.from({ length: MAX_OPTIONS + 1 }, (_, i) => `o${i}`)
  assert.throws(() => buildPollMessage({ question: 'Q?', options }), /at most 12/)
})

test('the output of parsePollCommand feeds straight into buildPollMessage', () => {
  const parsed = parsePollCommand('@boaz poll: best movie? Godfather, Matrix', TRIGGERS)
  const msg = buildPollMessage(parsed)
  assert.deepEqual(msg.poll, { name: 'best movie?', values: ['Godfather', 'Matrix'], selectableCount: 1 })
})
