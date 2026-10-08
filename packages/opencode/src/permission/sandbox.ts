import { Schema } from "effect"
import path from "path"
import { ConfigPermissionV1 } from "@opencode-ai/core/v1/config/permission"

export class SandboxViolationError extends Schema.TaggedErrorClass<SandboxViolationError>()(
  "SandboxViolationError",
  {
    path: Schema.String,
    level: ConfigPermissionV1.SandboxMode,
  },
) {}

// Edit patterns are worktree-relative, so resolve them against the session root
// rather than the process cwd (which differs from the project in the desktop app).
function contains(root: string, target: string) {
  const rel = path.relative(path.resolve(root), path.resolve(root, target))
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
}

export function resolveLevel(raw: unknown): ConfigPermissionV1.SandboxMode {
  if (raw === undefined) return "workspace-write"
  return Schema.decodeUnknownSync(ConfigPermissionV1.SandboxMode)(raw)
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
