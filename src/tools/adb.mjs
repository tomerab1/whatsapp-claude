// adb.mjs — pure builders for scoped `adb` command argv + a friendly keycode map, plus
// a uiautomator-dump parser. No I/O here (that's tv.mjs); this is unit-testable.

export const KEYCODES = {
  ok: 'KEYCODE_DPAD_CENTER', up: 'KEYCODE_DPAD_UP', down: 'KEYCODE_DPAD_DOWN',
  left: 'KEYCODE_DPAD_LEFT', right: 'KEYCODE_DPAD_RIGHT', back: 'KEYCODE_BACK',
  home: 'KEYCODE_HOME', menu: 'KEYCODE_MENU', play_pause: 'KEYCODE_MEDIA_PLAY_PAUSE',
  play: 'KEYCODE_MEDIA_PLAY', pause: 'KEYCODE_MEDIA_PAUSE', stop: 'KEYCODE_MEDIA_STOP',
  next: 'KEYCODE_MEDIA_NEXT', prev: 'KEYCODE_MEDIA_PREVIOUS',
  rewind: 'KEYCODE_MEDIA_REWIND', forward: 'KEYCODE_MEDIA_FAST_FORWARD',
  volume_up: 'KEYCODE_VOLUME_UP', volume_down: 'KEYCODE_VOLUME_DOWN', mute: 'KEYCODE_VOLUME_MUTE',
  power: 'KEYCODE_POWER', sleep: 'KEYCODE_SLEEP', wakeup: 'KEYCODE_WAKEUP',
}

export function resolveKey(name) {
  if (!name) throw new Error('key required')
  if (/^KEYCODE_[A-Z0-9_]+$/.test(name)) return name
  const k = KEYCODES[String(name).toLowerCase()]
  if (!k) throw new Error(`unknown key: ${name}`)
  return k
}

export const adbArgs = (host, parts) => ['-s', host, 'shell', ...parts]
export const keyeventArgs = (host, name) => adbArgs(host, ['input', 'keyevent', resolveKey(name)])
export const tapArgs = (host, x, y) => adbArgs(host, ['input', 'tap', String(x | 0), String(y | 0)])
export const launchArgs = (host, pkg) => adbArgs(host, ['monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1'])
export const openUrlArgs = (host, url) => adbArgs(host, ['am', 'start', '-a', 'android.intent.action.VIEW', '-d', url])

const BOUNDS_RE = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/
export function parseUiDump(xml) {
  const out = []
  const nodeRe = /<node\b[^>]*\/?>/g
  let m
  while ((m = nodeRe.exec(xml || ''))) {
    const tag = m[0]
    const attr = (n) => (tag.match(new RegExp(`${n}="([^"]*)"`)) || [, ''])[1]
    const text = attr('text').trim()
    const desc = attr('content-desc').trim()
    if (!text && !desc) continue // unlabelled → useless to the model
    const b = (attr('bounds').match(BOUNDS_RE) || []).slice(1).map(Number)
    if (b.length !== 4) continue
    out.push({ text, desc, clickable: attr('clickable') === 'true', bounds: { x1: b[0], y1: b[1], x2: b[2], y2: b[3] } })
  }
  return out
}

export function formatUi(elements) {
  return elements.map((e) => {
    const label = e.text || e.desc
    const cx = Math.round((e.bounds.x1 + e.bounds.x2) / 2)
    const cy = Math.round((e.bounds.y1 + e.bounds.y2) / 2)
    return `- "${label}"${e.clickable ? ` (tap ${cx},${cy})` : ''}`
  }).join('\n') || '(no labelled elements)'
}
