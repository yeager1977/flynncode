import { describe, expect, test } from "bun:test"
import { sidecarExecArgv } from "./sidecar-exec-args"

describe("sidecarExecArgv", () => {
  test("omits the execArgv key entirely when the variable is unset", () => {
    // An explicit undefined value makes utilityProcess throw "Invalid value for
    // execArgv" at every launch, so the key must be absent, not undefined.
    expect("execArgv" in sidecarExecArgv(undefined)).toBe(false)
  })

  test("omits the execArgv key when the variable is empty or all separators", () => {
    expect("execArgv" in sidecarExecArgv("")).toBe(false)
    expect("execArgv" in sidecarExecArgv(", ,")).toBe(false)
  })

  test("splits and trims a single runtime flag", () => {
    expect(sidecarExecArgv(" --inspect ")).toEqual({ execArgv: ["--inspect"] })
  })

  test("keeps comma-separated flags in order", () => {
    expect(sidecarExecArgv("--inspect=127.0.0.1:9229,--max-old-space-size=4096")).toEqual({
      execArgv: ["--inspect=127.0.0.1:9229", "--max-old-space-size=4096"],
    })
  })
})