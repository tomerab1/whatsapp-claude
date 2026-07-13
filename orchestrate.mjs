// orchestrate.mjs — one live message → maybe a sandboxed, guarded, scanned reply.
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { recentContext, getMessageText, extractText } from './store.mjs'
import { shouldReply, parseOwnerCommand } from './trigger.mjs'
import { buildPrompt, finalizeReply, HARDENING } from './compose.mjs'
import { generateReply } from './sandbox.mjs'
import { scanReply } from './scan.mjs'

export function appendUsage(usagePath, entry) {
  mkdirSync(dirname(usagePath), { recursive: true })
  appendFileSync(usagePath, JSON.stringify(entry) + '\n')
}

const senderOf = (msg, jid) =>
  msg.key?.participant || msg.participant || (msg.key?.fromMe ? (msg.key?.participant || 'me') : jid)

export async function handleMessage(ctx) {
  const { sock, msg, db, guardrails, config, paths, claudePath, sentIds, log } = ctx
  const jid = config.groupJid
  if (msg.key?.remoteJid !== jid) return
  const { text } = extractText(msg)
  const sender = senderOf(msg, jid)

  // Owner kill switch, evaluated before the trigger gate.
  const cmd = parseOwnerCommand(text, sender, config.ownerJid)
  if (cmd) {
    guardrails.setEnabled(cmd === 'on')
    config.enabled = cmd === 'on'
    const note = `${config.botPrefix} ${cmd === 'on' ? 'online' : 'muted'}.`
    const sent = await sock.sendMessage(jid, { text: note }, { quoted: msg })
    if (sent?.key?.id) sentIds.add(sent.key.id)
    return
  }

  if (!shouldReply({ text, id: msg.key?.id, botPrefix: config.botPrefix, triggers: config.triggers, sentIds }))
    return

  const gate = guardrails.check(sender)
  if (!gate.allowed) { log?.({ ts: Date.now(), sender, skipped: gate.reason }); return }

  guardrails.begin(sender)
  const started = Date.now()
  try {
    const quotedId = msg.message?.extendedTextMessage?.contextInfo?.stanzaId || null
    const quoted = quotedId ? getMessageText(db, quotedId) : null
    const prompt = buildPrompt({ context: recentContext(db, jid, config.contextMessages), question: text, quoted })

    const res = await generateReply({
      prompt, config, settingsPath: paths.settingsPath, claudePath,
      scratchDir: paths.scratchDir, systemAppend: HARDENING,
    })
    if (!res.ok) { log?.({ ts: started, sender, error: res.error }); return }

    const scan = scanReply(res.text)
    const body = scan.safe
      ? finalizeReply(res.text, config)
      : `${config.botPrefix} (מצטער, לא אשלח את זה)` // "sorry, I won't send that"

    const sent = await sock.sendMessage(jid, { text: body }, { quoted: msg })
    if (sent?.key?.id) sentIds.add(sent.key.id)
    log?.({ ts: started, sender, question: text, reply: body, ms: Date.now() - started,
            safe: scan.safe, matches: scan.matches })
  } finally {
    guardrails.end()
  }
}
