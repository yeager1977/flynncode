import { describe, expect, test } from "bun:test"
import { MAX_AGE_SECONDS } from "../src/cookies"
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

  test("expires tokens after the cookie lifetime", () => {
    const clock = { value: 1_000 }
    const store = createSessionStore({ now: () => clock.value })
    const token = store.issue()
    clock.value += MAX_AGE_SECONDS * 1000 - 1
    expect(store.verify(token)).toBe(true)
    clock.value += 1
    expect(store.verify(token)).toBe(false)
    expect(store.size()).toBe(0)
  })

  test("prunes expired tokens when issuing", () => {
    const clock = { value: 1_000 }
    const store = createSessionStore({ now: () => clock.value })
    store.issue()
    clock.value += MAX_AGE_SECONDS * 1000
    const fresh = store.issue()
    expect(store.size()).toBe(1)
    expect(store.verify(fresh)).toBe(true)
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