import { describe, expect, test } from "bun:test"
import { getOrCreateMobilePhonePassword, type PasswordStore } from "./mobile-password"
import { MOBILE_PHONE_PASSWORD_KEY } from "./store-keys"

function memoryStore(initial?: Record<string, string>): PasswordStore & { data: Map<string, string> } {
  const data = new Map<string, string>(Object.entries(initial ?? {}))
  return {
    data,
    get: (key) => data.get(key),
    set: (key, value) => {
      data.set(key, value)
    },
  }
}

describe("getOrCreateMobilePhonePassword", () => {
  test("reuses the persisted password without generating", () => {
    const store = memoryStore({ [MOBILE_PHONE_PASSWORD_KEY]: "phone-secret" })
    let generated = 0
    const result = getOrCreateMobilePhonePassword(store, MOBILE_PHONE_PASSWORD_KEY, () => {
      generated += 1
      return "new-secret"
    })
    expect(result).toBe("phone-secret")
    expect(generated).toBe(0)
  })

  test("generates and persists when missing", () => {
    const store = memoryStore()
    const result = getOrCreateMobilePhonePassword(store, MOBILE_PHONE_PASSWORD_KEY, () => "fresh-secret")
    expect(result).toBe("fresh-secret")
    expect(store.data.get(MOBILE_PHONE_PASSWORD_KEY)).toBe("fresh-secret")
  })

  test("treats empty string as missing", () => {
    const store = memoryStore({ [MOBILE_PHONE_PASSWORD_KEY]: "" })
    const result = getOrCreateMobilePhonePassword(store, MOBILE_PHONE_PASSWORD_KEY, () => "fresh-secret")
    expect(result).toBe("fresh-secret")
    expect(store.data.get(MOBILE_PHONE_PASSWORD_KEY)).toBe("fresh-secret")
  })
})
