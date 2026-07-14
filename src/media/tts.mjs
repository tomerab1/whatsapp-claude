// tts.mjs — turn a reply into a WhatsApp voice note (PTT) for the "Boaz" bot.
// Pipeline: clean text → pick language (Hebrew/English) → gTTS mp3 (via a dedicated
// venv's python, network-dependent) → ffmpeg OGG/Opus mono 48k → an .ogg WhatsApp
// plays as a voice message. Every step is a small, testable piece; the pure helpers
// (ttsLang / cleanForSpeech / opusArgs) carry no I/O so the unit tests never touch
// the network. Standalone: no imports from the rest of the skill.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

// ---- resolved tooling paths (env-overridable so a sandbox can redirect them) ----
const DEFAULT_VENV_PYTHON = join(homedir(), '.claude', 'whatsapp-claude', 'py-venv', 'bin', 'python')
export const VENV_PYTHON = process.env.TTS_PYTHON || DEFAULT_VENV_PYTHON
export const FFMPEG_BIN = process.env.TTS_FFMPEG || '/opt/homebrew/bin/ffmpeg'

// ---- language ----
// gTTS still uses the legacy ISO code 'iw' for Hebrew (not 'he').
export const LANG_HEBREW = 'iw'
export const LANG_ENGLISH = 'en'
const HEBREW_RE = /[֐-׿]/ // the Hebrew block: ֐ (U+0590) … ׿ (U+05FF)

// Any Hebrew letter present ⇒ speak Hebrew; otherwise English.
export function ttsLang(text) {
  return HEBREW_RE.test(String(text ?? '')) ? LANG_HEBREW : LANG_ENGLISH
}

// ---- text cleanup ----
const BOT_PREFIX_RE = /^\s*🤖️?\s*/ // the emoji the sender prepends to bot replies
const MARKDOWN_MARKERS_RE = /[*_~`]/g    // WhatsApp *bold* _italic_ ~strike~ `mono` markers

// Strip the bot's leading emoji and the formatting markers, so TTS reads the words
// and not "asterisk". Whitespace is collapsed to keep the spoken output tidy.
export function cleanForSpeech(text) {
  return String(text ?? '')
    .replace(BOT_PREFIX_RE, '')
    .replace(MARKDOWN_MARKERS_RE, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// ---- ffmpeg args (pure) ----
// WhatsApp voice notes are OGG/Opus, mono, 48 kHz; -application voip tunes Opus for
// speech. Kept as a pure builder so a test can assert the shape without running ffmpeg.
export const OPUS_BITRATE = '32k'
export const SAMPLE_RATE = '48000'

export function opusArgs(inPath, outPath) {
  return [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-i', inPath,
    '-c:a', 'libopus',
    '-b:a', OPUS_BITRATE,
    '-ar', SAMPLE_RATE,
    '-ac', '1',
    '-application', 'voip',
    outPath,
  ]
}

// ---- process runner ----
// Spawn without a shell (args pass through verbatim — safe for arbitrary text),
// feed optional stdin, and reject with the captured stderr on any non-zero exit.
function run(bin, args, { input } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', (err) => reject(new Error(`${bin}: ${err.message}`)))
    child.on('close', (code) => {
      if (code === 0) return resolvePromise()
      reject(new Error(`${bin} exited ${code}${stderr.trim() ? `: ${stderr.trim()}` : ''}`))
    })
    if (input != null) child.stdin.write(input)
    child.stdin.end()
  })
}

// gTTS as a one-liner: lang + out path via argv, the (UTF-8) text via stdin.
const GTTS_SCRIPT = [
  'import sys',
  'from gtts import gTTS',
  'lang, out = sys.argv[1], sys.argv[2]',
  'text = sys.stdin.buffer.read().decode("utf-8")',
  'gTTS(text=text, lang=lang).save(out)',
].join('\n')

const isNonEmptyFile = (p) => existsSync(p) && statSync(p).size > 0

// synthesizeVoice(text, outPath): write a WhatsApp voice note to outPath (.ogg) and
// return its absolute path. Throws a clear Error if gTTS or ffmpeg fail.
export async function synthesizeVoice(text, outPath) {
  const speech = cleanForSpeech(text)
  if (!speech) throw new Error('synthesizeVoice: nothing to speak after cleaning the text')

  const lang = ttsLang(speech)
  const absOut = resolve(outPath)
  mkdirSync(dirname(absOut), { recursive: true })
  const mp3 = join(tmpdir(), `wa-tts-${randomUUID()}.mp3`)

  try {
    await run(VENV_PYTHON, ['-c', GTTS_SCRIPT, lang, mp3], { input: speech })
    if (!isNonEmptyFile(mp3)) throw new Error(`gTTS produced no audio (lang=${lang})`)

    await run(FFMPEG_BIN, opusArgs(mp3, absOut))
    if (!isNonEmptyFile(absOut)) throw new Error('ffmpeg produced no output')

    return absOut
  } catch (err) {
    throw new Error(`synthesizeVoice failed: ${err.message}`)
  } finally {
    try { if (existsSync(mp3)) rmSync(mp3) } catch { /* best-effort cleanup */ }
  }
}

// ---- CLI: node tts.mjs "<text>" <out.ogg> ----
function isMain(metaUrl) {
  return Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(metaUrl)
}

async function main() {
  const [, , text, out] = process.argv
  if (!text || !out) {
    console.error('usage: node tts.mjs "<text>" <out.ogg>')
    process.exit(1)
  }
  console.log(await synthesizeVoice(text, out))
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message)
    process.exit(1)
  })
}
