// scan.mjs — backstop: refuse to send a reply that looks like it leaked a secret.
// The real defense is the tool sandbox; this catches anything that slips past.
export const SECRET_PATTERNS = [
  { name: 'unix-home-path', re: /\/Users\/[A-Za-z0-9._-]+\/(?:\.[A-Za-z0-9._-]+|[A-Za-z0-9._-]+)/ },
  { name: 'pem-block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'secret-env-line', re: /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY|PRIVATE_KEY))\b\s*[:=]\s*\S+/ },
]

export function scanReply(text) {
  const matches = SECRET_PATTERNS.filter((p) => p.re.test(text || '')).map((p) => p.name)
  return { safe: matches.length === 0, matches }
}
