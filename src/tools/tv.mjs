// tv.mjs — TV tool handlers. Each shells out to `adb` (scoped — no arbitrary shell tool)
// and returns MCP content ({text} or {image}). TV_HOST comes from the env the daemon sets.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { keyeventArgs, tapArgs, launchArgs, openUrlArgs, adbArgs, parseUiDump, formatUi } from './adb.mjs'

const run = promisify(execFile)
const ADB = process.env.ADB_BIN || 'adb'
const HOST = () => { const h = process.env.TV_HOST; if (!h) throw new Error('TV_HOST not set — the TV is not configured'); return h }
const ok = (t) => ({ content: [{ type: 'text', text: t }] })
const adb = async (args) => (await run(ADB, args, { timeout: 20000, maxBuffer: 16 * 1024 * 1024 })).stdout

export const tvTools = [
  {
    name: 'list_devices', description: 'List ADB-connected TVs.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => ok((await run(ADB, ['devices'])).stdout.trim()),
  },
  {
    name: 'get_focused_app', description: 'Return the foreground app/activity on the TV.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const out = await adb(adbArgs(HOST(), ['dumpsys', 'activity', 'activities']))
      const line = out.split('\n').map((l) => l.trim()).find((l) => /ResumedActivity/.test(l))
      if (line) return ok(line)
      const win = await adb(adbArgs(HOST(), ['dumpsys', 'window']))
      return ok(win.split('\n').map((l) => l.trim()).find((l) => /mCurrentFocus|mFocusedApp/.test(l)) || '(unknown)')
    },
  },
  {
    name: 'press_key', description: 'Press a remote key: ok, up, down, left, right, back, home, menu, play_pause, play, pause, stop, next, prev, rewind, forward, volume_up, volume_down, mute, power, sleep, wakeup.',
    inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
    handler: async ({ key }) => { await adb(keyeventArgs(HOST(), key)); return ok(`pressed ${key}`) },
  },
  {
    name: 'tap', description: 'Tap screen coordinates (use inspect_screen/screenshot to find targets).',
    inputSchema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] },
    handler: async ({ x, y }) => { await adb(tapArgs(HOST(), x, y)); return ok(`tapped ${x},${y}`) },
  },
  {
    name: 'launch_app', description: 'Launch an app by Android package name (e.g. com.netflix.ninja, com.google.android.youtube.tv).',
    inputSchema: { type: 'object', properties: { package: { type: 'string' } }, required: ['package'] },
    handler: async ({ package: pkg }) => { await adb(launchArgs(HOST(), pkg)); return ok(`launched ${pkg}`) },
  },
  {
    name: 'open_url', description: 'Open a URL or deep-link on the TV.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    handler: async ({ url }) => { await adb(openUrlArgs(HOST(), url)); return ok(`opened ${url}`) },
  },
  {
    name: 'inspect_screen', description: 'List the labelled on-screen elements with tap targets.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      // uiautomator ignores a custom path on some boxes; use its default + read back the
      // path it reports ("UI hierarchy dumped to: <path>"). Some TV apps block dumping
      // entirely — degrade to advising screenshot rather than throwing (which kills the loop).
      try {
        const dumpOut = await adb(adbArgs(HOST(), ['uiautomator', 'dump']))
        const m = dumpOut.match(/dumped to:?\s*(\S+)/i)
        const path = m ? m[1] : '/sdcard/window_dump.xml'
        const xml = await adb(adbArgs(HOST(), ['cat', path]))
        return ok(formatUi(parseUiDump(xml)))
      } catch {
        return ok('(UI dump unavailable on this app/box — use screenshot to see the screen, then tap by coordinates.)')
      }
    },
  },
  {
    name: 'screenshot', description: 'Capture the TV screen so you can see what is on it.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const { stdout } = await run(ADB, adbArgs(HOST(), ['screencap', '-p']), { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 })
      return { content: [{ type: 'image', mimeType: 'image/png', data: stdout.toString('base64') }] }
    },
  },
]
