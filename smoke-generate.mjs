// smoke-generate.mjs — manual: exercise the REAL sandboxed generateReply path.
// Usage: node smoke-generate.mjs "your question here"
import { mkdirSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { loadConfig, SETTINGS_PATH, SCRATCH_DIR } from './config.mjs'
import { writeLockedSettings, generateReply } from './sandbox.mjs'
import { buildPrompt, finalizeReply, hardening } from './compose.mjs'

const config = loadConfig()
mkdirSync(SCRATCH_DIR, { recursive: true })
writeLockedSettings(SETTINGS_PATH, config)
const claudePath = execSync('command -v claude', { shell: '/bin/zsh' }).toString().trim()

const question = process.argv[2] || '@claude what is the capital of France? Answer in one line.'
const prompt = buildPrompt({ context: [{ sender_name: 'Tester', text: question }], question, quoted: null })

const res = await generateReply({
  prompt, config, settingsPath: SETTINGS_PATH, claudePath, scratchDir: SCRATCH_DIR, systemAppend: hardening(config),
})
console.log('ok:', res.ok, 'error:', res.error)
console.log('reply:', res.ok ? finalizeReply(res.text, config) : '(none)')
