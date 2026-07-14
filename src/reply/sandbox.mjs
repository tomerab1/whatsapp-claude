// sandbox.mjs — run claude -p locked down against prompt injection from untrusted
// group members. The permissions.deny list is authoritative (deny > allow).
import { writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'

export const DENY_TOOLS = [
  'Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
  'Glob', 'Grep', 'Task', 'WebFetch', // WebFetch listed so we can re-allow it selectively
]

// Env the child is allowed to see. Everything else (Doppler/AWS/GH/DB/…) is dropped.
export const ENV_WHITELIST = [
  'HOME', 'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TMPDIR',
  'USER', 'LOGNAME', 'SHELL', 'SHLVL',
]

export function buildLockedSettings(config) {
  const allow = config.allowWebFetch ? ['WebSearch', 'WebFetch'] : ['WebSearch']
  // Deny everything dangerous. If WebFetch is disallowed, keep it denied; if allowed,
  // the allow-list re-permits it (allow of a non-denied tool is fine).
  const deny = config.allowWebFetch ? DENY_TOOLS.filter((t) => t !== 'WebFetch') : [...DENY_TOOLS]
  return { permissions: { allow, deny }, enableAllProjectMcpServers: false }
}

export function scrubEnv(env) {
  const out = {}
  for (const k of ENV_WHITELIST) if (env[k] !== undefined) out[k] = env[k]
  return out
}

export function buildClaudeArgs({ config, settingsPath, systemAppend, mcpConfigPath, mcpTools = [] }) {
  const allowed = config.allowWebFetch ? ['WebSearch', 'WebFetch'] : ['WebSearch']
  const disallowed = config.allowWebFetch ? DENY_TOOLS.filter((t) => t !== 'WebFetch') : [...DENY_TOOLS]
  const args = ['-p', '--model', config.model, '--settings', settingsPath, '--strict-mcp-config']
  if (mcpConfigPath) args.push('--mcp-config', mcpConfigPath) // + strict ⇒ ONLY this server loads
  args.push(
    '--append-system-prompt', systemAppend,
    '--allowedTools', ...allowed, ...mcpTools, // mcpTools gate which MCP tools may be called
    '--disallowedTools', ...disallowed,
    '--output-format', 'text',
  )
  return args
}

export function writeLockedSettings(settingsPath, config) {
  writeFileSync(settingsPath, JSON.stringify(buildLockedSettings(config), null, 2) + '\n')
}

export function generateReply({ prompt, config, settingsPath, claudePath, scratchDir, systemAppend, mcpConfigPath, mcpTools, maxTurns }) {
  const args = buildClaudeArgs({ config, settingsPath, systemAppend, mcpConfigPath, mcpTools })
  if (maxTurns) args.push('--max-turns', String(maxTurns))
  return new Promise((resolve) => {
    const child = spawn(claudePath, args, {
      cwd: scratchDir,               // empty dir: a stray glob finds nothing
      env: scrubEnv(process.env),    // no secrets in the child's environment
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = '', err = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ ok: false, text: '', error: 'timeout' }) },
      config.claudeTimeoutSec * 1000)
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, text: '', error: e.message }) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve({ ok: true, text: out.trim(), error: null })
      else resolve({ ok: false, text: '', error: err.trim() || `exit ${code}` })
    })
    child.stdin.write(prompt)
    child.stdin.end()
  })
}
