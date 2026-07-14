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
    handler: async () => ok((await adb(adbArgs(HOST(), ['dumpsys', 'window', 'windows']))).split('\n').filter((l) => /mCurrentFocus|mFocusedApp/.test(l)).join('\n') || '(unknown)'),
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
      await adb(adbArgs(HOST(), ['uiautomator', 'dump', '/sdcard/boaz-ui.xml']))
      const xml = await adb(adbArgs(HOST(), ['cat', '/sdcard/boaz-ui.xml']))
      return ok(formatUi(parseUiDump(xml)))
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
