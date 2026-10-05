import { describe, expect, test } from "bun:test"
import { ConfigWorktree } from "../../src/config/worktree"
import { ConfigParse } from "../../src/config/parse"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"

const parse = (input: unknown) => ConfigParse.schema(ConfigV1.Info, input, "test:config")

describe("ConfigWorktree.settings", () => {
  test("defaults apply when worktree is absent", () => {
    const config = parse({})
    expect(ConfigWorktree.settings(config)).toEqual({
      location: ".opencode/worktrees",
      branchPrefix: "opencode",
      keep: 15,
    })
  })

  test("valid values pass through", () => {
    const config = parse({
      worktree: { location: ".wt", branch_prefix: "feat", keep: 3 },
    })
    expect(ConfigWorktree.settings(config)).toEqual({
      location: ".wt",
      branchPrefix: "feat",
      keep: 3,
    })
  })

  test("schema accepts keep and preserves the value", () => {
    const parsed = parse({ worktree: { keep: 4 } })
    expect(parsed.worktree?.keep).toBe(4)
  })

  test("schema rejects a non-numeric keep", () => {
    expect(() => parse({ worktree: { keep: "lots" } })).toThrow()
  })

  test("malformed values degrade to defaults instead of failing load", () => {
    const config = {
      worktree: { keep: -1, branch_prefix: "   ", location: "" },
    }
    expect(ConfigWorktree.settings(config as never)).toEqual({
      location: ".opencode/worktrees",
      branchPrefix: "opencode",
      keep: 15,
    })
  })

  test("branch prefix trailing slashes are trimmed", () => {
    const config = { worktree: { branch_prefix: "review/" } }
    expect(ConfigWorktree.settings(config as never).branchPrefix).toBe("review")
  })
})