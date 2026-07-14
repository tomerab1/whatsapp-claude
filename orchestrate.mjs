// orchestrate.mjs — two roles, split by the outbox queue:
//   handleIncoming(msg) : decide + ENQUEUE (or owner-command / sarcasm / drop). Fast, no LLM.
//   processNext()       : the single worker's unit of work — claim → generate → send → mark.
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { recentContext, getMessageText, getRawMessage, extractText } from './store.mjs'
import { shouldReply, parseOwnerCommand } from './trigger.mjs'
import { buildPrompt, finalizeReply, hardening, sarcasmReply } from './compose.mjs'
import { generateReply } from './sandbox.mjs'
import { scanReply } from './scan.mjs'
import { enqueue, claimNext, recordReply, markSent, markFailed } from './outbox.mjs'
import { noteSpam } from './spam.mjs'

export function appendUsage(usagePath, entry) {
  mkdirSync(dirname(usagePath), { recursive: true })
  appendFileSync(usagePath, JSON.stringify(entry) + '\n')
}

const senderOf = (msg, jid) =>
  msg.key?.participant || msg.participant || (msg.key?.fromMe ? (msg.key?.participant || 'me') : jid)

// One incoming live message → owner command, enqueue, sarcasm, or drop. Never generates.
export async function handleIncoming(ctx) {
  const { sock, msg, db, guardrails, config, sentIds, log } = ctx
  const jid = config.groupJid
  if (msg.key?.remoteJid !== jid) return
  const { text } = extractText(msg)
  const sender = senderOf(msg, jid)

  // Owner kill switch first.
  const cmd = parseOwnerCommand(text, sender, config.ownerJid, config.triggers)
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
  if (gate.allowed) {
    guardrails.record(sender)
    const quotedId = msg.message?.extendedTextMessage?.contextInfo?.stanzaId || null
    const isNew = enqueue(db, {
      msgId: msg.key.id, chatJid: jid, senderJid: sender, senderName: msg.pushName || null,
      question: text, quotedId,
    })
    log?.({ ts: Date.now(), sender, event: isNew ? 'enqueued' : 'duplicate', question: text })
    return
  }

  if (gate.reason === 'cooldown') {
    // Spamming → escalate + maybe a rate-limited sarcastic reply. No LLM call, no cost.
    const s = noteSpam(db, sender, config.perUserCooldownSec * 1000)
    if (s.sarcasm) {
      const body = sarcasmReply(s.violations, config)
      const sent = await sock.sendMessage(jid, { text: body }, { quoted: msg })
      if (sent?.key?.id) sentIds.add(sent.key.id)
      log?.({ ts: Date.now(), sender, event: 'sarcasm', violations: s.violations })
    } else {
      log?.({ ts: Date.now(), sender, event: 'spam-muted', violations: s.violations })
    }
    return
  }

  log?.({ ts: Date.now(), sender, skipped: gate.reason }) // disabled | hourly-cap
}

// Process the next queued reply. Returns true if it handled a row (worker should look for
// more immediately), false if the queue was empty.
export async function processNext(ctx) {
  const { sock, db, config, paths, claudePath, sentIds, log } = ctx
  const row = claimNext(db)
  if (!row) return false

  try {
    let reply = row.reply
    if (reply == null) {
      // Generate once. A previously-generated reply is re-sent, never regenerated.
      const quoted = row.quoted_id ? getMessageText(db, row.quoted_id) : null
      const prompt = buildPrompt({
        context: recentContext(db, row.chat_jid, config.contextMessages),
        question: row.question, quoted,
      })
      const res = await generateReply({
        prompt, config, settingsPath: paths.settingsPath, claudePath,
        scratchDir: paths.scratchDir, systemAppend: hardening(config),
      })
      if (!res.ok) {
        const st = markFailed(db, row.msg_id, config.maxSendAttempts)
        log?.({ ts: Date.now(), sender: row.sender_jid, error: res.error, status: st })
        return true
      }
      const scan = scanReply(res.text)
      reply = scan.safe ? finalizeReply(res.text, config) : `${config.botPrefix} (מצטער, לא אשלח את זה)`
      recordReply(db, row.msg_id, reply) // persist BEFORE send → outbox durability
      if (!scan.safe) log?.({ ts: Date.now(), sender: row.sender_jid, blocked: scan.matches })
    }

    const quotedMsg = getRawMessage(db, row.msg_id) // quote the original if we still have it
    const sent = await sock.sendMessage(row.chat_jid, { text: reply }, quotedMsg ? { quoted: quotedMsg } : {})
    if (sent?.key?.id) sentIds.add(sent.key.id)
    markSent(db, row.msg_id, sent?.key?.id)
    log?.({ ts: Date.now(), sender: row.sender_jid, question: row.question, reply, event: 'sent' })
  } catch (e) {
    const st = markFailed(db, row.msg_id, config.maxSendAttempts)
    log?.({ ts: Date.now(), sender: row.sender_jid, error: e?.message || String(e), status: st })
  }
  return true
}
