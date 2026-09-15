import { describe, expect, test } from "bun:test"
import { SESSION_COOKIE, readCookie, sessionCookie } from "../src/cookies"

describe("readCookie", () => {
  test("reads a cookie by name", () => {
    expect(readCookie("a=1; oc_mobile_session=abc; b=2", SESSION_COOKIE)).toBe("abc")
  })

  test("returns undefined when absent", () => {
    expect(readCookie("a=1", SESSION_COOKIE)).toBeUndefined()
    expect(readCookie(undefined, SESSION_COOKIE)).toBeUndefined()
    expect(readCookie("", SESSION_COOKIE)).toBeUndefined()
  })

  test("tolerates whitespace and empty segments", () => {
    expect(readCookie("  ;  oc_mobile_session = spaced ; ", SESSION_COOKIE)).toBe("spaced")
  })

  test("does not match a prefix of another cookie name", () => {
    expect(readCookie("oc_mobile_session_extra=nope", SESSION_COOKIE)).toBeUndefined()
  })
})

describe("sessionCookie", () => {
  test("sets the required attributes", () => {
    const value = sessionCookie("token123")
    expect(value).toBe("oc_mobile_session=token123; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000")
  })
})