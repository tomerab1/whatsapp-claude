// poll.mjs — pure logic for turning a request into a native WhatsApp poll.
// Two sources: (1) a direct group command in the tagging message (parsePollCommand),
// and (2) the model's own reply emitting a fenced ```poll block (extractPollFromReply).
// buildPollMessage shapes the validated result into the Baileys send payload.
// No I/O, no Baileys import — just parsing and validation so it's trivially testable.

// Keyword that marks a poll request, in each supported language. Extensible: adding a
// word here is all that's needed to recognize a new phrasing.
export const POLL_KEYWORDS = ['poll', 'סקר']

// WhatsApp caps a poll at 12 options; a poll needs at least 2 to be meaningful.
export const MAX_OPTIONS = 12
const MIN_OPTIONS = 2

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Comma OR newline separate options in a list.
const OPTION_SEPARATORS = /[,\n]/

const dedupe = (items) => [...new Set(items)]

// Trim each option and drop empties, keeping order. The validator uses this alone so
// an out-of-range count still surfaces as an error rather than being silently capped.
const trimNonEmpty = (items) => items.map((s) => String(s).trim()).filter(Boolean)

// Trim, drop empties, dedupe, and cap at WhatsApp's max. Used by both parse paths.
function cleanOptions(items) {
  return dedupe(trimNonEmpty(items)).slice(0, MAX_OPTIONS)
}

function splitOptions(raw) {
  return cleanOptions((raw || '').split(OPTION_SEPARATORS))
}

function stripTriggers(text, triggers) {
  let out = text
  for (const trig of triggers || []) {
    if (!trig) continue
    out = out.replace(new RegExp(escapeRe(trig), 'gi'), ' ')
  }
  return out
}

// Locate the poll keyword as a standalone token and return everything after it
// (past an optional ":"). Returns null when no keyword token is present.
function bodyAfterKeyword(text) {
  const alt = POLL_KEYWORDS.map(escapeRe).join('|')
  const re = new RegExp(`(?:^|\\s)(?:${alt})(?=$|[\\s:?])\\s*:?\\s*([\\s\\S]+)$`, 'i')
  const m = text.match(re)
  return m ? m[1] : null
}

// Separate the question from the trailing options list. Preference order:
// a newline, then a "?", then a ":" — whichever first delimits the question.
function splitQuestionAndOptions(body) {
  const nl = body.indexOf('\n')
  if (nl !== -1) return { question: body.slice(0, nl), optionsRaw: body.slice(nl + 1) }

  const q = body.indexOf('?')
  if (q !== -1) return { question: body.slice(0, q + 1), optionsRaw: body.slice(q + 1) }

  const c = body.indexOf(':')
  if (c !== -1) return { question: body.slice(0, c), optionsRaw: body.slice(c + 1) }

  return { question: '', optionsRaw: body }
}

// Form (1): a direct user command such as "@boaz poll: best movie? a, b, c".
// `triggers` (e.g. ['@boaz','@בועז']) are stripped first. Returns null when the text
// is not a poll request or yields fewer than 2 options.
export function parsePollCommand(text, triggers) {
  if (!text) return null
  const body = bodyAfterKeyword(stripTriggers(text, triggers))
  if (body == null) return null

  const { question, optionsRaw } = splitQuestionAndOptions(body)
  const options = splitOptions(optionsRaw)
  if (options.length < MIN_OPTIONS) return null
  return { question: question.trim(), options }
}

const FENCE_RE = /```poll[^\n]*\n([\s\S]*?)```/i
const QUESTION_LINE_RE = /^question:\s*(.+)$/i
const OPTIONS_LINE_RE = /^options:\s*(.+)$/i
const BULLET_LINE_RE = /^[-*]\s+(.+)$/

// Form (2): the model chose to answer with a fenced poll block, e.g.
//   ```poll
//   question: Where to?
//   - Greece
//   - Italy
//   ```
// (`options:` as a one-line comma list is also accepted.) Returns null when there is
// no valid block: no fence, empty question, or fewer than 2 options.
export function extractPollFromReply(replyText) {
  const fence = (replyText || '').match(FENCE_RE)
  if (!fence) return null

  let question = ''
  const rawOptions = []
  for (const line of fence[1].split('\n')) {
    const trimmed = line.trim()
    const qm = trimmed.match(QUESTION_LINE_RE)
    if (qm) { question = qm[1].trim(); continue }
    const om = trimmed.match(OPTIONS_LINE_RE)
    if (om) { rawOptions.push(...om[1].split(',')); continue }
    const bm = trimmed.match(BULLET_LINE_RE)
    if (bm) rawOptions.push(bm[1])
  }

  const options = cleanOptions(rawOptions)
  if (!question || options.length < MIN_OPTIONS) return null
  return { question, options }
}

// Shape the Baileys send payload: sock.sendMessage(jid, buildPollMessage(...)).
// Validates the poll before it can be sent; throws a clear Error otherwise.
export function buildPollMessage({ question, options, selectableCount = 1 }) {
  const name = (question || '').trim()
  if (!name) throw new Error('poll question must be a non-empty string')

  const values = trimNonEmpty(Array.isArray(options) ? options : [])
  if (values.length < MIN_OPTIONS) {
    throw new Error(`poll needs at least ${MIN_OPTIONS} options, got ${values.length}`)
  }
  if (values.length > MAX_OPTIONS) {
    throw new Error(`poll allows at most ${MAX_OPTIONS} options, got ${values.length}`)
  }

  return { poll: { name, values, selectableCount } }
}
