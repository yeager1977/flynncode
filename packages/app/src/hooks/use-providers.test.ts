import { expect, test } from "bun:test"
import { popularProviders } from "./use-providers"

test("includes Ollama Cloud with the direct model providers", () => {
  const google = popularProviders.indexOf("google")
  const ollama = popularProviders.indexOf("ollama-cloud")
  const openrouter = popularProviders.indexOf("openrouter")

  expect(google).toBeGreaterThan(-1)
  expect(ollama).toBeGreaterThan(-1)
  expect(openrouter).toBeGreaterThan(-1)
  expect(ollama).toBe(google + 1)
  expect(openrouter).toBe(ollama + 1)
})
