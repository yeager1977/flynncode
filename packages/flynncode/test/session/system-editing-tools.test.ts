import { describe, expect, test } from "bun:test"
import { SystemPrompt } from "../../src/session/system"

describe("SystemPrompt.editingTools", () => {
  test("names the editing tools the model actually has", () => {
    const statement = SystemPrompt.editingTools(["edit", "write", "read"])
    expect(statement).toContain("edit")
    expect(statement).toContain("write")
    // Listed as available, not as the tool to use.
    expect(statement).toContain("File editing tools available in this session: edit, write.")
  })

  test("names apply_patch when that is the editing tool", () => {
    const statement = SystemPrompt.editingTools(["apply_patch", "read"])
    expect(statement).toContain("apply_patch")
    expect(statement).not.toContain("`edit`")
  })

  test("names multiedit and notebook_edit when the model has them", () => {
    expect(SystemPrompt.editingTools(["edit", "multiedit", "notebook_edit", "write"])).toContain(
      "File editing tools available in this session: edit, multiedit, notebook_edit, write.",
    )
    // GPT-family models get apply_patch plus notebook_edit.
    expect(SystemPrompt.editingTools(["apply_patch", "notebook_edit"])).toContain(
      "File editing tools available in this session: apply_patch, notebook_edit.",
    )
  })

  test("says nothing when no editing tool is available", () => {
    expect(SystemPrompt.editingTools(["read", "grep"])).toBeUndefined()
  })

  test("states that a named tool the model lacks is not available", () => {
    // The skill harness tells the model to use apply_patch for edits. When
    // the model cannot have it, the prompt has to say so, or the model
    // reports a missing tool instead of using the one it has.
    const statement = SystemPrompt.editingTools(["edit", "write"])
    expect(statement).toContain("apply_patch")
  })
})
