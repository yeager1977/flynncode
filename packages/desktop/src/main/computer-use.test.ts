import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { previewViewForSession } from "./preview-host"
import { claimComputerUseExecution, clampPanePoint, COMPUTER_USE_CLAIM_TTL, isComputerUseTargetAllowed } from "./computer-use"

describe("clampPanePoint", () => {
  test("clamps outside points inside the pane", () => {
    expect(clampPanePoint(-5, 900, { width: 800, height: 600 })).toEqual({ x: 0, y: 600 })
  })

  test("keeps inside points unchanged", () => {
    expect(clampPanePoint(100, 120, { width: 800, height: 600 })).toEqual({ x: 100, y: 120 })
  })
})

describe("isComputerUseTargetAllowed", () => {
  test("exact allowlist match only", () => {
    expect(isComputerUseTargetAllowed("com.example.gui", ["com.example.gui"])).toBe(true)
    expect(isComputerUseTargetAllowed("other", ["com.example.gui"])).toBe(false)
    expect(isComputerUseTargetAllowed("com.example.gui", [])).toBe(false)
  })
})

describe("claimComputerUseExecution", () => {
  test("single winner per request id", () => {
    const claims = new Map<string, number>()
    expect(claimComputerUseExecution(claims, "cue_a", 1000)).toBe(true)
    expect(claimComputerUseExecution(claims, "cue_a", 1001)).toBe(false)
    expect(claimComputerUseExecution(claims, "cue_b", 1002)).toBe(true)
  })

  test("expired claims are pruned lazily and the request can be executed again", () => {
    const claims = new Map<string, number>()
    expect(claimComputerUseExecution(claims, "cue_a", 1000)).toBe(true)
    expect(claimComputerUseExecution(claims, "cue_a", 1000 + COMPUTER_USE_CLAIM_TTL + 1)).toBe(true)
    expect(claims.get("cue_a")).toBe(1000 + COMPUTER_USE_CLAIM_TTL + 1)
  })

  test("live claims are not pruned", () => {
    const claims = new Map<string, number>()
    claimComputerUseExecution(claims, "cue_a", 1000)
    claimComputerUseExecution(claims, "cue_b", 1001)
    expect(claims.size).toBe(2)
  })
})

describe("preview partition matcher", () => {
  const fakeView = (session: unknown) => ({ webContents: { session } })
  const fakeWindow = (children: unknown[]) => ({ contentView: { children } }) as never

  test("only the child view running the preview partition session is the pane", () => {
    const pane = fakeView("preview-session")
    const web = fakeView("web-session")
    expect(previewViewForSession(fakeWindow([web, pane]), "preview-session")).toBe(pane)
  })

  test("no pane when the partition session is unknown or unset", () => {
    expect(previewViewForSession(fakeWindow([fakeView("web-session")]), "preview-session")).toBeUndefined()
    expect(previewViewForSession(fakeWindow([fakeView("web-session")]), undefined)).toBeUndefined()
    expect(previewViewForSession(fakeWindow([]), "preview-session")).toBeUndefined()
  })
})

describe("computer-use ipc surface", () => {
  const ipcSource = readFileSync(new URL("./ipc.ts", import.meta.url), "utf8")
  const hostSource = readFileSync(new URL("./preview-host.ts", import.meta.url), "utf8")

  test("actuation handlers claim exactly one executor and answer with outcomes", () => {
    for (const channel of ["computer-use-screenshot", "computer-use-click", "computer-use-type", "computer-use-keypress", "computer-use-scroll"]) {
      expect(ipcSource).toContain(`"${channel}"`)
    }
    expect(ipcSource).toContain("claimComputerUseExecution")
  })

  test("guest window.open is denied and subframe commits are validated", () => {
    expect(hostSource).toContain('setWindowOpenHandler(() => ({ action: "deny" }))')
    expect(hostSource).toContain("did-frame-navigate")
  })
})