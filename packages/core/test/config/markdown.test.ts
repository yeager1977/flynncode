import { describe, expect, test } from "bun:test"
import { ConfigMarkdown } from "../../src/config/markdown"

const frontmatter = (...lines: string[]) => ["---", ...lines, "---", "Body"].join("\n")

describe("ConfigMarkdown.parse fallback for invalid YAML", () => {
  test("a closing bracket inside quotes does not end a flow list", () => {
    const result = ConfigMarkdown.parse(frontmatter('tools: ["a]", b]', "hint: [x] [y]"))
    expect(result.data.tools).toEqual(["a]", "b"])
    expect(result.data.hint).toBe("[x] [y]")
  })

  test("single-quoted brackets do not end a flow list", () => {
    const result = ConfigMarkdown.parse(frontmatter("tools: ['a]', 'it''s]', c]", "hint: [x] [y]"))
    expect(result.data.tools).toEqual(["a]", "it's]", "c"])
  })

  test("an unterminated flow value with a colon is read as a string", () => {
    const result = ConfigMarkdown.parse(frontmatter("x: [a: b", "name: ok"))
    expect(result.data.x).toBe("[a: b")
    expect(result.data.name).toBe("ok")
  })

  test("an unterminated flow value without a colon stays invalid", () => {
    expect(() => ConfigMarkdown.parse(frontmatter("tools: [Read", "hint: [x] [y]"))).toThrow()
  })
})

test("an apostrophe inside a plain flow item is not a quote", () => {
  const result = ConfigMarkdown.parse(frontmatter("hint: [it's] [x]"))
  expect(result.data.hint).toBe("[it's] [x]")
})
