# Ollama Model Router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An opencode plugin that scores Ollama models on price/capability/speed, ranks them per task type, auto-assigns winning models to agents, and exposes manual routing tools.

**Architecture:** A path-installed opencode plugin at `~/GitHub/opencode/ollama-model-router/`. Pure scoring logic lives in `src/rank.ts` (no opencode imports, unit-tested). Options parsing/validation in `src/scorecard.ts`. The plugin factory in `index.ts` wires a `config` hook (agent model assignment) and two custom tools (`rank_models`, `route_task`). `route_task` executes via a child session with `promptAsync`.

**Tech Stack:** TypeScript (Bun runtime), `@opencode-ai/plugin` 1.18.31, zod 4.1.8 (both resolved from the opencode monorepo's node_modules), `bun test` for tests.

**Spec:** `docs/superpowers/specs/2026-09-14-ollama-model-router-design.md`

## Global Constraints

- Plugin directory: `/home/yeager1977/GitHub/opencode/ollama-model-router/`
- Plugin must default-export `{ id: "ollama-model-router", server: (input, options) => Promise<Hooks> }`. Path plugins that lack `id` are rejected by the loader (`packages/opencode/src/plugin/shared.ts:304`).
- Plugin must never throw during loading or hooks. Wrap hook bodies in try/catch; log via `console.warn`/`console.error` with a `[ollama-model-router]` prefix.
- Model keys are `providerID/modelID` (e.g. `ollama-cloud/glm-5.3-flash:cloud`). Always quote them in JSON config; an unquoted `provider:model` becomes an npm specifier in the plugin array.
- Scores are integers 1–10. `price`: 10 = most expensive; `capability`/`speed`: 10 = best.
- Standard task names: `coding`, `planning`, `review`, `lookup`, `writing`, `long-context`.
- Standard `agentTasks` default: `build→coding`, `plan→planning`, `explore→lookup`, `general→coding`.
- Default `taskWeights` (see spec for the exact table) — copy verbatim from Task 3.
- No network calls in the `config` hook. No mutation of `cfg.model` / `cfg.small_model`.
- Tests run with `bun test` from the plugin directory.
- Commit after each task. Repo is `~/GitHub/opencode` (the fork checkout); commit only files under `ollama-model-router/`.

---

### Task 1: Plugin scaffold and package manifest

**Files:**
- Create: `ollama-model-router/package.json`
- Create: `ollama-model-router/tsconfig.json`
- Create: `ollama-model-router/index.ts`
- Create: `ollama-model-router/src/types.ts`
- Test: `ollama-model-router/tests/scaffold.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: package named `ollama-model-router` with `"exports": { ".": "./index.ts" }`; `src/types.ts` exporting `TaskName`, `ScoreEntry`, `RouterOptions`, `RankResult`, `ModelMeta` (shapes below).

- [ ] **Step 1: Write the failing test**

Create `ollama-model-router/tests/scaffold.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import plugin from "../index"

describe("scaffold", () => {
  test("exports the plugin shape the loader requires", () => {
    expect(plugin.id).toBe("ollama-model-router")
    expect(typeof plugin.server).toBe("function")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/yeager1977/GitHub/opencode/ollama-model-router && bun test`
Expected: FAIL — `Cannot find module '../index'` or similar.

- [ ] **Step 3: Write package.json**

Create `ollama-model-router/package.json`:

```json
{
  "name": "ollama-model-router",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./index.ts"
  },
  "engines": {
    "opencode": ">=1.18.0"
  },
  "scripts": {
    "test": "bun test"
  }
}
```

No dependencies: `@opencode-ai/plugin` and `zod` resolve through the parent
`~/GitHub/opencode/node_modules` (the monorepo root), which already links
`@opencode-ai/plugin` to `packages/plugin`. `zod@4.1.8` is a workspace
catalog dependency of `packages/plugin` and is importable transitively.

- [ ] **Step 4: Write tsconfig.json**

Create `ollama-model-router/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["index.ts", "src", "tests"]
}
```

`bun:test` types resolve through the Bun runtime and the monorepo's
node_modules; no explicit `types` array is needed. Tests execute with
`bun test`, which does not require `tsc`.

- [ ] **Step 5: Write src/types.ts**

Create `ollama-model-router/src/types.ts`:

```ts
export type TaskName =
  | "coding"
  | "planning"
  | "review"
  | "lookup"
  | "writing"
  | "long-context"

export type ScoreEntry = {
  price: number
  capability: number
  speed: number
  tags?: TaskName[]
}

export type ModelMeta = {
  providerID: string
  modelID: string
  name?: string
  context?: number
  toolCall?: boolean
  reasoning?: boolean
  providerDisabled?: boolean
}

export type RouterOptions = {
  autoRoute: boolean
  allowUnscored: boolean
  overrideExplicit: boolean
  providers: string[]
  agentTasks: Record<string, TaskName>
  taskWeights: Record<TaskName, { capability: number; price: number; speed: number }>
  models: Record<string, ScoreEntry>
}

export type RankedModel = {
  key: string
  providerID: string
  modelID: string
  score: number
  reasons: string[]
  excluded?: string
}

export type RankResult = {
  task: TaskName
  ranked: RankedModel[]
  excluded: RankedModel[]
}
```

- [ ] **Step 6: Write minimal index.ts**

Create `ollama-model-router/index.ts`:

```ts
import type { Hooks, PluginInput, PluginOptions } from "@opencode-ai/plugin"

export default {
  id: "ollama-model-router",
  server: async (_input: PluginInput, _options?: PluginOptions): Promise<Hooks> => {
    return {}
  },
}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `cd /home/yeager1977/GitHub/opencode/ollama-model-router && bun test`
Expected: PASS (1 test).

- [ ] **Step 8: Commit**

```bash
cd /home/yeager1977/GitHub/opencode
git add ollama-model-router/package.json ollama-model-router/tsconfig.json ollama-model-router/index.ts ollama-model-router/src/types.ts ollama-model-router/tests/scaffold.test.ts
git commit -m "feat(ollama-model-router): scaffold plugin package"
```

---

### Task 2: Scoring engine (pure functions)

**Files:**
- Create: `ollama-model-router/src/rank.ts`
- Test: `ollama-model-router/tests/rank.test.ts`

**Interfaces:**
- Consumes: `TaskName`, `ScoreEntry`, `RankedModel`, `RankResult` from `./types`.
- Produces:
  - `normalizeWeights(w: { capability: number; price: number; speed: number }): { capability: number; price: number; speed: number }`
  - `scoreModel(entry: ScoreEntry, weights: { capability: number; price: number; speed: number }, task: TaskName): { score: number; reasons: string[] } | { excluded: string }`
  - `rankModels(candidates: Array<{ key: string; providerID: string; modelID: string; entry?: ScoreEntry; providerDisabled?: boolean }>, task: TaskName, weights: { capability: number; price: number; speed: number }, opts: { allowUnscored: boolean }): RankResult`

- [ ] **Step 1: Write the failing tests**

Create `ollama-model-router/tests/rank.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { normalizeWeights, rankModels, scoreModel } from "../src/rank"

const weights = { capability: 0.6, price: 0.25, speed: 0.15 }

describe("normalizeWeights", () => {
  test("normalizes to sum 1", () => {
    const w = normalizeWeights({ capability: 2, price: 1, speed: 1 })
    expect(w.capability).toBeCloseTo(0.5)
    expect(w.price).toBeCloseTo(0.25)
    expect(w.speed).toBeCloseTo(0.25)
  })

  test("falls back to equal weights when all zero", () => {
    const w = normalizeWeights({ capability: 0, price: 0, speed: 0 })
    expect(w.capability).toBeCloseTo(1 / 3)
    expect(w.price).toBeCloseTo(1 / 3)
    expect(w.speed).toBeCloseTo(1 / 3)
  })
})

describe("scoreModel", () => {
  test("computes weighted score with inverted price", () => {
    const { score, reasons } = scoreModel(
      { price: 3, capability: 8, speed: 9 },
      weights,
      "coding",
    ) as { score: number; reasons: string[] }
    // 0.6*8 + 0.25*7 + 0.15*9 = 4.8 + 1.75 + 1.35 = 7.9
    expect(score).toBeCloseTo(7.9)
    expect(reasons.length).toBe(3)
  })

  test("excludes models not tagged for the task", () => {
    const result = scoreModel(
      { price: 3, capability: 8, speed: 9, tags: ["lookup"] },
      weights,
      "coding",
    )
    expect(result).toEqual({ excluded: "not tagged for coding" })
  })

  test("includes models tagged for the task", () => {
    const result = scoreModel(
      { price: 3, capability: 8, speed: 9, tags: ["coding", "lookup"] },
      weights,
      "coding",
    )
    expect("score" in result).toBe(true)
  })

  test("unscored models score 5/5/5 when allowed", () => {
    const result = scoreModel(
      { price: 5, capability: 5, speed: 5 },
      weights,
      "coding",
    )
    expect((result as { score: number }).score).toBeCloseTo(5)
  })
})

describe("rankModels", () => {
  test("sorts descending by score and applies tie-breaks", () => {
    const result = rankModels(
      [
        { key: "p/a", providerID: "p", modelID: "a", entry: { price: 3, capability: 8, speed: 9 } },
        { key: "p/b", providerID: "p", modelID: "b", entry: { price: 1, capability: 8, speed: 9 } },
        { key: "p/c", providerID: "p", modelID: "c", entry: { price: 1, capability: 7, speed: 9 } },
      ],
      "coding",
      weights,
      { allowUnscored: false },
    )
    // b and c tie on score? b = 0.6*8+0.25*9+0.15*9=8.4; c=0.6*7+0.25*9+0.15*9=7.8; a=0.6*8+0.25*7+0.15*9=7.9
    expect(result.ranked.map((r) => r.key)).toEqual(["p/b", "p/a", "p/c"])
  })

  test("tie-break: cheaper wins, then faster, then key", () => {
    const result = rankModels(
      [
        { key: "p/z", providerID: "p", modelID: "z", entry: { price: 2, capability: 5, speed: 5 } },
        { key: "p/a", providerID: "p", modelID: "a", entry: { price: 2, capability: 5, speed: 5 } },
      ],
      "coding",
      weights,
      { allowUnscored: false },
    )
    expect(result.ranked.map((r) => r.key)).toEqual(["p/a", "p/z"])
  })

  test("excludes disabled providers", () => {
    const result = rankModels(
      [{ key: "p/a", providerID: "p", modelID: "a", entry: { price: 3, capability: 8, speed: 9 }, providerDisabled: true }],
      "coding",
      weights,
      { allowUnscored: false },
    )
    expect(result.ranked).toEqual([])
    expect(result.excluded[0].excluded).toBe("provider disabled")
  })

  test("excludes unscored when allowUnscored is false", () => {
    const result = rankModels(
      [{ key: "p/a", providerID: "p", modelID: "a" }],
      "coding",
      weights,
      { allowUnscored: false },
    )
    expect(result.ranked).toEqual([])
    expect(result.excluded[0].excluded).toBe("unscored")
  })

  test("includes unscored at 5/5/5 when allowUnscored is true", () => {
    const result = rankModels(
      [{ key: "p/a", providerID: "p", modelID: "a" }],
      "coding",
      weights,
      { allowUnscored: true },
    )
    expect(result.ranked.length).toBe(1)
    expect(result.ranked[0].score).toBeCloseTo(5)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/yeager1977/GitHub/opencode/ollama-model-router && bun test tests/rank.test.ts`
Expected: FAIL — `Cannot find module '../src/rank'`.

- [ ] **Step 3: Implement src/rank.ts**

Create `ollama-model-router/src/rank.ts`:

```ts
import type { RankResult, RankedModel, ScoreEntry, TaskName } from "./types"

type Weights = { capability: number; price: number; speed: number }

export function normalizeWeights(w: Weights): Weights {
  const total = w.capability + w.price + w.speed
  if (total <= 0) return { capability: 1 / 3, price: 1 / 3, speed: 1 / 3 }
  return { capability: w.capability / total, price: w.price / total, speed: w.speed / total }
}

export function scoreModel(
  entry: ScoreEntry,
  weights: Weights,
  task: TaskName,
): { score: number; reasons: string[] } | { excluded: string } {
  if (entry.tags && entry.tags.length > 0 && !entry.tags.includes(task)) {
    return { excluded: `not tagged for ${task}` }
  }
  const w = normalizeWeights(weights)
  const priceScore = 10 - entry.price
  const score = w.capability * entry.capability + w.price * priceScore + w.speed * entry.speed
  const reasons = [
    `capability ${entry.capability}×${w.capability.toFixed(2)}`,
    `price ${entry.price}→${priceScore}×${w.price.toFixed(2)}`,
    `speed ${entry.speed}×${w.speed.toFixed(2)}`,
  ]
  if (entry.tags && entry.tags.length > 0) reasons.push(`tagged: ${entry.tags.join(", ")}`)
  return { score, reasons }
}

export type Candidate = {
  key: string
  providerID: string
  modelID: string
  entry?: ScoreEntry
  providerDisabled?: boolean
}

export function rankModels(
  candidates: Candidate[],
  task: TaskName,
  weights: Weights,
  opts: { allowUnscored: boolean },
): RankResult {
  const ranked: RankedModel[] = []
  const excluded: RankedModel[] = []

  for (const c of candidates) {
    const base: RankedModel = {
      key: c.key,
      providerID: c.providerID,
      modelID: c.modelID,
      score: 0,
      reasons: [],
    }
    if (c.providerDisabled) {
      excluded.push({ ...base, excluded: "provider disabled" })
      continue
    }
    if (!c.entry) {
      if (!opts.allowUnscored) {
        excluded.push({ ...base, excluded: "unscored" })
        continue
      }
      const { score, reasons } = scoreModel(
        { price: 5, capability: 5, speed: 5 },
        weights,
        task,
      ) as { score: number; reasons: string[] }
      ranked.push({ ...base, score, reasons: [...reasons, "unscored → neutral 5/5/5"] })
      continue
    }
    const result = scoreModel(c.entry, weights, task)
    if ("excluded" in result) {
      excluded.push({ ...base, excluded: result.excluded })
      continue
    }
    ranked.push({ ...base, score: result.score, reasons: result.reasons })
  }

  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    const priceA = candidates.find((c) => c.key === a.key)?.entry?.price ?? 10
    const priceB = candidates.find((c) => c.key === b.key)?.entry?.price ?? 10
    if (priceA !== priceB) return priceA - priceB
    const speedA = candidates.find((c) => c.key === a.key)?.entry?.speed ?? 0
    const speedB = candidates.find((c) => c.key === b.key)?.entry?.speed ?? 0
    if (speedA !== speedB) return speedB - speedA
    return a.key.localeCompare(b.key)
  })

  return { task, ranked, excluded }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/yeager1977/GitHub/opencode/ollama-model-router && bun test tests/rank.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
cd /home/yeager1977/GitHub/opencode
git add ollama-model-router/src/rank.ts ollama-model-router/tests/rank.test.ts
git commit -m "feat(ollama-model-router): add pure ranking engine"
```

---

### Task 3: Options parsing and validation

**Files:**
- Create: `ollama-model-router/src/scorecard.ts`
- Test: `ollama-model-router/tests/scorecard.test.ts`

**Interfaces:**
- Consumes: `RouterOptions`, `ScoreEntry`, `TaskName` from `./types`.
- Produces:
  - `TASK_NAMES: TaskName[]`
  - `DEFAULT_AGENT_TASKS: Record<string, TaskName>`
  - `DEFAULT_TASK_WEIGHTS: Record<TaskName, { capability: number; price: number; speed: number }>`
  - `parseOptions(raw: Record<string, unknown> | undefined): { ok: true; options: RouterOptions } | { ok: false; errors: string[] }`
  - `parseModelKey(key: string): { providerID: string; modelID: string } | undefined` (splits on first `/`)

- [ ] **Step 1: Write the failing tests**

Create `ollama-model-router/tests/scorecard.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { DEFAULT_AGENT_TASKS, parseModelKey, parseOptions } from "../src/scorecard"

describe("parseOptions", () => {
  test("applies defaults for empty options", () => {
    const result = parseOptions(undefined)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.options.autoRoute).toBe(true)
    expect(result.options.allowUnscored).toBe(false)
    expect(result.options.overrideExplicit).toBe(false)
    expect(result.options.providers).toEqual([])
    expect(result.options.agentTasks).toEqual(DEFAULT_AGENT_TASKS)
    expect(result.options.models).toEqual({})
  })

  test("accepts a valid scorecard", () => {
    const result = parseOptions({
      providers: ["ollama-cloud"],
      models: {
        "ollama-cloud/glm-5.3-flash:cloud": { price: 3, capability: 8, speed: 9, tags: ["coding"] },
      },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.options.models["ollama-cloud/glm-5.3-flash:cloud"].capability).toBe(8)
  })

  test("rejects out-of-range scores", () => {
    const result = parseOptions({
      models: { "p/a": { price: 0, capability: 11, speed: 5 } },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.length).toBe(2)
  })

  test("rejects unknown task in agentTasks", () => {
    const result = parseOptions({ agentTasks: { build: "nope" } })
    expect(result.ok).toBe(false)
  })

  test("rejects model keys without provider prefix", () => {
    const result = parseOptions({ models: { "glm-5.3": { price: 3, capability: 8, speed: 9 } } })
    expect(result.ok).toBe(false)
  })
})

describe("parseModelKey", () => {
  test("splits on first slash", () => {
    expect(parseModelKey("ollama-cloud/glm-5.3-flash:cloud")).toEqual({
      providerID: "ollama-cloud",
      modelID: "glm-5.3-flash:cloud",
    })
  })

  test("returns undefined without a slash", () => {
    expect(parseModelKey("glm-5.3")).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/yeager1977/GitHub/opencode/ollama-model-router && bun test tests/scorecard.test.ts`
Expected: FAIL — `Cannot find module '../src/scorecard'`.

- [ ] **Step 3: Implement src/scorecard.ts**

Create `ollama-model-router/src/scorecard.ts`:

```ts
import type { RouterOptions, ScoreEntry, TaskName } from "./types"

export const TASK_NAMES: TaskName[] = [
  "coding",
  "planning",
  "review",
  "lookup",
  "writing",
  "long-context",
]

export const DEFAULT_AGENT_TASKS: Record<string, TaskName> = {
  build: "coding",
  plan: "planning",
  explore: "lookup",
  general: "coding",
}

export const DEFAULT_TASK_WEIGHTS: Record<TaskName, { capability: number; price: number; speed: number }> = {
  coding: { capability: 0.6, price: 0.25, speed: 0.15 },
  planning: { capability: 0.7, price: 0.2, speed: 0.1 },
  review: { capability: 0.65, price: 0.25, speed: 0.1 },
  lookup: { capability: 0.3, price: 0.3, speed: 0.4 },
  writing: { capability: 0.5, price: 0.3, speed: 0.2 },
  "long-context": { capability: 0.6, price: 0.3, speed: 0.1 },
}

export function parseModelKey(key: string): { providerID: string; modelID: string } | undefined {
  const idx = key.indexOf("/")
  if (idx <= 0 || idx === key.length - 1) return undefined
  return { providerID: key.slice(0, idx), modelID: key.slice(idx + 1) }
}

function isTaskName(value: unknown): value is TaskName {
  return typeof value === "string" && (TASK_NAMES as string[]).includes(value)
}

export function parseOptions(
  raw: Record<string, unknown> | undefined,
): { ok: true; options: RouterOptions } | { ok: false; errors: string[] } {
  const errors: string[] = []
  const r = raw ?? {}

  const autoRoute = typeof r.autoRoute === "boolean" ? r.autoRoute : true
  const allowUnscored = typeof r.allowUnscored === "boolean" ? r.allowUnscored : false
  const overrideExplicit = typeof r.overrideExplicit === "boolean" ? r.overrideExplicit : false

  let providers: string[] = []
  if (r.providers !== undefined) {
    if (Array.isArray(r.providers) && r.providers.every((p) => typeof p === "string")) {
      providers = r.providers as string[]
    } else {
      errors.push("providers must be an array of strings")
    }
  }

  let agentTasks: Record<string, TaskName> = { ...DEFAULT_AGENT_TASKS }
  if (r.agentTasks !== undefined) {
    if (r.agentTasks === null || typeof r.agentTasks !== "object" || Array.isArray(r.agentTasks)) {
      errors.push("agentTasks must be an object mapping agent names to task names")
    } else {
      agentTasks = {}
      for (const [agent, task] of Object.entries(r.agentTasks as Record<string, unknown>)) {
        if (!isTaskName(task)) {
          errors.push(`agentTasks.${agent}: unknown task "${String(task)}" (valid: ${TASK_NAMES.join(", ")})`)
          continue
        }
        agentTasks[agent] = task
      }
    }
  }

  const taskWeights = structuredClone(DEFAULT_TASK_WEIGHTS)
  if (r.taskWeights !== undefined) {
    if (r.taskWeights === null || typeof r.taskWeights !== "object" || Array.isArray(r.taskWeights)) {
      errors.push("taskWeights must be an object keyed by task name")
    } else {
      for (const [task, w] of Object.entries(r.taskWeights as Record<string, unknown>)) {
        if (!isTaskName(task)) {
          errors.push(`taskWeights.${task}: unknown task (valid: ${TASK_NAMES.join(", ")})`)
          continue
        }
        if (w === null || typeof w !== "object" || Array.isArray(w)) {
          errors.push(`taskWeights.${task} must be an object with capability/price/speed`)
          continue
        }
        const obj = w as Record<string, unknown>
        for (const dim of ["capability", "price", "speed"] as const) {
          const v = obj[dim]
          if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
            errors.push(`taskWeights.${task}.${dim} must be a non-negative number`)
          }
        }
        taskWeights[task] = {
          capability: Number(obj.capability ?? DEFAULT_TASK_WEIGHTS[task].capability),
          price: Number(obj.price ?? DEFAULT_TASK_WEIGHTS[task].price),
          speed: Number(obj.speed ?? DEFAULT_TASK_WEIGHTS[task].speed),
        }
      }
    }
  }

  const models: Record<string, ScoreEntry> = {}
  if (r.models !== undefined) {
    if (r.models === null || typeof r.models !== "object" || Array.isArray(r.models)) {
      errors.push("models must be an object keyed by providerID/modelID")
    } else {
      for (const [key, entry] of Object.entries(r.models as Record<string, unknown>)) {
        if (!parseModelKey(key)) {
          errors.push(`models."${key}": key must be "providerID/modelID"`)
          continue
        }
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
          errors.push(`models."${key}": entry must be an object`)
          continue
        }
        const obj = entry as Record<string, unknown>
        const parsed: ScoreEntry = { price: 5, capability: 5, speed: 5 }
        for (const dim of ["price", "capability", "speed"] as const) {
          const v = obj[dim]
          if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 10) {
            errors.push(`models."${key}".${dim} must be an integer 1-10`)
          } else {
            parsed[dim] = v
          }
        }
        if (obj.tags !== undefined) {
          if (Array.isArray(obj.tags) && obj.tags.every(isTaskName)) {
            parsed.tags = obj.tags as TaskName[]
          } else {
            errors.push(`models."${key}".tags must be an array of task names`)
          }
        }
        models[key] = parsed
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, options: { autoRoute, allowUnscored, overrideExplicit, providers, agentTasks, taskWeights, models } }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/yeager1977/GitHub/opencode/ollama-model-router && bun test tests/scorecard.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
cd /home/yeager1977/GitHub/opencode
git add ollama-model-router/src/scorecard.ts ollama-model-router/tests/scorecard.test.ts
git commit -m "feat(ollama-model-router): add options parsing and validation"
```

---

### Task 4: Candidate resolution from live config

**Files:**
- Create: `ollama-model-router/src/candidates.ts`
- Test: `ollama-model-router/tests/candidates.test.ts`

**Interfaces:**
- Consumes: `RouterOptions`, `ModelMeta` from `./types`; `Candidate` from `./rank`.
- Produces:
  - `ModelMeta` collection: `collectMeta(cfg, options): Map<string, ModelMeta>` (keyed `providerID/modelID`)
  - `collectCandidates(cfg: { provider?: Record<string, any>; disabled_providers?: string[] }, options: RouterOptions): Candidate[]`
  - Keys are `providerID/modelID`. Only providers in `options.providers` (or all `ollama*` when the list is empty) are included. Each candidate gets `providerDisabled` and metadata-derived `entry` only if the user provided one (metadata is NOT converted into scores).

- [ ] **Step 1: Write the failing tests**

Create `ollama-model-router/tests/candidates.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { collectCandidates } from "../src/candidates"
import { parseOptions } from "../src/scorecard"

const cfg = {
  provider: {
    "ollama-cloud": {
      models: {
        "glm-5.3-flash:cloud": { name: "GLM 5.3 Flash", limit: { context: 1000000 }, tool_call: true },
        "gpt-oss:20b": { name: "GPT-OSS 20B" },
      },
    },
    "ollama-gpu": {
      models: { "qwen3.8:latest": { name: "Qwen 3.8 27B" } },
    },
    openai: {
      models: { "gpt-5": { name: "GPT-5" } },
    },
  },
  disabled_providers: ["ollama-local"],
}

function options(overrides: Record<string, unknown> = {}) {
  const result = parseOptions({
    providers: ["ollama-cloud", "ollama-gpu"],
    models: { "ollama-cloud/glm-5.3-flash:cloud": { price: 3, capability: 8, speed: 9 } },
    ...overrides,
  })
  if (!result.ok) throw new Error(result.errors.join(", "))
  return result.options
}

describe("collectCandidates", () => {
  test("collects models from configured providers only", () => {
    const list = collectCandidates(cfg, options())
    expect(list.map((c) => c.key).sort()).toEqual([
      "ollama-cloud/glm-5.3-flash:cloud",
      "ollama-cloud/gpt-oss:20b",
      "ollama-gpu/qwen3.8:latest",
    ])
  })

  test("attaches scorecard entries", () => {
    const list = collectCandidates(cfg, options())
    const hit = list.find((c) => c.key === "ollama-cloud/glm-5.3-flash:cloud")
    expect(hit?.entry?.capability).toBe(8)
  })

  test("marks disabled providers", () => {
    const list = collectCandidates(cfg, options({ providers: ["ollama-local"], models: {} }))
    // ollama-local has no models in cfg, so nothing to collect; use cloud instead
    expect(list.length).toBe(0)
  })

  test("defaults to providers whose id starts with ollama", () => {
    const list = collectCandidates(cfg, options({ providers: undefined }))
    expect(list.every((c) => c.providerID.startsWith("ollama"))).toBe(true)
    expect(list.find((c) => c.key === "openai/gpt-5")).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/yeager1977/GitHub/opencode/ollama-model-router && bun test tests/candidates.test.ts`
Expected: FAIL — `Cannot find module '../src/candidates'`.

- [ ] **Step 3: Implement src/candidates.ts**

Create `ollama-model-router/src/candidates.ts`:

```ts
import type { ModelMeta, RouterOptions } from "./types"
import type { Candidate } from "./rank"

type ProviderLike = {
  models?: Record<string, unknown>
}

type ConfigLike = {
  provider?: Record<string, ProviderLike | undefined>
  disabled_providers?: string[]
}

type ModelEntryLike = {
  name?: unknown
  tool_call?: unknown
  reasoning?: unknown
  limit?: { context?: unknown }
}

export function collectMeta(cfg: ConfigLike, options: RouterOptions): Map<string, ModelMeta> {
  const disabled = new Set(cfg.disabled_providers ?? [])
  const selected = (providerID: string) => {
    if (options.providers.length > 0) return options.providers.includes(providerID)
    return providerID.startsWith("ollama")
  }

  const meta = new Map<string, ModelMeta>()
  for (const [providerID, provider] of Object.entries(cfg.provider ?? {})) {
    if (!provider || !provider.models) continue
    if (!selected(providerID)) continue
    for (const [modelID, raw] of Object.entries(provider.models)) {
      const entry = (raw ?? {}) as ModelEntryLike
      const key = `${providerID}/${modelID}`
      meta.set(key, {
        providerID,
        modelID,
        name: typeof entry.name === "string" ? entry.name : undefined,
        context: typeof entry.limit?.context === "number" ? entry.limit.context : undefined,
        toolCall: entry.tool_call === true,
        reasoning: entry.reasoning === true,
        providerDisabled: disabled.has(providerID),
      })
    }
  }
  return meta
}

export function collectCandidates(cfg: ConfigLike, options: RouterOptions): Candidate[] {
  const disabled = new Set(cfg.disabled_providers ?? [])
  const selected = (providerID: string) => {
    if (options.providers.length > 0) return options.providers.includes(providerID)
    return providerID.startsWith("ollama")
  }

  const out: Candidate[] = []
  for (const [providerID, provider] of Object.entries(cfg.provider ?? {})) {
    if (!provider || !provider.models) continue
    if (!selected(providerID)) continue
    for (const modelID of Object.keys(provider.models)) {
      const key = `${providerID}/${modelID}`
      out.push({
        key,
        providerID,
        modelID,
        entry: options.models[key],
        providerDisabled: disabled.has(providerID),
      })
    }
  }
  return out
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/yeager1977/GitHub/opencode/ollama-model-router && bun test tests/candidates.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
cd /home/yeager1977/GitHub/opencode
git add ollama-model-router/src/candidates.ts ollama-model-router/tests/candidates.test.ts
git commit -m "feat(ollama-model-router): collect candidates from live config"
```

---

### Task 5: Agent assignment (config hook)

**Files:**
- Create: `ollama-model-router/src/assign.ts`
- Test: `ollama-model-router/tests/assign.test.ts`

**Interfaces:**
- Consumes: `RouterOptions` from `./types`; `collectCandidates` from `./candidates`; `rankModels` from `./rank`; `DEFAULT_TASK_WEIGHTS` from `./scorecard`.
- Produces:
  - `assignAgents(cfg: any, options: RouterOptions): { assignments: Record<string, string>; warnings: string[] }`
  - Mutates `cfg.agent` in place, adding `{ model: "providerID/modelID" }` entries. Does not overwrite an agent model that already exists unless `options.overrideExplicit` is true. Skips disabled agents (`cfg.agent[name].disable === true`). Never touches `cfg.model` / `cfg.small_model`.

- [ ] **Step 1: Write the failing tests**

Create `ollama-model-router/tests/assign.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { assignAgents } from "../src/assign"
import { parseOptions } from "../src/scorecard"

function makeOptions(overrides: Record<string, unknown> = {}) {
  const result = parseOptions({
    providers: ["ollama-cloud"],
    models: {
      "ollama-cloud/big": { price: 8, capability: 10, speed: 3 },
      "ollama-cloud/cheap": { price: 1, capability: 6, speed: 9 },
    },
    ...overrides,
  })
  if (!result.ok) throw new Error(result.errors.join(", "))
  return result.options
}

const cfgBase = () => ({
  provider: {
    "ollama-cloud": {
      models: { big: { name: "Big" }, cheap: { name: "Cheap" } },
    },
  },
  agent: {},
})

describe("assignAgents", () => {
  test("assigns cheapest-per-task model by default weights", () => {
    const cfg = cfgBase()
    const { assignments } = assignAgents(cfg, makeOptions())
    expect(assignments.build).toBe("ollama-cloud/cheap")
    expect(assignments.explore).toBe("ollama-cloud/cheap")
    expect(assignments.plan).toBe("ollama-cloud/big")
    expect(cfg.agent.build.model).toBe("ollama-cloud/cheap")
  })

  test("respects existing explicit agent models", () => {
    const cfg = cfgBase()
    cfg.agent = { build: { model: "ollama-cloud/big" } as any }
    const { assignments } = assignAgents(cfg, makeOptions())
    expect(assignments.build).toBeUndefined()
    expect(cfg.agent.build.model).toBe("ollama-cloud/big")
  })

  test("overrides explicit models when overrideExplicit is true", () => {
    const cfg = cfgBase()
    cfg.agent = { build: { model: "ollama-cloud/big" } as any }
    const { assignments } = assignAgents(cfg, makeOptions({ overrideExplicit: true }))
    expect(assignments.build).toBe("ollama-cloud/cheap")
  })

  test("skips disabled agents", () => {
    const cfg = cfgBase()
    cfg.agent = { build: { disable: true } as any }
    const { assignments } = assignAgents(cfg, makeOptions())
    expect(assignments.build).toBeUndefined()
    expect((cfg.agent.build as any).model).toBeUndefined()
  })

  test("reports agents it cannot route without throwing", () => {
    const cfg = { provider: { "ollama-cloud": { models: {} } }, agent: {} }
    const { assignments, warnings } = assignAgents(cfg, makeOptions())
    expect(assignments).toEqual({})
    expect(warnings.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/yeager1977/GitHub/opencode/ollama-model-router && bun test tests/assign.test.ts`
Expected: FAIL — `Cannot find module '../src/assign'`.

- [ ] **Step 3: Implement src/assign.ts**

Create `ollama-model-router/src/assign.ts`:

```ts
import { collectCandidates } from "./candidates"
import { rankModels } from "./rank"
import type { RouterOptions } from "./types"

export function assignAgents(
  cfg: any,
  options: RouterOptions,
): { assignments: Record<string, string>; warnings: string[] } {
  const warnings: string[] = []
  const assignments: Record<string, string> = {}

  if (!options.autoRoute) return { assignments, warnings }

  const candidates = collectCandidates(cfg, options)
  if (candidates.length === 0) {
    warnings.push("no candidate models found for configured providers")
    return { assignments, warnings }
  }

  const winners = new Map<string, { key: string; score: number }>()
  for (const task of new Set(Object.values(options.agentTasks))) {
    const result = rankModels(candidates, task, options.taskWeights[task], {
      allowUnscored: options.allowUnscored,
    })
    if (result.ranked.length === 0) {
      warnings.push(`no eligible model for task "${task}"`)
      continue
    }
    winners.set(task, { key: result.ranked[0].key, score: result.ranked[0].score })
  }

  if (!cfg.agent) cfg.agent = {}

  for (const [agent, task] of Object.entries(options.agentTasks)) {
    const winner = winners.get(task)
    if (!winner) continue
    const existing = cfg.agent[agent]
    if (existing?.disable) continue
    if (existing?.model && !options.overrideExplicit) {
      warnings.push(`agent "${agent}" has an explicit model; leaving it unchanged`)
      continue
    }
    if (!cfg.agent[agent]) cfg.agent[agent] = {}
    cfg.agent[agent].model = winner.key
    assignments[agent] = winner.key
  }

  return { assignments, warnings }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/yeager1977/GitHub/opencode/ollama-model-router && bun test tests/assign.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
cd /home/yeager1977/GitHub/opencode
git add ollama-model-router/src/assign.ts ollama-model-router/tests/assign.test.ts
git commit -m "feat(ollama-model-router): assign agents to ranked models"
```

---

### Task 6: Tools — rank_models and route_task

**Files:**
- Create: `ollama-model-router/src/tools.ts`
- Test: `ollama-model-router/tests/tools.test.ts`

**Interfaces:**
- Consumes: `tool` from `@opencode-ai/plugin`; `RouterOptions`, `RankResult`, `ModelMeta` from `./types`; `collectCandidates`, `collectMeta`; `rankModels`; `TASK_NAMES`.
- Produces:
  - `formatRankTable(result: RankResult, limit?: number, meta?: Map<string, ModelMeta>): string` — when `meta` is passed, excluded models show provider metadata (context, tool/reasoning flags) per the spec's "unscored models are listed with metadata" requirement.
  - `createTools(deps: { client: PluginInput["client"]; directory: string; getOptions: () => RouterOptions | undefined; getConfig: () => any; getAssignments: () => Record<string, string> }): Hooks["tool"]`
  - Tool names: `rank_models`, `route_task`.
  - `route_task` accepts `{ task, prompt, execute?, wait? }`. A module-scoped `Set<string>` inside `createTools` enforces the spec's one-concurrent-execution-per-session cap: a second `execute: true` call for a session with one in flight returns an explanatory error. The entry is added before creating the child session and removed in a `finally` block (or when the background session's prompt is accepted for `promptAsync`; the cap is on dispatch, not on agent runtime).

- [ ] **Step 1: Write the failing tests**

Create `ollama-model-router/tests/tools.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { formatRankTable } from "../src/tools"

describe("formatRankTable", () => {
  test("renders ranked rows with scores and reasons", () => {
    const text = formatRankTable({
      task: "coding",
      ranked: [
        { key: "p/a", providerID: "p", modelID: "a", score: 7.9, reasons: ["capability 8×0.60"] },
      ],
      excluded: [{ key: "p/b", providerID: "p", modelID: "b", score: 0, reasons: [], excluded: "unscored" }],
    })
    expect(text).toContain("coding")
    expect(text).toContain("p/a")
    expect(text).toContain("7.90")
    expect(text).toContain("p/b")
    expect(text).toContain("unscored")
  })

  test("says so when there are no candidates", () => {
    const text = formatRankTable({ task: "coding", ranked: [], excluded: [] })
    expect(text).toContain("No eligible models")
  })

  test("shows provider metadata for excluded unscored models", () => {
    const meta = new Map([
      [
        "p/b",
        {
          providerID: "p",
          modelID: "b",
          name: "Bee Model",
          context: 262144,
          toolCall: true,
          reasoning: true,
        },
      ],
    ])
    const text = formatRankTable(
      {
        task: "coding",
        ranked: [],
        excluded: [{ key: "p/b", providerID: "p", modelID: "b", score: 0, reasons: [], excluded: "unscored" }],
      },
      10,
      meta,
    )
    expect(text).toContain("Bee Model")
    expect(text).toContain("ctx 262k")
    expect(text).toContain("tools")
    expect(text).toContain("reasoning")
  })
})
```

**Concurrency cap** is covered by a test that stubs `deps.client` with a
session-create that never resolves, issues two `execute: true` calls for the
same session, and asserts the second returns the "already in flight" message.
Add to `tests/tools.test.ts`:

```ts
import { createTools } from "../src/tools"

test("route_task caps concurrent executions per session", async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => (release = resolve))
  const calls: string[] = []
  const client = {
    session: {
      create: async () => {
        calls.push("create")
        await gate
        return { data: { id: "child-1" } }
      },
      promptAsync: async () => ({}),
      prompt: async () => ({ data: { parts: [] } }),
    },
  } as any
  const options = {
    autoRoute: false,
    allowUnscored: false,
    overrideExplicit: false,
    providers: ["p"],
    agentTasks: {},
    taskWeights: { coding: { capability: 1, price: 1, speed: 1 } },
    models: { "p/a": { price: 1, capability: 5, speed: 5 } },
  } as any
  const tools = createTools({
    client,
    directory: "/tmp",
    getOptions: () => options,
    getConfig: () => ({ provider: { p: { models: { a: {} } } } }),
    getAssignments: () => ({}),
  })
  const ctx = { sessionID: "s1" } as any
  const first = tools!.route_task.execute({ task: "coding", prompt: "x", execute: true }, ctx)
  const second = await tools!.route_task.execute({ task: "coding", prompt: "y", execute: true }, ctx)
  expect(second).toContain("already in flight")
  release()
  await first
  expect(calls).toEqual(["create"])
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/yeager1977/GitHub/opencode/ollama-model-router && bun test tests/tools.test.ts`
Expected: FAIL — `Cannot find module '../src/tools'`.

- [ ] **Step 3: Implement src/tools.ts**

Create `ollama-model-router/src/tools.ts`:

```ts
import { tool } from "@opencode-ai/plugin"
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { collectCandidates, collectMeta } from "./candidates"
import { rankModels } from "./rank"
import { TASK_NAMES } from "./scorecard"
import type { ModelMeta, RankResult, RouterOptions } from "./types"

function metaLine(meta: Map<string, ModelMeta> | undefined, key: string): string {
  const m = meta?.get(key)
  if (!m) return ""
  const fields: string[] = []
  if (m.name) fields.push(m.name)
  if (m.context) fields.push(`ctx ${Math.round(m.context / 1000)}k`)
  if (m.toolCall) fields.push("tools")
  if (m.reasoning) fields.push("reasoning")
  if (m.providerDisabled) fields.push("provider disabled")
  return fields.length > 0 ? ` (${fields.join(", ")})` : ""
}

export function formatRankTable(result: RankResult, limit = 10, meta?: Map<string, ModelMeta>): string {
  const lines: string[] = [`Task: ${result.task}`]
  if (result.ranked.length === 0) {
    lines.push("No eligible models.")
  } else {
    lines.push("", "Rank | Model | Score | Reasons", "---- | ----- | ----- | -------")
    result.ranked.slice(0, limit).forEach((r, i) => {
      lines.push(`${i + 1} | ${r.key}${metaLine(meta, r.key)} | ${r.score.toFixed(2)} | ${r.reasons.join("; ")}`)
    })
  }
  if (result.excluded.length > 0) {
    lines.push("", "Excluded:")
    for (const e of result.excluded) lines.push(`- ${e.key}${metaLine(meta, e.key)}: ${e.excluded}`)
  }
  return lines.join("\n")
}

type Deps = {
  client: PluginInput["client"]
  directory: string
  getOptions: () => RouterOptions | undefined
  getConfig: () => any
  getAssignments: () => Record<string, string>
}

export function createTools(deps: Deps): Hooks["tool"] {
  const inFlight = new Set<string>()
  return {
    rank_models: tool({
      description:
        "Show ranked Ollama models per task type. Use to inspect which model routing considers best/cheapest/fastest.",
      args: {
        task: tool.schema.string().optional().describe(`One of: ${TASK_NAMES.join(", ")}`),
      },
      async execute(args) {
        const options = deps.getOptions()
        if (!options) return "Model router is disabled: options failed to parse. Check opencode logs."
        const cfg = deps.getConfig()
        const candidates = collectCandidates(cfg, options)
        const meta = collectMeta(cfg, options)
        const tasks = args.task ? [args.task] : TASK_NAMES
        const blocks: string[] = []
        for (const task of tasks) {
          if (!(TASK_NAMES as string[]).includes(task)) {
            return `Unknown task "${task}". Valid tasks: ${TASK_NAMES.join(", ")}`
          }
          const result = rankModels(candidates, task as any, options.taskWeights[task as any], {
            allowUnscored: options.allowUnscored,
          })
          blocks.push(formatRankTable(result, 10, meta))
        }
        const assignments = deps.getAssignments()
        if (Object.keys(assignments).length > 0) {
          blocks.push("", "Agent assignments: " + Object.entries(assignments).map(([a, m]) => `${a}→${m}`).join(", "))
        }
        return blocks.join("\n\n")
      },
    }),

    route_task: tool({
      description:
        "Pick the best model for a task and optionally run the prompt on it. Use execute:true to launch a background child session.",
      args: {
        task: tool.schema.string().describe(`One of: ${TASK_NAMES.join(", ")}`),
        prompt: tool.schema.string().describe("The prompt to run"),
        execute: tool.schema.boolean().optional().describe("Run the prompt in a child session (default false)"),
        wait: tool.schema.boolean().optional().describe("Wait for the response instead of returning immediately"),
      },
      async execute(args, ctx) {
        const options = deps.getOptions()
        if (!options) return "Model router is disabled: options failed to parse. Check opencode logs."
        if (!(TASK_NAMES as string[]).includes(args.task)) {
          return `Unknown task "${args.task}". Valid tasks: ${TASK_NAMES.join(", ")}`
        }
        const cfg = deps.getConfig()
        const candidates = collectCandidates(cfg, options)
        const meta = collectMeta(cfg, options)
        const result = rankModels(candidates, args.task as any, options.taskWeights[args.task as any], {
          allowUnscored: options.allowUnscored,
        })
        if (result.ranked.length === 0) {
          return `No eligible models for "${args.task}".\n\n` + formatRankTable(result, 10, meta)
        }
        const pick = result.ranked[0]
        const runnerUp = result.ranked[1]
        const summary = [
          `Selected: ${pick.key} (score ${pick.score.toFixed(2)})`,
          `Why: ${pick.reasons.join("; ")}`,
          runnerUp ? `Runner-up: ${runnerUp.key} (${runnerUp.score.toFixed(2)})` : "",
        ]
          .filter(Boolean)
          .join("\n")

        if (!args.execute) return summary

        if (inFlight.has(ctx.sessionID)) {
          return `${summary}\n\nA route_task execution is already in flight for this session. Wait for it to finish before starting another.`
        }
        inFlight.add(ctx.sessionID)
        try {
          const created = await deps.client.session.create({
            body: { parentID: ctx.sessionID, title: `route_task: ${args.task}` },
            query: { directory: deps.directory },
          })
          const session = created.data
          if (!session?.id) return `${summary}\n\nFailed to create child session.`

          const body = {
            model: { providerID: pick.providerID, modelID: pick.modelID },
            agent: "general",
            parts: [{ type: "text" as const, text: args.prompt }],
          }
          if (args.wait) {
            const response = await deps.client.session.prompt({
              path: { id: session.id },
              query: { directory: deps.directory },
              body,
            })
            const parts = response.data?.parts ?? []
            const text = parts
              .filter((p: any) => p.type === "text")
              .map((p: any) => p.text)
              .join("\n")
            return `${summary}\n\nChild session: ${session.id}\n\n${text || "(no text response)"}`
          }

          await deps.client.session.promptAsync({
            path: { id: session.id },
            query: { directory: deps.directory },
            body,
          })
          return `${summary}\n\nRunning in background child session: ${session.id}`
        } finally {
          inFlight.delete(ctx.sessionID)
        }
      },
    }),
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/yeager1977/GitHub/opencode/ollama-model-router && bun test tests/tools.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
cd /home/yeager1977/GitHub/opencode
git add ollama-model-router/src/tools.ts ollama-model-router/tests/tools.test.ts
git commit -m "feat(ollama-model-router): add rank_models and route_task tools"
```

---

### Task 7: Wire the plugin factory

**Files:**
- Modify: `ollama-model-router/index.ts`
- Test: `ollama-model-router/tests/plugin.test.ts`

**Interfaces:**
- Consumes: everything produced so far.
- Produces: default export `{ id, server }` where `server` registers the `config` hook and the two tools. Module-level state: `currentOptions`, `currentConfig`, `assignments`.

- [ ] **Step 1: Write the failing test**

Create `ollama-model-router/tests/plugin.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import plugin from "../index"

const fakeInput = {
  client: {} as any,
  project: {} as any,
  directory: "/tmp",
  worktree: "/tmp",
  experimental_workspace: { register() {} },
  serverUrl: new URL("http://localhost:4096"),
  $: undefined as any,
}

describe("plugin", () => {
  test("registers config hook and both tools", async () => {
    const hooks = await plugin.server(fakeInput, {
      autoRoute: false,
      providers: ["ollama-cloud"],
      models: { "ollama-cloud/a": { price: 1, capability: 5, speed: 5 } },
    })
    expect(typeof hooks.config).toBe("function")
    expect(hooks.tool?.rank_models).toBeDefined()
    expect(hooks.tool?.route_task).toBeDefined()
  })

  test("config hook assigns agent models when autoRoute is true", async () => {
    const hooks = await plugin.server(fakeInput, {
      autoRoute: true,
      providers: ["ollama-cloud"],
      models: {
        "ollama-cloud/a": { price: 1, capability: 5, speed: 5 },
        "ollama-cloud/b": { price: 9, capability: 10, speed: 5 },
      },
    })
    const cfg: any = {
      provider: { "ollama-cloud": { models: { a: {}, b: {} } } },
      agent: {},
      model: "should/not-change",
    }
    await hooks.config?.(cfg)
    expect(cfg.agent.build.model).toBe("ollama-cloud/b")
    expect(cfg.agent.plan.model).toBe("ollama-cloud/b")
    expect(cfg.model).toBe("should/not-change")
  })

  test("invalid options disable routing but keep tools", async () => {
    const hooks = await plugin.server(fakeInput, {
      models: { bad: { price: 99, capability: 1, speed: 1 } },
    })
    const cfg: any = { provider: {}, agent: {} }
    await hooks.config?.(cfg)
    expect(cfg.agent).toEqual({})
    expect(hooks.tool?.rank_models).toBeDefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/yeager1977/GitHub/opencode/ollama-model-router && bun test tests/plugin.test.ts`
Expected: FAIL — hooks.config is undefined.

- [ ] **Step 3: Implement index.ts**

Replace `ollama-model-router/index.ts`:

```ts
import type { Hooks, PluginInput, PluginOptions } from "@opencode-ai/plugin"
import { assignAgents } from "./src/assign"
import { TASK_NAMES, parseOptions } from "./src/scorecard"
import { createTools } from "./src/tools"
import type { RouterOptions } from "./src/types"

const PREFIX = "[ollama-model-router]"

export default {
  id: "ollama-model-router",
  server: async (input: PluginInput, options?: PluginOptions): Promise<Hooks> => {
    const parsed = parseOptions(options)
    let currentOptions: RouterOptions | undefined
    let currentConfig: any
    let assignments: Record<string, string> = {}

    if (parsed.ok) {
      currentOptions = parsed.options
      // An empty providers list means "every provider whose id starts with
      // ollama" — resolved in collectCandidates/collectMeta against the live
      // config. Do not hardcode provider ids here.
    } else {
      console.warn(`${PREFIX} invalid options; routing disabled:\n- ${parsed.errors.join("\n- ")}`)
    }

    const getOptions = () => currentOptions
    const getConfig = () => currentConfig
    const getAssignments = () => assignments

    return {
      config: async (cfg) => {
        try {
          currentConfig = cfg
          if (!currentOptions) return
          const result = assignAgents(cfg, currentOptions)
          assignments = result.assignments
          for (const warning of result.warnings) console.warn(`${PREFIX} ${warning}`)
          if (Object.keys(result.assignments).length > 0) {
            console.info(
              `${PREFIX} agent routing: ` +
                Object.entries(result.assignments)
                  .map(([agent, model]) => `${agent}→${model}`)
                  .join(", "),
            )
          }
        } catch (error) {
          console.error(`${PREFIX} config hook failed; routing disabled`, error)
          currentOptions = undefined
        }
      },
      tool: createTools({ client: input.client, directory: input.directory, getOptions, getConfig, getAssignments }),
    }
  },
}
```

Do not add extra keys to the default export. The loader reads `id` and
`server` only (`readV1Plugin`), and TypeScript's excess-property checks reject
anything outside `Hooks` on the returned object.

- [ ] **Step 4: Run all tests to verify they pass**

Run: `cd /home/yeager1977/GitHub/opencode/ollama-model-router && bun test`
Expected: PASS (all suites: 1+10+7+4+5+4+3 = 34 tests).

- [ ] **Step 5: Commit**

```bash
cd /home/yeager1977/GitHub/opencode
git add ollama-model-router/index.ts ollama-model-router/tests/plugin.test.ts
git commit -m "feat(ollama-model-router): wire plugin factory with config hook and tools"
```

---

### Task 8: Install and verify in a live opencode session

**Files:**
- Modify: `~/.config/opencode/opencode.jsonc` (plugin array)
- Create: `~/.config/opencode/command/route.md`
- Create: `ollama-model-router/docs/INSTALL.md`

**Interfaces:**
- Consumes: the working plugin from Task 7.
- Produces: a running, configured plugin; install documentation.

- [ ] **Step 1: Add the plugin entry to the global config**

Edit `~/.config/opencode/opencode.jsonc`. Add to the existing `plugin` array
(keep existing entries; mind commas):

```jsonc
"plugin": [
  "opencode-chrome-annotation@latest",
  "opencode-browser@latest",
  "superpowers@git+https://github.com/obra/superpowers.git",
  "opencode-openremote@latest",
  "opencode-wakatime",
  "opencode-sessions",
  [
    "/home/yeager1977/GitHub/opencode/ollama-model-router",
    {
      "autoRoute": true,
      "allowUnscored": false,
      "providers": ["ollama-cloud", "ollama-gpu", "ollama-local"],
      "agentTasks": {
        "build": "coding",
        "plan": "planning",
        "explore": "lookup",
        "general": "coding"
      },
      "models": {
        "ollama-cloud/glm-5.3-flash:cloud": { "price": 3, "capability": 8, "speed": 9, "tags": ["coding", "lookup", "long-context"] },
        "ollama-cloud/glm-5.3:cloud": { "price": 6, "capability": 10, "speed": 4, "tags": ["planning", "review", "long-context"] },
        "ollama-cloud/deepseek-v4.1-flash:cloud": { "price": 2, "capability": 7, "speed": 8, "tags": ["coding", "writing", "lookup"] }
      }
    }
  ]
]
```

The scorecard is intentionally minimal here; the user extends it.

- [ ] **Step 2: Create the /route command**

Create `~/.config/opencode/command/route.md`:

```markdown
---
description: Route a task to the best-ranked Ollama model
---
Use the route_task tool with task "$1" and the rest of the arguments as the prompt.
Pass execute: true. Do not do the work yourself; report which model was selected and the child session ID.
```

- [ ] **Step 3: Validate startuptakes the plugin without errors**

Quit and restart opencode. Then check the log for the routing banner:

Run: `grep "ollama-model-router" ~/.local/share/opencode/log/*.log | tail -20`
Expected: an `agent routing:` line listing `build→...`, `plan→...` and no
`invalid options` or `config hook failed` lines.

- [ ] **Step 4: Verify tools and routing in-session**

In a new opencode session:
1. Ask the agent to run `rank_models` with no arguments. Verify a winner table
   per task.
2. Run `/route lookup What is the AC of chain mail?`. Verify it reports a
   selected model and a background child session ID, and that the child
   session exists.
3. Verify `build` and `plan` agents show the routed models (agent selector or
   logs).

- [ ] **Step 5: Write docs/INSTALL.md**

Create `ollama-model-router/docs/INSTALL.md`:

```markdown
# Install

1. Reference the plugin directory from the global config (`~/.config/opencode/opencode.jsonc`):
   see the `plugin` array entry in the spec for the full options shape.
2. Restart opencode.
3. Verify with the `rank_models` tool or the logs (`agent routing:` line).
4. Optional: copy `~/.config/opencode/command/route.md` for the `/route` command.
5. Extend the `models` scorecard: every entry is `providerID/modelID` with
   `price`, `capability`, `speed` (1-10) and optional `tags`.
```

- [ ] **Step 6: Commit**

```bash
cd /home/yeager1977/GitHub/opencode
git add ollama-model-router/docs/INSTALL.md
git commit -m "docs(ollama-model-router): installation and verification guide"
```

The `~/.config/opencode` changes are outside the repo and are not committed.

---

## Plan Self-Review

**Spec coverage:**
- Scorecard options → Task 3. ✓
- Scoring formula, tie-breaks, tags, unscored → Task 2. ✓
- Candidate filtering incl. disabled providers → Task 4. ✓
- `config` hook agent assignment, overrideExplicit, never touch cfg.model → Task 5 + Task 7. ✓
- `rank_models` → Task 6. ✓
- `route_task` incl. child session + promptAsync + wait → Task 6. ✓
- `/route` command → Task 8. ✓
- Error handling (never throw, invalid options warn) → Tasks 3, 7; test in Task 7 Step 1. ✓
- Testing (unit + manual) → all tasks; manual in Task 8. ✓
- Ollama spend display → **not covered**. It was specified as optional/display-only. Deferred to future work; not required for v1 acceptance. (Flagged deliberately.)
- `chat.message` informational hook → removed from spec in review; not in plan. ✓

**Placeholder scan:** No TBD/TODO. Every code step has complete code. ✓

**Type consistency:** `Candidate` defined in `src/rank.ts` and imported by
`src/candidates.ts`; `RouterOptions` keys match `parseOptions` output;
`createTools` deps match `index.ts` call site; `RankResult` used by
`formatRankTable` matches `rankModels` return. ✓

**Determinism notes:** Task 5's tests assert the exact rankings produced by
the default weights: for the `big`/`cheap` fixtures, `cheap` wins `coding`
and `lookup`, `big` wins `planning`. Task 7's plugin test asserts `build`
(coding) resolves to `ollama-cloud/b`; that is correct for its fixture scores
(6.0 vs 7.0). No stray keys are added to the plugin's return value.
