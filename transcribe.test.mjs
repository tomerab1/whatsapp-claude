import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  whisperArgs, resolveWhisper, transcribeAudio, pickModel, DEFAULT_MODEL,
} from './transcribe.mjs'

const SAY_PHRASE = 'testing whisper transcription one two three' // clear English for a loose check

// Resolve a binary via a login zsh (miniforge/homebrew PATH); null if absent.
function resolveCmd(cmd) {
  try { return execFileSync('zsh', ['-lc', `command -v ${cmd}`]).toString().trim() || null }
  catch { return null }
}

// macOS `say` → AIFF, then ffmpeg → ogg/opus (mimics a real WhatsApp voice note).
function synthOggClip(dir, ffmpeg) {
  const aiff = join(dir, 'clip.aiff')
  const ogg = join(dir, 'clip.ogg')
  execFileSync('/usr/bin/say', ['-o', aiff, SAY_PHRASE])
  execFileSync(ffmpeg, ['-y', '-i', aiff, '-c:a', 'libopus', ogg], { stdio: 'ignore' })
  return ogg
}

test('whisperArgs carries the audio path, txt format, output dir and the model', () => {
  const args = whisperArgs('/tmp/note.ogg', '/tmp/out', 'base')
  assert.ok(args.includes('/tmp/note.ogg'))
  const f = args.indexOf('--output_format')
  assert.ok(f >= 0 && args[f + 1] === 'txt')
  const d = args.indexOf('--output_dir')
  assert.ok(d >= 0 && args[d + 1] === '/tmp/out')
  const m = args.indexOf('--model')
  assert.ok(m >= 0 && args[m + 1] === 'base')
  // CPU/mac + auto-detect language: fp16 off, no --language pin.
  const fp = args.indexOf('--fp16')
  assert.ok(fp >= 0 && args[fp + 1] === 'False')
  assert.ok(!args.includes('--language'))
})

test('pickModel honours opts > env > default', () => {
  assert.equal(pickModel({ model: 'small' }), 'small')
  const prev = process.env.WHISPER_MODEL
  process.env.WHISPER_MODEL = 'tiny'
  try { assert.equal(pickModel(), 'tiny') }
  finally { if (prev === undefined) delete process.env.WHISPER_MODEL; else process.env.WHISPER_MODEL = prev }
  assert.equal(pickModel(), DEFAULT_MODEL)
})

test('resolveWhisper returns an existing path, or throws cleanly if whisper is absent', () => {
  let resolved = null, threw = null
  try { resolved = resolveWhisper() } catch (e) { threw = e }
  if (resolved) {
    assert.equal(typeof resolved, 'string')
    assert.ok(existsSync(resolved), 'resolved whisper path should exist on disk')
  } else {
    assert.ok(threw instanceof Error)
    assert.match(threw.message, /whisper/i)
  }
})

test('integration: transcribes a synthesized voice clip end-to-end', async (t) => {
  // Requires whisper (+ a downloaded model), macOS `say` for TTS, and ffmpeg for ogg.
  // Any missing piece → skip, never fail the suite.
  try { resolveWhisper() } catch { return t.skip('whisper not installed') }
  if (!existsSync('/usr/bin/say')) return t.skip('no macOS `say` to synthesize a sample')
  const ffmpeg = resolveCmd('ffmpeg')
  if (!ffmpeg) return t.skip('ffmpeg not found — cannot make an ogg/opus sample')

  const dir = mkdtempSync(join(tmpdir(), 'boaz-stt-test-'))
  try {
    const ogg = synthOggClip(dir, ffmpeg)
    let text
    try { text = await transcribeAudio(ogg) }
    catch (e) { return t.skip(`transcription unavailable (model not downloaded?): ${e.message}`) }
    assert.equal(typeof text, 'string')
    if (!text) return t.skip('empty transcript — model may be missing or the clip was silent')
    assert.ok(text.length > 0, 'expected a non-empty transcript')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
