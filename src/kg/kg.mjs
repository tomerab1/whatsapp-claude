// kg.mjs — the knowledge graph store (SQLite) + entity-resolving upserts and search.
// Pure over a db handle (tests use :memory:). Mirrors whatsapp-kg's node/edge model.
const uniq = (a) => [...new Set((a || []).filter(Boolean))]
const j = (a) => JSON.stringify(uniq(a))
const now0 = () => Date.now()

export function initKg(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS kg_nodes (
      id TEXT PRIMARY KEY, type TEXT, label TEXT, aliases TEXT, summary TEXT, msg_ids TEXT, updated_ts INTEGER
    );
    CREATE TABLE IF NOT EXISTS kg_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      src TEXT NOT NULL, rel TEXT NOT NULL, dst TEXT NOT NULL, note TEXT, ts INTEGER, msg_ids TEXT,
      UNIQUE(src, rel, dst)
    );
    CREATE TABLE IF NOT EXISTS kg_state (key TEXT PRIMARY KEY, value TEXT);
  `)
  return db
}

// Insert a node, or MERGE into an existing one by id: latest label/summary win; aliases and
// msg_ids are unioned (entity resolution — reusing an id extends the node, never duplicates).
export function upsertNode(db, node, now = now0) {
  const cur = db.prepare('SELECT * FROM kg_nodes WHERE id = ?').get(node.id)
  const aliases = uniq([...(cur ? JSON.parse(cur.aliases || '[]') : []), ...(node.aliases || [])])
  const msgIds = uniq([...(cur ? JSON.parse(cur.msg_ids || '[]') : []), ...(node.msg_ids || [])])
  db.prepare(`INSERT INTO kg_nodes (id, type, label, aliases, summary, msg_ids, updated_ts)
              VALUES (@id, @type, @label, @aliases, @summary, @msg_ids, @ts)
              ON CONFLICT(id) DO UPDATE SET type=@type, label=@label, aliases=@aliases, summary=@summary, msg_ids=@msg_ids, updated_ts=@ts`)
    .run({ id: node.id, type: node.type ?? cur?.type ?? null, label: node.label ?? cur?.label ?? null,
      aliases: JSON.stringify(aliases), summary: node.summary ?? cur?.summary ?? '', msg_ids: JSON.stringify(msgIds), ts: now() })
}

// Insert an edge, or union msg_ids into an existing (src,rel,dst).
export function upsertEdge(db, edge) {
  const cur = db.prepare('SELECT * FROM kg_edges WHERE src=? AND rel=? AND dst=?').get(edge.src, edge.rel, edge.dst)
  if (cur) {
    const msgIds = uniq([...JSON.parse(cur.msg_ids || '[]'), ...(edge.msg_ids || [])])
    db.prepare('UPDATE kg_edges SET note=?, ts=?, msg_ids=? WHERE id=?').run(edge.note ?? cur.note, edge.ts ?? cur.ts, JSON.stringify(msgIds), cur.id)
  } else {
    db.prepare('INSERT INTO kg_edges (src, rel, dst, note, ts, msg_ids) VALUES (?,?,?,?,?,?)')
      .run(edge.src, edge.rel, edge.dst, edge.note ?? null, edge.ts ?? null, j(edge.msg_ids))
  }
}

export function mergeExtraction(db, { nodes = [], edges = [], throughTs }) {
  const tx = db.transaction(() => {
    for (const n of nodes) if (n?.id) upsertNode(db, n)
    for (const e of edges) if (e?.src && e?.rel && e?.dst) upsertEdge(db, e)
    if (throughTs != null) setWatermark(db, throughTs)
  })
  tx()
}

export function kgEntities(db) {
  return db.prepare('SELECT id, label, aliases FROM kg_nodes').all().map((r) => ({ id: r.id, label: r.label, aliases: JSON.parse(r.aliases || '[]') }))
}

// Find nodes whose label/aliases/summary match any term, plus edges touching them.
export function kgSearch(db, terms, limit = 12) {
  const words = (Array.isArray(terms) ? terms : [terms]).filter(Boolean)
  if (!words.length) return { nodes: [], edges: [] }
  const likes = words.map(() => '(label LIKE ? OR aliases LIKE ? OR summary LIKE ?)').join(' OR ')
  const params = words.flatMap((w) => [`%${w}%`, `%${w}%`, `%${w}%`])
  const nodes = db.prepare(`SELECT id, type, label, aliases, summary FROM kg_nodes WHERE ${likes} LIMIT ?`).all(...params, limit)
    .map((r) => ({ ...r, aliases: JSON.parse(r.aliases || '[]') }))
  if (!nodes.length) return { nodes: [], edges: [] }
  const ids = nodes.map((n) => n.id)
  const ph = ids.map(() => '?').join(',')
  const edges = db.prepare(`SELECT src, rel, dst, note, ts FROM kg_edges WHERE src IN (${ph}) OR dst IN (${ph}) LIMIT ?`).all(...ids, ...ids, limit * 2)
  return { nodes, edges }
}

export function kgStats(db) {
  return {
    nodes: db.prepare('SELECT COUNT(*) c FROM kg_nodes').get().c,
    edges: db.prepare('SELECT COUNT(*) c FROM kg_edges').get().c,
    watermark: getWatermark(db),
  }
}

export function getWatermark(db) {
  const r = db.prepare("SELECT value FROM kg_state WHERE key='last_extracted_ts'").get()
  return r ? Number(r.value) : 0
}
export function setWatermark(db, ts) {
  db.prepare("INSERT INTO kg_state (key, value) VALUES ('last_extracted_ts', ?) ON CONFLICT(key) DO UPDATE SET value=?").run(String(ts), String(ts))
}
