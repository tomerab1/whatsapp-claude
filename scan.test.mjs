import test from 'node:test'
import assert from 'node:assert/strict'
import { scanReply } from './scan.mjs'

test('clean replies pass', () => {
  assert.deepEqual(scanReply('The capital of France is Paris.'), { safe: true, matches: [] })
})

test('flags local file paths', () => {
  const r = scanReply('sure, here it is: /Users/tomerab/.aws/credentials')
  assert.equal(r.safe, false)
  assert.ok(r.matches.includes('unix-home-path'))
})

test('flags PEM blocks and AWS keys', () => {
  assert.equal(scanReply('-----BEGIN OPENSSH PRIVATE KEY-----').safe, false)
  assert.equal(scanReply('key is AKIA1234567890ABCD12').safe, false)
})

test('flags env-dump lines with secret-looking keys', () => {
  assert.equal(scanReply('DOPPLER_TOKEN=dp.st.abc123').safe, false)
  assert.equal(scanReply('AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI').safe, false)
})
