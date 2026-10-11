import { expect, test } from "bun:test"
import type { Hooks } from "@opencode-ai/plugin"
import type { Permission } from "@opencode-ai/sdk"

// Type-level guard: a legacy hook explicitly annotated with the response
// shaped Permission input must stay assignable to Hooks["permission.ask"].
// The slot is declared as a method precisely so parameter assignability stays
// bivariant under strictFunctionTypes — a property-style slot typed with the
// narrower PermissionAskInput (or a `Permission | PermissionAskInput` union
// parameter) fails TS2322 for those legacy hooks, verified with tsc --strict.
function legacyAnnotatedHook(input: Permission, output: { status: "ask" | "deny" | "allow" }): Promise<void> {
  void input.id
  void output.status
  return Promise.resolve()
}

const legacyHooks: Hooks = { "permission.ask": legacyAnnotatedHook }

function askAnnotatedHook(
  input: Parameters<NonNullable<Hooks["permission.ask"]>>[0],
  output: { status: "ask" | "deny" | "allow" },
): Promise<void> {
  void input
  void output
  return Promise.resolve()
}

const askHooks: Hooks = { "permission.ask": askAnnotatedHook }

test("legacy Permission-annotated permission.ask hooks stay source compatible", () => {
  expect(legacyHooks["permission.ask"]).toBe(legacyAnnotatedHook)
  expect(askHooks["permission.ask"]).toBe(askAnnotatedHook)
})