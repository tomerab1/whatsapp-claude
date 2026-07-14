// transcribe.mjs — turn an incoming WhatsApp voice note (OGG/Opus) into text for the
// "Boaz" bot, so members can ask by voice. Runs openai-whisper (CPU/mac, --fp16 False)
// with NO --language so it auto-detects (the group is Hebrew-first, also English).
// whisper decodes ogg/opus itself via ffmpeg, so a raw .ogg transcribes directly.
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const DEFAULT_MODEL = 'base'   // good speed/quality tradeoff on CPU
export const OUTPUT_FORMAT = 'txt'
const RESOLVE_SHELL = 'zsh'
const RESOLVE_ARGS = ['-lc', 'command -v whisper'] // login shell picks up miniforge/homebrew PATH
const TRANSCRIBE_TIMEOUT_MS = 10 * 60 * 1000       // whisper on CPU is slow; be generous

// Resolve the whisper binary: WHISPER_BIN override wins, else `command -v whisper`
// in a login-ish zsh. Verifies the path exists; throws a clear error otherwise.
export function resolveWhisper() {
  const override = process.env.WHISPER_BIN
  if (override) {
    if (existsSync(override)) return override
    throw new Error(`WHISPER_BIN="${override}" was set but does not exist`)
  }
  let found = ''
  try { found = execFileSync(RESOLVE_SHELL, RESOLVE_ARGS).toString().trim() }
  catch { found = '' }
  if (!found || !existsSync(found)) {
    throw new Error('cannot find the `whisper` binary — install openai-whisper or set WHISPER_BIN')
  }
  return found
}

// opts.model > env WHISPER_MODEL > DEFAULT_MODEL.
export function pickModel(opts = {}) {
  return opts.model || process.env.WHISPER_MODEL || DEFAULT_MODEL
}

// Pure, testable args builder for the whisper CLI. When `language` is given (e.g. 'he'),
// pin it — otherwise whisper auto-detects and can mis-guess a Hebrew clip as Arabic.
export function whisperArgs(audioPath, outDir, model, language) {
  const args = [
    audioPath,
    '--model', model,
    '--output_format', OUTPUT_FORMAT,
    '--output_dir', outDir,
    '--fp16', 'False',            // CPU/mac: no half precision
  ]
  if (language && language !== 'auto') args.push('--language', language)
  return args
}

// whisper names its output after the audio file's stem: foo.ogg → foo.txt.
function transcriptPath(outDir, audioPath) {
  const stem = basename(audioPath, extname(audioPath))
  return join(outDir, `${stem}.${OUTPUT_FORMAT}`)
}

function runWhisper(bin, args) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    const timer = setTimeout(
      () => { child.kill('SIGKILL'); resolve({ code: -1, out, err: `${err}\n[timeout]` }) },
      TRANSCRIBE_TIMEOUT_MS,
    )
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: e.message }) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }) })
  })
}

// Transcribe an audio file to text. Returns the trimmed transcript ('' if silent).
// Throws if whisper is missing or the run fails.
export async function transcribeAudio(audioPath, opts = {}) {
  if (!audioPath || !existsSync(audioPath)) {
    throw new Error(`audio file not found: ${audioPath || '(empty)'}`)
  }
  const bin = resolveWhisper()
  const model = pickModel(opts)
  const language = opts.language || process.env.WHISPER_LANG || null
  const outDir = mkdtempSync(join(tmpdir(), 'boaz-stt-'))
  try {
    const { code, err } = await runWhisper(bin, whisperArgs(audioPath, outDir, model, language))
    if (code !== 0) throw new Error(`whisper failed (exit ${code}): ${(err || '').trim().slice(0, 500)}`)
    const txtPath = transcriptPath(outDir, audioPath)
    if (!existsSync(txtPath)) throw new Error(`whisper produced no transcript at ${txtPath}`)
    return readFileSync(txtPath, 'utf8').trim()
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
}

// CLI: node transcribe.mjs <audiofile> → prints the transcript.
const invokedDirectly = import.meta.url === pathToFileURL(process.argv[1] || '').href
if (invokedDirectly) {
  const audio = process.argv[2]
  if (!audio) { console.error('usage: node transcribe.mjs <audiofile>'); process.exit(1) }
  try {
    const text = await transcribeAudio(audio)
    process.stdout.write(`${text}\n`)
  } catch (e) {
    console.error('transcription failed:', e.message)
    process.exit(2)
  }
}
