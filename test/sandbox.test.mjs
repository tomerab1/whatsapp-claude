import test from 'node:test'
import assert from 'node:assert/strict'
import { buildLockedSettings, scrubEnv, buildClaudeArgs, DENY_TOOLS } from '../src/reply/sandbox.mjs'

test('locked settings allow only web tools and deny the dangerous ones', () => {
  const s = buildLockedSettings({ allowWebFetch: true })
  assert.deepEqual(s.permissions.allow, ['WebSearch', 'WebFetch'])
  for (const t of ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Task', 'NotebookEdit'])
    assert.ok(s.permissions.deny.includes(t), `${t} must be denied`)
  assert.equal(s.enableAllProjectMcpServers, false)
})

test('allowWebFetch:false drops WebFetch from allow and denies it', () => {
  const s = buildLockedSettings({ allowWebFetch: false })
  assert.deepEqual(s.permissions.allow, ['WebSearch'])
  assert.ok(s.permissions.deny.includes('WebFetch'))
})

test('scrubEnv keeps only the whitelist and drops secrets', () => {
  const out = scrubEnv({
    HOME: '/h', PATH: '/bin', LANG: 'en',
    DOPPLER_TOKEN: 'x', AWS_SECRET_ACCESS_KEY: 'y', GH_TOKEN: 'z', DATABASE_URL: 'd',
  })
  assert.equal(out.HOME, '/h')
  assert.equal(out.PATH, '/bin')
  assert.equal(out.DOPPLER_TOKEN, undefined)
  assert.equal(out.AWS_SECRET_ACCESS_KEY, undefined)
  assert.equal(out.GH_TOKEN, undefined)
  assert.equal(out.DATABASE_URL, undefined)
})

test('claude args carry print, model, settings, allow/deny, strict-mcp, system append', () => {
  const args = buildClaudeArgs({
    config: { model: 'claude-sonnet-5', allowWebFetch: true },
    settingsPath: '/tmp/s.json',
    systemAppend: 'HARDEN',
  })
  assert.ok(args.includes('-p'))
  assert.ok(args.includes('--model') && args.includes('claude-sonnet-5'))
  assert.ok(args.includes('--settings') && args.includes('/tmp/s.json'))
  assert.ok(args.includes('--strict-mcp-config'))
  assert.ok(args.includes('--append-system-prompt') && args.includes('HARDEN'))
  const i = args.indexOf('--allowedTools')
  assert.ok(i >= 0 && args[i + 1] === 'WebSearch')
  const d = args.indexOf('--disallowedTools')
  const disallowedSection = args.slice(d + 1)
  // With WebFetch allowed, every dangerous tool EXCEPT WebFetch must be disallowed…
  assert.ok(d >= 0 && DENY_TOOLS.filter((t) => t !== 'WebFetch').every((t) => disallowedSection.includes(t)))
  // …and WebFetch must NOT be in the disallowed list (it was re-allowed).
  assert.ok(!disallowedSection.includes('WebFetch'))
  assert.ok(!args.includes('--dangerously-skip-permissions'))
})
