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
    // An unterminated flow collection stays invalid so the file is reported,
    // unless a colon makes it one of the strings this fallback always rescued.
    if (flow === -1 && !value.includes(":")) return [line]
    return [`${entry[1]}: |-`, `  ${value}`]
  })
  return content.replace(frontmatter, () => result.join("\n"))
}

// Index where a value's leading `[...]` or `{...}` closes, -1 when it never
// closes, undefined when the value is not a flow collection. Brackets inside
// quoted scalars do not count. A quote opens a scalar only at the start of a
// node, so the apostrophe in `[it's]` is plain text.
function flowEnd(value: string) {
  if (!value.startsWith("[") && !value.startsWith("{")) return undefined
  let depth = 0
  let quote = ""
  for (let index = 0; index < value.length; index++) {
    const char = value[index]
    if (quote) {
      // `\"` and `''` are escaped quotes inside the scalar.
      if ((char === "\\" && quote === '"') || (char === "'" && quote === "'" && value[index + 1] === "'")) {
        index++
        continue
      }
      if (char === quote) quote = ""
      continue
    }
    if ((char === '"' || char === "'") && /[[{,:]$/.test(value.slice(0, index).trimEnd())) quote = char
    if (char === "[" || char === "{") depth++
    if (char === "]" || char === "}") depth--
    if (depth === 0) return index
  }
  return -1
}
