import { Schema } from "effect"
import path from "path"
import { ConfigPermissionV1 } from "@opencode-ai/core/v1/config/permission"

export class SandboxViolationError extends Schema.TaggedErrorClass<SandboxViolationError>()(
  "SandboxViolationError",
  {
    path: Schema.String,
    level: ConfigPermissionV1.SandboxMode,
  },
) {
  override get message() {
    return `The ${this.level} sandbox blocks writing to ${this.path}. Change permission.sandbox to allow it.`
  }
}

const WRITE_TOOLS = ["edit", "write", "apply_patch"]

// The sandbox contains writes only. `edit` requests always come from a write
// tool; `external_directory` is raised by readers too (read/glob/grep/list/lsp/
// skill, Truncate output), so it is contained only when a write tool asks.
export function containsWrite(input: { permission: string; toolID: string }) {
  if (input.permission === "edit" || input.permission === "memory") return true
  return input.permission === "external_directory" && WRITE_TOOLS.includes(input.toolID)
}

// Edit patterns are worktree-relative, so resolve them against the session root
// rather than the process cwd (which differs from the project in the desktop app).
function contains(root: string, target: string) {
  const rel = path.relative(path.resolve(root), path.resolve(root, target))
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
}

export function isPathAllowed(
  target: string,
  root: string,
  sandboxes: string[],
  level: ConfigPermissionV1.SandboxMode,
): boolean {
  if (level === "full-access") return true
  if (level === "readonly") return false
  if (contains(root, target)) return true
  return sandboxes.some((dir) => contains(dir, target))
}

export * as Sandbox from "./sandbox"
