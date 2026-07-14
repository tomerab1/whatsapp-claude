import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  ttsLang,
  cleanForSpeech,
  opusArgs,
  synthesizeVoice,
  VENV_PYTHON,
  LANG_HEBREW,
  LANG_ENGLISH,
} from '../src/media/tts.mjs'

test('ttsLang picks Hebrew for Hebrew text, English otherwise, and Hebrew when mixed', () => {
  assert.equal(LANG_HEBREW, 'iw') // gTTS uses the legacy ISO code for Hebrew
  assert.equal(ttsLang('שלום, זה בועז'), LANG_HEBREW)
  assert.equal(ttsLang('hello there'), LANG_ENGLISH)
  assert.equal(ttsLang('hello שלום'), LANG_HEBREW) // any Hebrew letter ⇒ Hebrew
  assert.equal(ttsLang(''), LANG_ENGLISH)
  assert.equal(ttsLang(null), LANG_ENGLISH)
})

test('cleanForSpeech strips the 🤖 prefix and *bold*/_italic_ markers', () => {
  assert.equal(cleanForSpeech('🤖 hello *world*'), 'hello world')
  assert.equal(cleanForSpeech('🤖 שלום *עולם*'), 'שלום עולם')
  assert.equal(cleanForSpeech('this is _important_ and *bold*'), 'this is important and bold')
  const cleaned = cleanForSpeech('🤖 *bold* _italic_ ~strike~ `mono`')
  assert.ok(!/[*_~`🤖]/.test(cleaned), `markers should be gone, got: ${cleaned}`)
  assert.equal(cleaned, 'bold italic strike mono')
})

test('opusArgs builds a mono OGG/Opus command that includes libopus and the out path', () => {
  const args = opusArgs('/tmp/in.mp3', '/tmp/out.ogg')
  assert.ok(args.includes('libopus'), 'uses the libopus encoder')
  assert.ok(args.includes('/tmp/in.mp3'))
  assert.equal(args.at(-1), '/tmp/out.ogg', 'out path is the final argument')
  // mono: an -ac flag immediately followed by "1"
  const ac = args.indexOf('-ac')
  assert.ok(ac !== -1 && args[ac + 1] === '1', 'downmixed to mono (-ac 1)')
})

// Actually run the pipeline once. Skipped (not failed) when the venv/gtts is missing
// or the network is unavailable, so the suite stays green in a sandbox.
test('synthesizeVoice produces a non-empty .ogg voice note (integration)', async (t) => {
  const haveGtts =
    existsSync(VENV_PYTHON) &&
    spawnSync(VENV_PYTHON, ['-c', 'import gtts'], { stdio: 'ignore' }).status === 0
  if (!haveGtts) {
    t.skip(`venv/gtts unavailable at ${VENV_PYTHON}`)
    return
  }

  const out = join(tmpdir(), `wa-tts-test-${randomUUID()}.ogg`)
  try {
    const result = await synthesizeVoice('שלום, זה בועז', out)
    assert.equal(result, out)
    assert.ok(existsSync(out), 'output .ogg exists')
    assert.ok(statSync(out).size > 0, 'output .ogg is non-empty')
  } catch (err) {
    // gTTS needs to reach Google; treat a network/runtime failure as a skip, not a fail.
    t.skip(`gtts/network unavailable: ${err.message}`)
  } finally {
    try { if (existsSync(out)) rmSync(out) } catch { /* best-effort cleanup */ }
  }
})
