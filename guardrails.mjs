// guardrails.mjs — bounds unattended, other-driven LLM cost.
const HOUR_MS = 3_600_000

export function createGuardrails(config, now = () => Date.now()) {
  let enabled = config.enabled
  let inFlight = false
  const lastBySender = new Map() // senderJid -> ts of last allowed trigger
  let hourWindow = []            // ts of recent allowed triggers (trailing hour)
  const cooldownMs = config.perUserCooldownSec * 1000

  const prune = (t) => { hourWindow = hourWindow.filter((x) => t - x < HOUR_MS) }

  return {
    check(senderJid) {
      if (!enabled) return { allowed: false, reason: 'disabled' }
      if (inFlight) return { allowed: false, reason: 'busy' }
      const t = now()
      prune(t)
      if (hourWindow.length >= config.hourlyCap) return { allowed: false, reason: 'hourly-cap' }
      const last = lastBySender.get(senderJid)
      if (last != null && t - last < cooldownMs) return { allowed: false, reason: 'cooldown' }
      return { allowed: true, reason: null }
    },
    begin(senderJid) {
      const t = now()
      inFlight = true
      lastBySender.set(senderJid, t)
      hourWindow.push(t)
    },
    end() { inFlight = false },
    setEnabled(v) { enabled = !!v },
  }
}
