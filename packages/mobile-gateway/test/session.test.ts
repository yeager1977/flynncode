import { describe, expect, test } from "bun:test"
import { createSessionStore } from "../src/session"

describe("session store", () => {
  test("verifies an issued token", () => {
    const store = createSessionStore()
    const token = store.issue()
    expect(store.verify(token)).toBe(true)
  })

  test("rejects an unknown token", () => {
    const store = createSessionStore()
    store.issue()
    expect(store.verify("nope")).toBe(false)
  })

  test("rejects undefined and empty tokens", () => {
    const store = createSessionStore()
    expect(store.verify(undefined)).toBe(false)
    expect(store.verify("")).toBe(false)
  })

  test("issues distinct tokens", () => {
    const store = createSessionStore()
    expect(store.issue()).not.toBe(store.issue())
    expect(store.size()).toBe(2)
  })

  test("tracks issued tokens", () => {
    const store = createSessionStore()
    expect(store.size()).toBe(0)
    const token = store.issue()
    expect(store.size()).toBe(1)
    store.verify(token)
    expect(store.size()).toBe(1)
  })
})