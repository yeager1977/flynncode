import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const local = readFileSync(new URL("../../context/local.tsx", import.meta.url), "utf8")
const selection = readFileSync(new URL("./composer/prompt-model-selection.tsx", import.meta.url), "utf8")
const helpers = readFileSync(new URL("./session-model-helpers.ts", import.meta.url), "utf8")

describe("contributor selection gate", () => {
  test("both ModelSelection.set implementations gate Contributor models", () => {
    for (const source of [local, selection]) {
      expect(source).toContain("isContributorModel")
      expect(source).toContain("DialogMetaContributor")
      expect(source).toContain("queueMicrotask")
    }
  })

  test("Cancel path applies no selection side effects", () => {
    expect(local).toContain("onCancel={() => {}}")
  })

  test("programmatic restores bypass the dialog", () => {
    expect(helpers).toContain("silent: true")
    expect(local).toContain("silent")
    expect(selection).toContain("silent")
  })

  test("submit gate blocks send before input is cleared", () => {
    const submit = readFileSync(
      new URL("../../components/prompt-input/submit.ts", import.meta.url),
      "utf8",
    )
    expect(submit).toContain("isContributorModel")
    expect(submit).toContain("DialogMetaContributor")
    const gateAt = submit.indexOf("isContributorModel")
    const clearAt = submit.indexOf("clearInput()")
    expect(gateAt).toBeGreaterThan(-1)
    expect(clearAt).toBeGreaterThan(-1)
    expect(gateAt).toBeLessThan(clearAt)
  })

  test("new sessions migrate the ack to the created session ID", () => {
    const submit = readFileSync(
      new URL("../../components/prompt-input/submit.ts", import.meta.url),
      "utf8",
    )
    expect(submit).toContain("`session:${session.id}`")
  })

  test("draft acks stay memory-only and uniquely scoped", () => {
    const ack = readFileSync(new URL("../../utils/contributor-ack.ts", import.meta.url), "utf8")
    expect(ack).toContain('startsWith("draft:")')
    expect(ack).toContain('startsWith("session:")')
    expect(ack).toContain("draftId")
    const guardAt = ack.indexOf('startsWith("session:")')
    const persistAt = ack.indexOf("setStore(key, Date.now())")
    expect(guardAt).toBeGreaterThan(-1)
    expect(persistAt).toBeGreaterThan(-1)
    expect(guardAt).toBeLessThan(persistAt)
  })

  test("ack scope key is captured once per gate", () => {
    const submit = readFileSync(
      new URL("../../components/prompt-input/submit.ts", import.meta.url),
      "utf8",
    )
    expect(submit).toContain("const key = ack.scopeKey()")
    expect(submit).not.toContain("ack.acked(ack.scopeKey())")
    expect(submit).not.toContain("ack.record(ack.scopeKey())")
    expect(local).toContain("const key = ack.scopeKey()")
    expect(selection).toContain("const key = ack.scopeKey()")
  })
})
