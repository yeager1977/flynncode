import { describe, expect, test } from "bun:test"
import { ConfigWorktree } from "../../src/config/worktree"
import { ConfigParse } from "../../src/config/parse"
import { ConfigV1 } from "@flynncode/core/v1/config/config"

const parse = (input: unknown) => ConfigParse.schema(ConfigV1.Info, input, "test:config")

describe("ConfigWorktree.settings", () => {
  test("defaults apply when worktree is absent", () => {
    const config = parse({})
    expect(ConfigWorktree.settings(config)).toEqual({
      location: ".opencode/worktrees",
      branchPrefix: "opencode",
      keep: 15,
      allowPrimaryRebind: false,
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
      allowPrimaryRebind: false,
    })
  })

  test("partial worktree blocks keep their resolved fields", () => {
    expect(ConfigWorktree.settings(parse({ worktree: { keep: 2 } }))).toEqual({
      location: ".opencode/worktrees",
      branchPrefix: "opencode",
      keep: 2,
      allowPrimaryRebind: false,
    })
  })

  test("allow_primary_rebind opt-in passes through", () => {
    expect(ConfigWorktree.settings(parse({ worktree: { allow_primary_rebind: true } })).allowPrimaryRebind).toBe(true)
  })

  test("malformed allow_primary_rebind degrades to the default", () => {
    const config = { worktree: { allow_primary_rebind: "yes" } } as never
    expect(ConfigWorktree.settings(config).allowPrimaryRebind).toBe(false)
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
      allowPrimaryRebind: false,
    })
  })

  test("branch prefix trailing slashes are trimmed", () => {
    const config = { worktree: { branch_prefix: "review/" } }
    expect(ConfigWorktree.settings(config as never).branchPrefix).toBe("review")
  })
})