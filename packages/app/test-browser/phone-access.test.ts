import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createPhoneAccessController } from "@/components/settings-v2/phone-access-controller"

// Needs the browser build of Solid so effects and cleanups run:
// bun test --conditions=browser --preload ./happydom.ts ./test-browser/phone-access.test.ts

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

function fakeApi(initial: boolean) {
  const calls: boolean[] = []
  const control = { value: initial, fail: false, gate: undefined as Promise<void> | undefined }
  const api = {
    getPhoneAccess: async () => {
      const stored = control.value
      await control.gate
      return stored
    },
    setPhoneAccess: async (enabled: boolean) => {
      calls.push(enabled)
      if (control.fail) throw new Error("ipc down")
      control.value = enabled
    },
  }
  return { api, calls, control }
}

describe("createPhoneAccessController", () => {
  test("is off until the stored value says otherwise", async () => {
    const fake = fakeApi(true)
    await createRoot(async (dispose) => {
      const phone = createPhoneAccessController({ api: fake.api, refetch: () => {}, delays: [] })
      expect(phone.enabled()).toBe(false)
      await tick()
      expect(phone.enabled()).toBe(true)
      dispose()
    })
  })

  test("stays off without a desktop bridge", async () => {
    await createRoot(async (dispose) => {
      const phone = createPhoneAccessController({ api: undefined, refetch: () => {}, delays: [] })
      await tick()
      expect(phone.enabled()).toBe(false)
      phone.toggle(true)
      expect(phone.enabled()).toBe(false)
      dispose()
    })
  })

  test("toggling saves, then refetches the gateway status on a schedule", async () => {
    const fake = fakeApi(false)
    let refetches = 0
    await createRoot(async (dispose) => {
      const phone = createPhoneAccessController({ api: fake.api, refetch: () => refetches++, delays: [5, 15] })
      await tick()
      phone.toggle(true)
      expect(phone.enabled()).toBe(true)
      await tick()
      expect(fake.calls).toEqual([true])
      expect(refetches).toBe(0)
      await tick(30)
      expect(refetches).toBe(2)
      dispose()
    })
  })

  test("rolls the switch back when main refuses the change", async () => {
    const fake = fakeApi(false)
    fake.control.fail = true
    let refetches = 0
    await createRoot(async (dispose) => {
      const phone = createPhoneAccessController({ api: fake.api, refetch: () => refetches++, delays: [5] })
      await tick()
      phone.toggle(true)
      expect(phone.enabled()).toBe(true)
      await tick(20)
      expect(phone.enabled()).toBe(false)
      expect(refetches).toBe(0)
      dispose()
    })
  })

  test("a slow initial read does not overwrite a choice made meanwhile", async () => {
    const fake = fakeApi(true)
    let release = () => {}
    fake.control.gate = new Promise<void>((resolve) => (release = resolve))
    await createRoot(async (dispose) => {
      const phone = createPhoneAccessController({ api: fake.api, refetch: () => {}, delays: [] })
      phone.toggle(false)
      release()
      await tick()
      expect(phone.enabled()).toBe(false)
      dispose()
    })
  })

  test("pending refetches are cancelled when the card goes away", async () => {
    const fake = fakeApi(false)
    let refetches = 0
    await createRoot(async (dispose) => {
      const phone = createPhoneAccessController({ api: fake.api, refetch: () => refetches++, delays: [10] })
      await tick()
      phone.toggle(true)
      await tick()
      dispose()
    })
    await tick(30)
    expect(refetches).toBe(0)
  })
})
