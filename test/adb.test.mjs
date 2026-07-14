import test from 'node:test'
import assert from 'node:assert/strict'
import { KEYCODES, resolveKey, adbArgs, keyeventArgs, tapArgs, launchArgs, openUrlArgs, parseUiDump, formatUi } from '../src/tools/adb.mjs'

const H = '10.0.0.5:5555'

test('resolveKey maps friendly names and passes raw keycodes', () => {
  assert.equal(resolveKey('ok'), 'KEYCODE_DPAD_CENTER')
  assert.equal(resolveKey('play_pause'), 'KEYCODE_MEDIA_PLAY_PAUSE')
  assert.equal(resolveKey('KEYCODE_HOME'), 'KEYCODE_HOME')
  assert.ok(KEYCODES.back)
  assert.throws(() => resolveKey('nonsense'))
})

test('arg builders target the host over adb shell', () => {
  assert.deepEqual(adbArgs(H, ['input', 'keyevent', 'X']), ['-s', H, 'shell', 'input', 'keyevent', 'X'])
  assert.deepEqual(keyeventArgs(H, 'back'), ['-s', H, 'shell', 'input', 'keyevent', 'KEYCODE_BACK'])
  assert.deepEqual(tapArgs(H, 12, 34), ['-s', H, 'shell', 'input', 'tap', '12', '34'])
  assert.ok(launchArgs(H, 'com.netflix.ninja').join(' ').includes('monkey'))
  assert.deepEqual(openUrlArgs(H, 'https://x'), ['-s', H, 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', 'https://x'])
})

test('parseUiDump extracts labelled, bounded nodes; formatUi shows tap centers', () => {
  const xml = `<hierarchy><node text="Play" content-desc="" bounds="[10,20][110,60]" clickable="true"/>` +
              `<node text="" content-desc="Search" bounds="[0,0][40,40]" clickable="true"/>` +
              `<node text="" content-desc="" bounds="[0,0][1,1]" clickable="false"/></hierarchy>`
  const els = parseUiDump(xml)
  assert.equal(els.length, 2) // the empty/unlabelled node is dropped
  assert.equal(els[0].text, 'Play')
  assert.deepEqual(els[0].bounds, { x1: 10, y1: 20, x2: 110, y2: 60 })
  const s = formatUi(els)
  assert.match(s, /Play/)
  assert.match(s, /tap 60,40/) // center of the Play button
})
