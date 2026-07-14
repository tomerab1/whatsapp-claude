// kg-tool.mjs — the kg_search MCP tool. Opens messages.db (env KG_DB) read-only and queries
// the group knowledge graph. Free (local SQLite) so it's always available to Boaz.
import Database from 'better-sqlite3'
import { kgSearch } from '../kg/kg.mjs'
import { keywordsFrom } from '../recall/memory.mjs'

function openKgDb() {
  const p = process.env.KG_DB
  if (!p) throw new Error('KG_DB not set')
  return new Database(p, { readonly: true })
}

export function formatKg({ nodes, edges }) {
  if (!nodes.length) return '(nothing in the group knowledge graph about that)'
  const label = new Map(nodes.map((n) => [n.id, n.label || n.id]))
  const name = (id) => label.get(id) || id
  const lines = nodes.map((n) => `• ${n.label}${n.summary ? ' — ' + n.summary : ''}`)
  for (const e of edges) lines.push(`  ${name(e.src)} —${e.rel}→ ${name(e.dst)}${e.note ? ' (' + e.note + ')' : ''}`)
  return lines.join('\n')
}

export const kgTool = {
  name: 'kg_search',
  description: "Search the group's knowledge graph — facts, decisions, plans, who-does-what distilled from the chat history. Use for recall questions like \"what did we decide about X\", \"when is the trip\", \"who is bringing what\".",
  inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  handler: async ({ query }) => {
    const db = openKgDb()
    try {
      const terms = keywordsFrom(query, [])
      const res = kgSearch(db, terms.length ? terms : [String(query || '')], 12)
      return { content: [{ type: 'text', text: formatKg(res) }] }
    } finally { db.close() }
  },
}
