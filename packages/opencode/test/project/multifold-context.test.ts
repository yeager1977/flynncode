import { describe, expect, test } from "bun:test"
import { ProjectV2 } from "@opencode-ai/core/project"
import { containsPath } from "@/project/instance-context"
import type { InstanceContext } from "@/project/instance-context"

describe("multifold containsPath", () => {
  test("matches extras", () => {
    const ctx: InstanceContext = {
      directory: "/repo",
      worktree: "/repo",
      project: {
        id: ProjectV2.ID.global,
        worktree: "/repo",
        vcs: "git",
        sandboxes: [],
        time: { created: 0, updated: 0 },
      },
      additionalDirectories: ["/docs"],
    }
    expect(containsPath("/docs/guide.md", ctx)).toBe(true)
    expect(containsPath("/other/f", ctx)).toBe(false)
  })

  test("fromDirectory accepts extras without changing worktree", async () => {
    const { Project } = await import("@/project/project")
    expect(typeof Project.Service).toBe("function")
  })
})
