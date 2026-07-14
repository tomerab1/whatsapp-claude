// connect.mjs — Baileys connection for the whatsapp-claude 2nd linked device.
import makeWASocket, {
  useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, fetchLatestWaWebVersion, Browsers,
} from 'baileys'
import qrcode from 'qrcode-terminal'
import P from 'pino'
import { mkdirSync } from 'node:fs'
import { AUTH_DIR } from './config.mjs'

async function getVersion() {
  try { return (await fetchLatestWaWebVersion({})).version }
  catch { return (await fetchLatestBaileysVersion()).version }
}

export async function connect({ onReady, onMessages, onClose, pairPhone } = {}) {
  mkdirSync(AUTH_DIR, { recursive: true })
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  const version = await getVersion()
  const sock = makeWASocket({
    version,
    auth: state,
    logger: P({ level: process.env.WA_LOG || 'silent' }),
    // ubuntu/Chrome reaches the QR/pairing step; macOS/Desktop currently gets 428'd
    // ("Connection Terminated") before any QR. We don't need history sync here (context
    // is built from live messages), so the desktop signature buys us nothing.
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: false, // stay quiet; sending still works
  })
  sock.ev.on('creds.update', saveCreds)
  sock.ev.on('messages.upsert', ({ messages }) => onMessages?.(messages || []))

  let pairRequested = false
  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u
    if (qr) {
      if (pairPhone && !pairRequested) {
        pairRequested = true
        try {
          const code = await sock.requestPairingCode(pairPhone)
          console.log(`\n  Pairing code:  ${code}\n  WhatsApp → Linked devices → Link a device → "Link with phone number instead".\n`)
        } catch (e) { console.error('pairing-code request failed:', e?.message || e) }
      } else if (!pairPhone) {
        console.log('\nWhatsApp → Settings → Linked devices → Link a device, then scan:\n')
        qrcode.generate(qr, { small: true })
      }
    }
    if (connection === 'open') { console.log('connected.'); onReady?.(sock) }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode
      if (code === DisconnectReason.loggedOut) {
        console.log('logged out — delete ~/.claude/whatsapp-claude/auth and run `login` again.')
        process.exit(1)
      }
      onClose?.() // let the caller pause sending until the new socket is open
      console.log(`connection closed (${code}) — reconnecting in 3s…`)
      setTimeout(() => connect({ onReady, onMessages, onClose, pairPhone }), 3000)
    }
  })
  return sock
}
