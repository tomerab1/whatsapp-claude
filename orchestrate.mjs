// orchestrate.mjs — decide + enqueue on the way in; generate + deliver on the way out.
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join, basename } from 'node:path'
import { recentContext, getMessageText, getRawMessage, extractText } from './store.mjs'
import { shouldReply, parseAdminCommand, isBotEcho } from './trigger.mjs'
import { buildPrompt, finalizeReply, hardening, sarcasmReply, voiceRequested } from './compose.mjs'
import { generateReply } from './sandbox.mjs'
import { generateVision } from './vision.mjs'
import { scanReply } from './scan.mjs'
import { enqueue, claimNext, recordReply, markSent, markFailed, statusCounts, pendingCount } from './outbox.mjs'
import { noteSpam } from './spam.mjs'
import { isMuted, setMute, clearMute } from './mute.mjs'
import { wantsCatchup, catchupContext, keywordsFrom, searchHistory } from './memory.mjs'
import { parseReminder, addReminder } from './reminders.mjs'
import { parsePollCommand, buildPollMessage } from './poll.mjs'
import { transcribeAudio } from './transcribe.mjs'
import { synthesizeVoice } from './tts.mjs'

const MEMORY_LIMIT = 6
const CATCHUP_MSGS = 120

export function appendUsage(usagePath, entry) {
  mkdirSync(dirname(usagePath), { recursive: true })
  appendFileSync(usagePath, JSON.stringify(entry) + '\n')
}

const senderOf = (msg, jid) =>
  msg.key?.participant || msg.participant || (msg.key?.fromMe ? (msg.key?.participant || 'me') : jid)

const quotedSenderOf = (db, quotedId) =>
  quotedId ? (db.prepare(`SELECT sender_jid FROM messages WHERE id = ?`).get(quotedId)?.sender_jid ?? null) : null

async function send(sock, jid, content, quoted) {
  return sock.sendMessage(jid, content, quoted ? { quoted } : {})
}

// One incoming live message → admin action, poll, reminder, enqueue, sarcasm, or drop.
export async function handleIncoming(ctx) {
  const { sock, msg, db, guardrails, config, sentIds, log, downloadMedia, saveConfig } = ctx
  const jid = config.groupJid
  if (msg.key?.remoteJid !== jid) return
  const id = msg.key?.id
  if (id && sentIds?.has(id)) return
  const { kind, text } = extractText(msg)
  if (isBotEcho(text, config.botPrefix)) return
  const sender = senderOf(msg, jid)
  const ci = msg.message?.extendedTextMessage?.contextInfo
  const quotedId = ci?.stanzaId || null
  const quoted = quotedId ? getMessageText(db, quotedId) : null
  const quotedIsBot = !!(quoted && isBotEcho(quoted.text, config.botPrefix))
  const mentionedJids = ci?.mentionedJid || []

  // 1) Owner admin commands.
  const admin = parseAdminCommand(text, { senderJid: sender, ownerJid: config.ownerJid, triggers: config.triggers, quotedSenderJid: quotedSenderOf(db, quotedId), mentionedJids })
  if (admin) { await handleAdmin(ctx, admin, msg); return }

  // 2) Is this addressed to Boaz? Explicit @boaz, OR a reply to one of his messages.
  const addressed = shouldReply({ text, id, botPrefix: config.botPrefix, triggers: config.triggers, sentIds, quotedIsBot: config.followUps && quotedIsBot })
  const mediaAddressed = config.followUps && quotedIsBot // voice/image replying to Boaz count even without text
  const isMedia = kind === 'voice' || kind === 'image'
  const wantsBoaz = addressed || (isMedia && (mediaAddressed || (kind === 'image' && matchesCaptionTrigger(text, config.triggers))))
  if (!wantsBoaz) return

  // 3) Muted member → silently drop.
  if (isMuted(db, sender)) { log?.({ ts: Date.now(), sender, skipped: 'muted' }); return }

  // 4) Text-command intents (no LLM): reminders + polls.
  if (text) {
    const rem = parseReminder(text, config.triggers)
    if (rem) {
      addReminder(db, { chatJid: jid, dueTs: rem.dueTs, text: rem.text, createdBy: sender })
      const mins = Math.max(1, Math.round((rem.dueTs - Date.now()) / 60000))
      const sent = await send(sock, jid, { text: `${config.botPrefix} ⏰ אזכיר: "${rem.text}" (בעוד ~${mins} דק׳)` }, msg)
      if (sent?.key?.id) sentIds.add(sent.key.id)
      log?.({ ts: Date.now(), sender, event: 'reminder-set', dueTs: rem.dueTs })
      return
    }
    const poll = parsePollCommand(text, config.triggers)
    if (poll) {
      try {
        const sent = await send(sock, jid, buildPollMessage(poll), msg)
        if (sent?.key?.id) sentIds.add(sent.key.id)
        log?.({ ts: Date.now(), sender, event: 'poll', options: poll.options.length })
      } catch (e) { log?.({ ts: Date.now(), sender, error: 'poll:' + (e?.message || e) }) }
      return
    }
  }

  // 5) A real question (text / voice / image) → rate-limit, then enqueue.
  const gate = guardrails.check(sender)
  if (!gate.allowed) {
    if (gate.reason === 'cooldown') {
      const s = noteSpam(db, sender, config.perUserCooldownSec * 1000)
      const line = s.sarcasm ? sarcasmReply(s.violations, config) : null
      if (line) {
        const sent = await send(sock, jid, { text: line }, msg)
        if (sent?.key?.id) sentIds.add(sent.key.id)
        log?.({ ts: Date.now(), sender, event: 'sarcasm', violations: s.violations })
      } else log?.({ ts: Date.now(), sender, event: 'spam-muted', violations: s.violations })
    } else log?.({ ts: Date.now(), sender, skipped: gate.reason })
    return
  }
  guardrails.record(sender)

  let mediaKind = null, mediaPath = null, question = text
  try {
    if (kind === 'voice' && config.voice) { mediaPath = await downloadMedia(msg, 'voice'); mediaKind = 'voice'; question = '' }
    else if (kind === 'image' && config.vision) { mediaPath = await downloadMedia(msg, 'image'); mediaKind = 'image' }
  } catch (e) { log?.({ ts: Date.now(), sender, error: 'download:' + (e?.message || e) }) }

  enqueue(db, {
    msgId: id, chatJid: jid, senderJid: sender, senderName: msg.pushName || null,
    question, quotedId, mediaKind, mediaPath, wantVoice: config.voice && voiceRequested(text),
  })
  log?.({ ts: Date.now(), sender, event: 'enqueued', kind: mediaKind || 'text' })
}

function matchesCaptionTrigger(caption, triggers) {
  const hay = (caption || '').toLowerCase()
  return triggers.some((t) => hay.includes(t.toLowerCase()))
}

async function handleAdmin(ctx, admin, msg) {
  const { sock, db, config, sentIds, log, saveConfig, guardrails } = ctx
  const jid = config.groupJid
  const note = async (t) => { const s = await send(sock, jid, { text: `${config.botPrefix} ${t}` }, msg); if (s?.key?.id) sentIds.add(s.key.id) }
  switch (admin.cmd) {
    case 'on': case 'off': {
      const on = admin.cmd === 'on'; guardrails.setEnabled(on); config.enabled = on; saveConfig?.(config)
      await note(on ? 'online' : 'muted.'); break
    }
    case 'sarcasm': config.sarcasmLevel = admin.level; saveConfig?.(config); await note(`sarcasm = ${admin.level}`); break
    case 'mute': setMute(db, admin.target, Date.now() + admin.durationSec * 1000); await note(`הושתק ל-${Math.round(admin.durationSec / 60)} דק׳`); break
    case 'unmute': clearMute(db, admin.target); await note('בוטלה ההשתקה'); break
    case 'stats': {
      const sc = statusCounts(db)
      await note(`נשלחו ${sc.done || 0} · בתור ${pendingCount(db)} · נכשלו ${sc.failed || 0}`); break
    }
  }
  log?.({ ts: Date.now(), sender: config.ownerJid, event: 'admin:' + admin.cmd })
}

// Process one queued reply: transcribe/vision/text → scan → deliver (text or voice).
export async function processNext(ctx) {
  const { sock, db, config, paths, claudePath, sentIds, log } = ctx
  const row = claimNext(db)
  if (!row) return false

  sock?.sendPresenceUpdate?.('composing', row.chat_jid).catch?.(() => {})
  try {
    let reply = row.reply
    if (reply == null) {
      let question = row.question
      if (row.media_kind === 'voice' && row.media_path) {
        try { question = (await transcribeAudio(row.media_path)) || '' } catch (e) { question = '' }
        if (!question) { reply = `${config.botPrefix} לא הצלחתי לפענח את ההקלטה 🎧`; recordReply(db, row.msg_id, reply) }
      }

      if (reply == null) {
        let res
        if (row.media_kind === 'image' && row.media_path) {
          res = await generateVision({ imageName: basename(row.media_path), question, config, settingsPath: paths.visionSettingsPath, claudePath, mediaDir: paths.mediaDir })
        } else {
          const context = wantsCatchup(question) ? catchupContext(db, row.chat_jid, CATCHUP_MSGS) : recentContext(db, row.chat_jid, config.contextMessages)
          const memory = searchHistory(db, row.chat_jid, keywordsFrom(question, config.triggers), { limit: MEMORY_LIMIT, sinceTs: context[0]?.ts ?? null })
          const quoted = row.quoted_id ? getMessageText(db, row.quoted_id) : null
          res = await generateReply({ prompt: buildPrompt({ context, question, quoted, memory }), config, settingsPath: paths.settingsPath, claudePath, scratchDir: paths.scratchDir, systemAppend: hardening(config) })
        }
        if (!res.ok) { const st = markFailed(db, row.msg_id, config.maxSendAttempts); log?.({ ts: Date.now(), sender: row.sender_jid, error: res.error, status: st }); return true }
        const scan = scanReply(res.text)
        reply = scan.safe ? finalizeReply(res.text, config) : `${config.botPrefix} (מצטער, לא אשלח את זה)`
        recordReply(db, row.msg_id, reply)
      }
    }

    const quotedMsg = getRawMessage(db, row.msg_id)
    const sent = await deliver(sock, row.chat_jid, reply, quotedMsg, !!row.want_voice, config, paths)
    if (sent?.key?.id) sentIds.add(sent.key.id)
    markSent(db, row.msg_id, sent?.key?.id)
    log?.({ ts: Date.now(), sender: row.sender_jid, question: row.question, reply, event: 'sent', kind: row.media_kind || 'text' })
  } catch (e) {
    const st = markFailed(db, row.msg_id, config.maxSendAttempts)
    log?.({ ts: Date.now(), sender: row.sender_jid, error: e?.message || String(e), status: st })
  } finally {
    sock?.sendPresenceUpdate?.('paused', row.chat_jid).catch?.(() => {})
  }
  return true
}

async function deliver(sock, jid, reply, quotedMsg, wantVoice, config, paths) {
  if (wantVoice && config.voice) {
    try {
      const spoken = reply.startsWith(config.botPrefix) ? reply.slice(config.botPrefix.length).trim() : reply
      const outPath = join(paths.mediaDir, `tts-${Date.now()}.ogg`)
      await synthesizeVoice(spoken, outPath)
      return sock.sendMessage(jid, { audio: { url: outPath }, ptt: true, mimetype: 'audio/ogg; codecs=opus' }, quotedMsg ? { quoted: quotedMsg } : {})
    } catch (e) { /* fall back to text */ }
  }
  return sock.sendMessage(jid, { text: reply }, quotedMsg ? { quoted: quotedMsg } : {})
}
