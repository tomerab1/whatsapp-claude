// guardrails.mjs — admission control for the outbox queue. Bounds unattended,
// other-driven LLM cost. Concurrency is handled by the single outbox worker, so
// there is no "busy" state here anymore: a tag that arrives mid-answer is queued,
// not dropped. These limits only drop true spam (per-user cooldown) and runaway
// cost (global hourly cap).
const HOUR_MS = 3_600_000

export function createGuardrails(config, now = () => Date.now()) {
  let enabled = config.enabled
  const lastBySender = new Map() // senderJid -> ts of last ADMITTED trigger
  let hourWindow = []            // ts of recent admitted triggers (trailing hour)
  const cooldownMs = config.perUserCooldownSec * 1000

  const prune = (t) => { hourWindow = hourWindow.filter((x) => t - x < HOUR_MS) }

  return {
    check(senderJid) {
      if (!enabled) return { allowed: false, reason: 'disabled' }
      const t = now()
      prune(t)
      if (hourWindow.length >= config.hourlyCap) return { allowed: false, reason: 'hourly-cap' }
      const last = lastBySender.get(senderJid)
      if (last != null && t - last < cooldownMs) return { allowed: false, reason: 'cooldown' }
      return { allowed: true, reason: null }
    },
    // Call only after an allowed check, when the request is actually admitted (enqueued).
    record(senderJid) {
      const t = now()
      lastBySender.set(senderJid, t)
      hourWindow.push(t)
    },
    setEnabled(v) { enabled = !!v },
    // Reset ONLY the group-wide hourly cap. Per-user cooldowns are left intact.
    clearHourly() { hourWindow = [] },
  }
}
