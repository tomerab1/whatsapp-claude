// kg.mjs — build/query Boaz's group knowledge graph.
//   node bin/kg.mjs backfill [maxBatches]   drain history through claude -p extraction (default 20)
//   node bin/kg.mjs extract [maxBatches]     incremental: only new messages since the watermark (default 3)
//   node bin/kg.mjs stats                    node/edge counts + watermark
//   node bin/kg.mjs query <text>             search the graph
import { execSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { loadConfig, DB_PATH, SETTINGS_PATH, SCRATCH_DIR } from '../src/config.mjs'
import { openDb } from '../src/wa/store.mjs'
import { writeLockedSettings } from '../src/reply/sandbox.mjs'
import { initKg, mergeExtraction, kgStats, kgSearch, getWatermark } from '../src/kg/kg.mjs'
import { nextBatch, runExtraction } from '../src/kg/extract.mjs'
import { formatKg } from '../src/tools/kg-tool.mjs'

const cmd = process.argv[2]
const config = loadConfig()
const db = initKg(openDb(DB_PATH))
const resolveClaude = () => execSync('command -v claude', { shell: '/bin/zsh' }).toString().trim()

if (cmd === 'stats') {
  console.log(kgStats(db))
} else if (cmd === 'query') {
  const q = process.argv.slice(3).join(' ')
  console.log(formatKg(kgSearch(db, q.split(/\s+/).filter(Boolean), 12)))
} else if (cmd === 'backfill' || cmd === 'extract') {
  if (!config.groupJid) { console.error('no groupJid in config'); process.exit(1) }
  mkdirSync(SCRATCH_DIR, { recursive: true })
  writeLockedSettings(SETTINGS_PATH, config)
  const claudePath = resolveClaude()
  const maxBatches = Number(process.argv[3]) || (cmd === 'extract' ? 3 : 20)
  let n = 0
  while (n < maxBatches) {
    const batch = nextBatch(db, config.groupJid, getWatermark(db), 120)
    if (!batch.messages.length) { console.log('nothing new to extract'); break }
    process.stdout.write(`batch ${n + 1}: ${batch.messages.length} msgs (≤ts ${batch.throughTs}, ${batch.remaining} left) … `)
    const ext = await runExtraction(batch, { config, settingsPath: SETTINGS_PATH, claudePath, scratchDir: SCRATCH_DIR })
    mergeExtraction(db, { nodes: ext.nodes, edges: ext.edges, throughTs: batch.throughTs })
    console.log(`+${ext.nodes.length} nodes +${ext.edges.length} edges${ext.error ? ' (err: ' + ext.error + ')' : ''}`)
    n++
    if (batch.remaining === 0) break
  }
  console.log('graph:', kgStats(db))
} else {
  console.log('usage: node bin/kg.mjs <backfill [maxBatches] | extract [maxBatches] | stats | query <text>>')
}
db.close()
process.exit(0)
