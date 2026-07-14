// extract.mjs — turn a batch of group messages into KG nodes/edges via claude -p.
// Pure helpers here (batch/prompt/parse); the LLM call reuses generateReply (Claude Code,
// no SDK). Matches whatsapp-kg: hand Claude new messages + known entities, merge the result.
import { kgEntities, getWatermark } from './kg.mjs'
import { generateReply } from '../reply/sandbox.mjs'

// Messages after `sinceTs` for the group, plus the entities already in the graph (for
// resolution). throughTs = the max ts in this batch (the watermark to advance to).
export function nextBatch(db, chatJid, sinceTs, limit = 150) {
  const messages = db.prepare(
    `SELECT id, sender_name, ts, kind, text FROM messages WHERE chat_jid = ? AND ts > ? AND text <> '' ORDER BY ts LIMIT ?`,
  ).all(chatJid, sinceTs, limit)
  const after = messages.length ? messages[messages.length - 1].ts : sinceTs
  const remaining = db.prepare(`SELECT COUNT(*) c FROM messages WHERE chat_jid = ? AND ts > ? AND text <> ''`).get(chatJid, after).c
  return { messages, entities: kgEntities(db), throughTs: after, remaining }
}

export const EXTRACT_SYSTEM = [
  'You extract a knowledge graph from a WhatsApp group chat. Output ONLY JSON — no prose.',
  'Reuse an existing entity id when the batch refers to the same thing (Hebrew and transliteration',
  'are the same entity). Skip greetings/chatter; capture facts, decisions, plans, who-does-what,',
  'shared resources, recurring topics. Every node/edge cites the supporting message ids.',
].join(' ')

export function buildExtractPrompt({ messages, entities }) {
  const ents = entities.length
    ? entities.map((e) => `${e.id} = ${e.label}${e.aliases?.length ? ' (' + e.aliases.join(', ') + ')' : ''}`).join('\n')
    : '(none yet)'
  const msgs = messages.map((m) => `[${m.id}] ${m.sender_name || '?'}: ${m.text}`).join('\n')
  return [
    'KNOWN ENTITIES (reuse these ids when it is the same thing):',
    ents,
    '',
    'NEW MESSAGES:',
    msgs,
    '',
    'Return JSON exactly like:',
    '{"nodes":[{"id":"type:slug","type":"...","label":"...","aliases":["..."],"summary":"...","msg_ids":["<id>"]}],',
    ' "edges":[{"src":"type:slug","rel":"...","dst":"type:slug","note":"...","ts":<unix>,"msg_ids":["<id>"]}]}',
    'Use id = type:slug (e.g. plan:greece-trip, person:idan, resource:tent). JSON only.',
  ].join('\n')
}

// Robustly pull the {nodes,edges} object out of the model's output (fenced or bare).
export function parseExtraction(text) {
  const empty = { nodes: [], edges: [] }
  if (!text) return empty
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidates = []
  if (fence) candidates.push(fence[1])
  const first = text.indexOf('{'), last = text.lastIndexOf('}')
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1))
  for (const c of candidates) {
    try {
      const o = JSON.parse(c)
      if (o && (Array.isArray(o.nodes) || Array.isArray(o.edges))) return { nodes: o.nodes || [], edges: o.edges || [] }
    } catch {}
  }
  return empty
}

// Run one extraction batch through claude -p (no MCP, no tools). Returns {nodes, edges}.
export async function runExtraction(batch, { config, settingsPath, claudePath, scratchDir }) {
  const res = await generateReply({
    prompt: buildExtractPrompt(batch), config, settingsPath, claudePath, scratchDir,
    systemAppend: EXTRACT_SYSTEM, mcpTools: [], // extraction needs no tools
  })
  return res.ok ? parseExtraction(res.text) : { nodes: [], edges: [], error: res.error }
}

export { getWatermark }
