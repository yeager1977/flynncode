const patterns: Array<{ kind: string; pattern: RegExp }> = [
  { kind: "github", pattern: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{8,}\b/g },
  // Anthropic and (live) Stripe tokens start with "sk", so they sit before the
  // broader openai pattern to get an accurate kind label.
  { kind: "anthropic", pattern: /\bsk-ant-[A-Za-z0-9_-]{2,}\b/g },
  { kind: "stripe", pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{5,}\b/g },
  { kind: "openai", pattern: /\bsk-(?:proj-|test-|live-)?[A-Za-z0-9_-]{8,}\b/g },
  { kind: "aws-key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: "slack", pattern: /\bxox[baprs]-[A-Za-z0-9-]{8,}\b/g },
  { kind: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { kind: "bearer", pattern: /Bearer\s+[A-Za-z0-9\-._~+/=]{8,}/g },
  { kind: "url-credentials", pattern: /(https?:\/\/)([^/\s:@]+):([^/\s@]+)@/g },
  {
    kind: "generic-secret",
    pattern:
      /((?:api[_-]?key|api[_-]?secret|secret|token|password|passwd|private[_-]?key)\s*[:=]\s*["']?)([^"'\s;,}]{8,})/gi,
  },
  { kind: "jwt", pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g },
  { kind: "gcp", pattern: /\bAIza[0-9A-Za-z_-]{4,}\b/g },
]

export const REDACTED = "[redacted]"

export function redactSecrets(input: string) {
  return patterns.reduce((acc, item) => {
    if (item.kind === "url-credentials") return acc.replace(item.pattern, "$1$2:[redacted:url-credentials]@")
    if (item.kind === "generic-secret") return acc.replace(item.pattern, "$1[redacted:generic-secret]")
    return acc.replace(item.pattern, `[redacted:${item.kind}]`)
  }, input)
}

export function containsSecret(input: string) {
  return redactSecrets(input) !== input
}

export * as MemoryRedact from "./redact"
