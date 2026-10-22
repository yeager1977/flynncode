const defaults: Record<string, string> = {
  ask: "var(--icon-agent-ask-base)",
  build: "var(--icon-agent-build-base)",
  docs: "var(--icon-agent-docs-base)",
  plan: "var(--icon-agent-plan-base)",
}

const palette = [
  "var(--icon-agent-ask-base)",
  "var(--icon-agent-build-base)",
  "var(--icon-agent-docs-base)",
  "var(--icon-agent-plan-base)",
  "var(--syntax-info)",
  "var(--syntax-success)",
  "var(--syntax-warning)",
  "var(--syntax-property)",
  "var(--syntax-constant)",
  "var(--text-diff-add-base)",
  "var(--text-diff-delete-base)",
  "var(--icon-warning-base)",
]

function tone(name: string) {
  let hash = 0
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return palette[hash % palette.length]
}

export function agentColor(name: string, custom?: string) {
  if (custom) return custom
  return defaults[name] ?? defaults[name.toLowerCase()] ?? tone(name.toLowerCase())
}

/**
 * The agent a project normally runs on: the one most of its sessions used.
 * Session lists label a session with its agent only when that agent differs
 * from this, so the everyday agent does not repeat on every row.
 */
export function commonAgent(sessions: readonly { agent?: string }[]) {
  const counts = new Map<string, number>()
  for (const session of sessions) {
    if (!session.agent) continue
    counts.set(session.agent, (counts.get(session.agent) ?? 0) + 1)
  }
  let common: string | undefined
  let highest = 0
  for (const [name, count] of counts) {
    if (count > highest) {
      common = name
      highest = count
    }
  }
  return common
}

export function messageAgentColor(
  list: readonly { role: string; agent?: string }[] | undefined,
  agents: readonly { name: string; color?: string }[],
) {
  if (!list) return undefined
  for (let i = list.length - 1; i >= 0; i--) {
    const item = list[i]
    if (item.role !== "user" || !item.agent) continue
    return agentColor(item.agent, agents.find((agent) => agent.name === item.agent)?.color)
  }
}
