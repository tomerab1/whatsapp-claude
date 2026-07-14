// orchestrate.mjs — decide + enqueue on the way in; generate + deliver on the way out.
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join, basename } from 'node:path'
import { recentContext, getMessageText, getRawMessage, extractText } from '../wa/store.mjs'
import { shouldReply, parseAdminCommand, isBotEcho } from '../gate/trigger.mjs'
import { buildPrompt, finalizeReply, hardening, sarcasmReply, voiceRequested, TV_GUARDRAIL } from '../reply/compose.mjs'
import { generateReply } from '../reply/sandbox.mjs'
import { generateVision } from '../media/vision.mjs'
import { scanReply } from '../reply/scan.mjs'
import { enqueue, claimNext, recordReply, markSent, markFailed, statusCounts, pendingCount } from '../queue/outbox.mjs'
import { noteSpam } from '../gate/spam.mjs'
import { isMuted, setMute, clearMute } from '../gate/mute.mjs'
import { wantsCatchup, catchupContext, keywordsFrom, searchHistory } from '../recall/memory.mjs'
import { parseReminder, addReminder } from '../recall/reminders.mjs'
import { parsePollCommand, buildPollMessage } from '../poll.mjs'
import { transcribeAudio } from '../media/transcribe.mjs'
import { synthesizeVoice } from '../media/tts.mjs'

const MEMORY_LIMIT = 6
const CATCHUP_MSGS = 120

export function appendUsage(usagePath, entry) {
  mkdirSync(dirname(usagePath), { recursive: true })
  appendFileSync(usagePath, JSON.stringify(entry) + '\n')
}

const senderOf = (msg, jid) =>
  msg.key?.participant || msg.participant || (msg.key?.fromMe ? (msg.key?.participant || 'me') : jid)

// contextInfo (quote/mentions) lives under whichever message subtype it is — a voice
// note carries it under audioMessage, an image under imageMessage, etc. (NOT only text).
const contextInfoOf = (msg) => {
  const m = msg.message || {}
  return m.extendedTextMessage?.contextInfo || m.imageMessage?.contextInfo || m.videoMessage?.contextInfo
    || m.audioMessage?.contextInfo || m.documentMessage?.contextInfo || m.stickerMessage?.contextInfo || null
}

const audioSeconds = (msg) => {
  const s = msg.message?.audioMessage?.seconds
  return typeof s === 'number' ? s : s?.toNumber ? s.toNumber() : s != null ? Number(s) : null
}

// The spoken wake-word: any trigger with its leading @ stripped (e.g. "בועז", "boaz").
const hasWakeWord = (text, triggers) => {
  const hay = (text || '').toLowerCase()
  return (triggers || []).some((t) => hay.includes(t.replace(/^@/, '').toLowerCase()))
}

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
  const ci = contextInfoOf(msg)
  const quotedId = ci?.stanzaId || null
  const quoted = quotedId ? getMessageText(db, quotedId) : null
  const quotedIsBot = !!(quoted && isBotEcho(quoted.text, config.botPrefix))
  const mentionedJids = ci?.mentionedJid || []

  // 1) Owner admin commands.
  // The paired account IS the owner, so any non-bot fromMe message is the owner (bot echoes
  // already returned above). This is reliable in-group where the owner's jid is a @lid.
  const admin = parseAdminCommand(text, { isOwner: !!msg.key?.fromMe, senderJid: sender, ownerJid: config.ownerJid, triggers: config.triggers, quotedSenderJid: quotedSenderOf(db, quotedId), mentionedJids })
  if (admin) { await handleAdmin(ctx, admin, msg); return }

  // 2) Is this addressed to Boaz? Explicit @boaz, OR a reply to one of his messages.
  const addressed = shouldReply({ text, id, botPrefix: config.botPrefix, triggers: config.triggers, sentIds, quotedIsBot: config.followUps && quotedIsBot })
  const mediaAddressed = config.followUps && quotedIsBot // voice/image replying to Boaz count even without text
  const isMedia = kind === 'voice' || kind === 'image'
  const wantsBoaz = addressed || (isMedia && (mediaAddressed || (kind === 'image' && matchesCaptionTrigger(text, config.triggers))))

  // Cold voice note (not a reply to Boaz): transcribe locally (free) and reply only if
  // "בועז" is spoken. Bypasses reply-guardrails at enqueue — transcription costs nothing;
  // the LLM cost is gated later (after the wake-word matches) in processNext.
  if (!wantsBoaz && kind === 'voice' && config.voice && config.voiceWakeword) {
    const dur = audioSeconds(msg)
    if (dur != null && dur > config.voiceMaxSec) return // skip long clips (bounds CPU)
    if (isMuted(db, sender)) return
    let mediaPath = null
    try { mediaPath = await downloadMedia(msg, 'voice') } catch (e) { log?.({ ts: Date.now(), sender, error: 'download:' + (e?.message || e) }); return }
    enqueue(db, { msgId: id, chatJid: jid, senderJid: sender, senderName: msg.pushName || null, question: '', mediaKind: 'voice', mediaPath, wantScan: true })
    log?.({ ts: Date.now(), sender, event: 'voice-scan-enqueued', durationSec: dur })
    return
  }
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
    case 'tv': config.tvEnabled = admin.on; saveConfig?.(config); await note(admin.on ? 'שולט בטלוויזיה עכשיו 📺' : 'שליטת הטלוויזיה כבויה'); break
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
  const { sock, db, config, paths, claudePath, sentIds, log, guardrails } = ctx
  const row = claimNext(db)
  if (!row) return false

  sock?.sendPresenceUpdate?.('composing', row.chat_jid).catch?.(() => {})
  try {
    let reply = row.reply
    let wantVoice = !!row.want_voice
    if (reply == null) {
      let question = row.question
      if (row.media_kind === 'voice' && row.media_path) {
        try { question = (await transcribeAudio(row.media_path, { model: config.whisperModel, language: config.whisperLang })) || '' } catch (e) { question = '' }
        // The voice request ("בהקלטה"/"out loud") lives in the SPOKEN transcript, not the
        // (empty) message text — so decide voice-mode here, and persist the transcript.
        if (question) {
          if (config.voice && voiceRequested(question)) wantVoice = true
          db.prepare(`UPDATE outbox SET question = ? WHERE msg_id = ?`).run(question, row.msg_id)
        }
        if (row.want_scan) {
          // Cold voice note: only reply if "בועז" was actually spoken (wake-word + variants).
          const wakeList = [...(config.triggers || []), ...(config.voiceWakeExtra || [])]
          if (!question || !hasWakeWord(question, wakeList)) {
            markSent(db, row.msg_id, null)
            log?.({ ts: Date.now(), sender: row.sender_jid, event: 'voice-no-wake', transcript: (question || '').slice(0, 60) })
            return true
          }
          // Wake matched → now it's a real question; apply the reply guardrails (LLM cost).
          const gate = guardrails?.check(row.sender_jid)
          if (gate && !gate.allowed) { markSent(db, row.msg_id, null); log?.({ ts: Date.now(), sender: row.sender_jid, skipped: gate.reason }); return true }
          guardrails?.record(row.sender_jid)
        }
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
          // Tools: weather always; TV tools only when enabled (owner kill-switch).
          const T = (n) => `mcp__boaz-tools__${n}`
          const tvToolNames = ['list_devices', 'get_focused_app', 'press_key', 'tap', 'launch_app', 'open_url', 'inspect_screen', 'screenshot'].map(T)
          const mcpTools = [T('get_weather'), T('kg_search'), ...(config.tvEnabled ? tvToolNames : [])]
          const systemAppend = hardening(config, { voice: wantVoice }) + (config.tvEnabled ? '\n\n' + TV_GUARDRAIL : '')
          res = await generateReply({
            prompt: buildPrompt({ context, question, quoted, memory }), config,
            settingsPath: paths.settingsPath, claudePath, scratchDir: paths.scratchDir, systemAppend,
            mcpConfigPath: paths.toolsConfigPath, mcpTools, maxTurns: config.tvMaxTurns,
          })
        }
        if (!res.ok) { const st = markFailed(db, row.msg_id, config.maxSendAttempts); log?.({ ts: Date.now(), sender: row.sender_jid, error: res.error, status: st }); return true }
        const scan = scanReply(res.text)
        reply = scan.safe ? finalizeReply(res.text, config) : `${config.botPrefix} (מצטער, לא אשלח את זה)`
        recordReply(db, row.msg_id, reply)
      }
    }

    const quotedMsg = getRawMessage(db, row.msg_id)
    const sent = await deliver(sock, row.chat_jid, reply, quotedMsg, wantVoice, config, paths, log)
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

async function deliver(sock, jid, reply, quotedMsg, wantVoice, config, paths, log) {
  const quoted = quotedMsg ? { quoted: quotedMsg } : {}
  if (wantVoice && config.voice) {
    try {
      const spoken = reply.startsWith(config.botPrefix) ? reply.slice(config.botPrefix.length).trim() : reply
      const outPath = join(paths.mediaDir, `tts-${Date.now()}.ogg`)
      await synthesizeVoice(spoken, outPath)
      const sent = await sock.sendMessage(jid, { audio: { url: outPath }, ptt: true, mimetype: 'audio/ogg; codecs=opus' }, quoted)
      log?.({ ts: Date.now(), event: 'voice-sent' })
      return sent
    } catch (e) { log?.({ ts: Date.now(), event: 'voice-fallback', error: e?.message || String(e) }) }
  }
  return sock.sendMessage(jid, { text: reply }, quoted)
}
