import { describe, expect, test } from "bun:test"
import { filterSessionsByKind, isKnowledgeSession } from "./home-kind-filter"

const rows = [{ id: "a", kind: "code" }, { id: "b", kind: "knowledge" }, { id: "c" }, { id: "d", kind: undefined }]
const kindOf = (row: (typeof rows)[number]) => row

describe("filterSessionsByKind", () => {
  test("knowledge filter keeps only explicit knowledge sessions", () => {
    expect(filterSessionsByKind(rows, "knowledge", kindOf).map((row) => row.id)).toEqual(["b"])
  })

  test("code filter keeps sessions without an explicit knowledge kind", () => {
    expect(filterSessionsByKind(rows, "code", kindOf).map((row) => row.id)).toEqual(["a", "c", "d"])
  })

  test("all keeps everything", () => {
    expect(filterSessionsByKind(rows, "all", kindOf).length).toBe(4)
  })

  test("missing kind is not knowledge", () => {
    expect(isKnowledgeSession({})).toBe(false)
  })
})
