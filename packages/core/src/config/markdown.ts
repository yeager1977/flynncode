export * as ConfigMarkdown from "./markdown"

import matter from "gray-matter"
export function parse(content: string) {
  try {
    return matter(content)
  } catch {
    return matter(sanitize(content))
  }
}

export function parseOption(content: string) {
  try {
    return parse(content)
  } catch {
    return undefined
  }
}

// Other coding agents accept unquoted colons in frontmatter values, and
// Claude Code accepts values like `argument-hint: [pr-number] [priority]` that
// are not valid YAML flow sequences. Retry those values as YAML block scalars
// (plain strings) so existing config files keep working.
export function sanitize(content: string) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return content
  const frontmatter = match[1]
  const result = frontmatter.split(/\r?\n/).flatMap((line) => {
    if (line.trim().startsWith("#") || line.trim() === "" || /^\s+/.test(line)) return [line]
    const entry = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)$/)
    if (!entry) return [line]
    const value = entry[2].trim()
    if (value === "" || value === ">" || value === "|" || value.startsWith('"') || value.startsWith("'")) return [line]
    const flow = flowEnd(value)
    if (flow === value.length - 1) return [line]
    if (flow === undefined && !value.includes(":")) return [line]
    // An unterminated flow collection stays invalid so the file is reported.
    if (flow === -1) return [line]
    return [`${entry[1]}: |-`, `  ${value}`]
  })
  return content.replace(frontmatter, () => result.join("\n"))
}

// Index where a value's leading `[...]` or `{...}` closes, -1 when it never
// closes, undefined when the value is not a flow collection.
function flowEnd(value: string) {
  if (!value.startsWith("[") && !value.startsWith("{")) return undefined
  let depth = 0
  for (let index = 0; index < value.length; index++) {
    if (value[index] === "[" || value[index] === "{") depth++
    if (value[index] === "]" || value[index] === "}") depth--
    if (depth === 0) return index
  }
  return -1
}
