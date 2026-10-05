import { describe, expect, test } from "bun:test"
import { autoArchiveAfterPrClose } from "./ci-status-auto-archive"

const base = {
  prState: "OPEN",
  sessionRunning: false,
  sessionArchived: false,
  settingEnabled: true,
}

describe("autoArchiveAfterPrClose", () => {
  test("never archives when the setting is off (default)", () => {
    expect(autoArchiveAfterPrClose({ ...base, settingEnabled: false, prState: "MERGED" })).toBe("none")
  })

  test("archives on a merged PR when idle and enabled", () => {
    expect(autoArchiveAfterPrClose({ ...base, prState: "MERGED" })).toBe("archive")
  })

  test("archives on a closed PR when idle and enabled", () => {
    expect(autoArchiveAfterPrClose({ ...base, prState: "CLOSED" })).toBe("archive")
  })

  test("waits while the PR is open or unknown", () => {
    expect(autoArchiveAfterPrClose({ ...base, prState: "OPEN" })).toBe("wait")
    expect(autoArchiveAfterPrClose({ ...base, prState: undefined })).toBe("wait")
  })

  test("waits while the session has running work, even on a merged PR", () => {
    expect(autoArchiveAfterPrClose({ ...base, prState: "MERGED", sessionRunning: true })).toBe("wait")
  })

  test("never re-archives an already-archived session", () => {
    expect(autoArchiveAfterPrClose({ ...base, prState: "MERGED", sessionArchived: true })).toBe("none")
  })
})