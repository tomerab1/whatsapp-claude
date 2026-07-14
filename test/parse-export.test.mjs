import test from 'node:test'
import assert from 'node:assert/strict'
import { parseExport, cleanText } from '../src/kg/parse-export.mjs'

test('cleanText strips edit/attachment/control markers', () => {
  assert.equal(cleanText('hi ‎<This message was edited>'), 'hi')
  assert.equal(cleanText('caption ‎image omitted'), 'caption')
  assert.equal(cleanText('‎sticker omitted'), '')
  assert.equal(cleanText('‎<attached: 0000-PHOTO.jpg>'), '')
})

test('parseExport reads iOS lines, computes ts, drops attachment-only + system', () => {
  const txt = [
    '[06/02/2025, 10:30:08] רונן מדמח: וואי אני מת עליו',
    'ממשיך בשורה שנייה',
    '‎[06/02/2025, 20:22:22] Idan מדמח: ‎sticker omitted',
    '[06/02/2025, 21:15:50] Idan מדמח: צריך גלגלים ‎image omitted',
  ].join('\n')
  const rows = parseExport(txt, { chatJid: 'g@g.us' })
  assert.equal(rows.length, 2) // the sticker-only line dropped
  assert.equal(rows[0].sender_name, 'רונן מדמח')
  assert.equal(rows[0].text, 'וואי אני מת עליו\nממשיך בשורה שנייה') // multi-line joined
  assert.equal(rows[0].ts, Math.floor(Date.UTC(2025, 1, 6, 10, 30, 8) / 1000))
  assert.equal(rows[0].chat_jid, 'g@g.us')
  assert.ok(rows[0].id.startsWith('imp-'))
  assert.equal(rows[1].text, 'צריך גלגלים') // attachment marker stripped, caption kept
})

test('parseExport is stable (same input → same ids)', () => {
  const txt = '[06/02/2025, 10:30:08] A: hello'
  assert.equal(parseExport(txt)[0].id, parseExport(txt)[0].id)
})
