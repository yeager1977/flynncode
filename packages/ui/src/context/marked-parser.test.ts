import { expect, test } from "bun:test"
import { createMarkdownParser } from "./marked-parser"

const parser = createMarkdownParser((code, language) => `<pre data-language="${language}">${code}</pre>`)

test.each([
  ["OpenCode", "OpenCode"],
  ["**`#123`**", "<strong><code>#123</code></strong>"],
  ["*Review* ~~draft~~", "<em>Review</em> <del>draft</del>"],
  ["`<example>`", "<code>&lt;example&gt;</code>"],
  ["\\*literal\\*", "*literal*"],
])("renders link label %s with application attributes", async (label, html) => {
  const markdown = `[${label}](https://opencode.ai)`
  const expected = `<p><a href="https://opencode.ai" class="external-link" target="_blank" rel="noopener noreferrer">${html}</a></p>\n`

  expect(await parser.parse(markdown)).toBe(expected)
})

test("renders inline and block math", async () => {
  expect(await parser.parse("\\(x^2\\)")).toContain('<span class="katex">')
  expect(await parser.parse("$$\nx^2\n$$\n")).toContain('<span class="katex-display">')
})

test("uses the configured code highlighter", async () => {
  expect(await parser.parse("```ts\nconst value = 1\n```\n")).toBe('<pre data-language="ts">const value = 1</pre>\n')
})
