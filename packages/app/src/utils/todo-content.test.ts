import { describe, expect, test } from "bun:test"
import { splitTodoContent, todoDetail, todoSummary } from "./todo-content"

const planExample =
  "[WHERE] src/utils/validation.ts: Add validateEmail() for input sanitization - expect returns boolean"

describe("todoSummary", () => {
  test("strips the bracket tag and returns only the action segment for a path-pattern todo", () => {
    expect(todoSummary(planExample)).toBe("Add validateEmail() for input sanitization")
  })

  test("returns plain content unchanged", () => {
    expect(todoSummary("Add dark mode")).toBe("Add dark mode")
  })

  test("returns content unchanged when the expect marker is missing", () => {
    expect(todoSummary("src/utils/validation.ts: Add validateEmail() for input sanitization")).toBe(
      "src/utils/validation.ts: Add validateEmail() for input sanitization",
    )
  })

  test("truncates an action over 120 chars at the last word boundary with an ellipsis", () => {
    const longAction =
      "Implement the complete validation pipeline covering input sanitization, schema enforcement, boundary checks, error aggregation and result normalization"
    const content = `src/utils/validation.ts: ${longAction} - expect returns boolean`
    expect(todoSummary(content)).toBe(
      "Implement the complete validation pipeline covering input sanitization, schema enforcement, boundary checks, error\u2026",
    )
  })

  test("returns an overlong space-free action unchanged instead of corrupting it", () => {
    const token = "x".repeat(150)
    const content = `src/utils/token.ts: ${token} - expect returns boolean`
    expect(todoSummary(content)).toBe(token)
  })

  test("strips a bracket tag when no path pattern matches", () => {
    expect(todoSummary("[WHERE] Add dark mode")).toBe("Add dark mode")
  })
})

describe("todoDetail", () => {
  test("returns the original content verbatim", () => {
    expect(todoDetail(planExample)).toBe(planExample)
  })
})

describe("splitTodoContent", () => {
  test("returns the normalized summary with the verbatim detail", () => {
    expect(splitTodoContent(planExample)).toEqual({
      summary: "Add validateEmail() for input sanitization",
      detail: planExample,
    })
  })

  test("returns identical summary and detail for plain content", () => {
    expect(splitTodoContent("Add dark mode")).toEqual({ summary: "Add dark mode", detail: "Add dark mode" })
  })
})
