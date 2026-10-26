export * as ClaudeAlias from "./claude-alias"

import { sortBy } from "remeda"
import type { Provider } from "./provider"

// Providers that serve Anthropic's Claude models, in preference order for
// models released on the same day.
const PROVIDERS = ["anthropic", "anthropic-api", "opencode", "vercel"]

type Candidate = Pick<Provider.Model, "id" | "providerID" | "family" | "release_date">

// Resolves a Claude Code model alias (`opus`, `sonnet`, `haiku`) to the newest
// connected Anthropic model of that family. `inherit`, unknown aliases and
// families with no connected model resolve to undefined: the session model.
export function resolve(alias: string, providers: Record<string, { models: Record<string, Candidate> }>) {
  if (!["opus", "sonnet", "haiku"].includes(alias)) return undefined
  const family = `claude-${alias}`
  const candidates = PROVIDERS.flatMap((providerID) => Object.values(providers[providerID]?.models ?? {})).filter(
    (model) => (model.family ? model.family === family : model.id.split("/").at(-1)?.startsWith(family)),
  )
  const winner = sortBy(
    candidates,
    [(model) => model.release_date, "desc"],
    [(model) => PROVIDERS.indexOf(model.providerID), "asc"],
    [(model) => model.id, "desc"],
  ).at(0)
  if (!winner) return undefined
  return { providerID: winner.providerID, modelID: winner.id }
}
