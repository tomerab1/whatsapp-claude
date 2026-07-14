import test from 'node:test'
import assert from 'node:assert/strict'
import { buildVisionSettings, buildVisionArgs } from '../src/media/vision.mjs'

test('vision settings scope Read to the media dir and deny the dangerous tools', () => {
  const s = buildVisionSettings('/tmp/media', { allowWebFetch: true })
  assert.ok(s.permissions.allow.includes('Read(/tmp/media/**)'))
  assert.ok(s.permissions.allow.includes('WebSearch'))
  for (const t of ['Bash', 'Write', 'Edit', 'Glob', 'Grep', 'Task', 'WebFetch'])
    assert.ok(s.permissions.deny.includes(t), `${t} must be denied`)
  assert.equal(s.enableAllProjectMcpServers, false)
})

test('vision args allow only Read + WebSearch, deny the rest', () => {
  const args = buildVisionArgs({ config: { model: 'claude-sonnet-5', allowWebFetch: true }, settingsPath: '/tmp/s.json', systemAppend: 'H' })
  const a = args.indexOf('--allowedTools')
  assert.deepEqual(args.slice(a + 1, a + 3), ['Read', 'WebSearch'])
  assert.ok(args.includes('--strict-mcp-config'))
  assert.ok(!args.includes('--dangerously-skip-permissions'))
  const d = args.indexOf('--disallowedTools')
  assert.ok(args.slice(d + 1).includes('Bash'))
})
