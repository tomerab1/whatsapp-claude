// server.mjs — the "boaz-tools" MCP stdio server. Registers the TV tools (and the weather
// tool, added in Phase 2). Boaz's `claude -p` loads this via --mcp-config; which tools it may
// actually CALL is gated by --allowedTools in the daemon (TV tools only when tvEnabled).
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { tvTools } from './tv.mjs'
import { weatherTool } from './weather.mjs'

const tools = [...tvTools, weatherTool]
const byName = new Map(tools.map((t) => [t.name, t]))

const server = new Server({ name: 'boaz-tools', version: '0.1.0' }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
}))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const t = byName.get(req.params.name)
  if (!t) return { content: [{ type: 'text', text: `unknown tool ${req.params.name}` }], isError: true }
  try { return await t.handler(req.params.arguments || {}) }
  catch (e) { return { content: [{ type: 'text', text: `error: ${e?.message || e}` }], isError: true } }
})

await server.connect(new StdioServerTransport())
