import { describe, expect, test } from "bun:test"
import type { BackgroundShell } from "@flynncode/sdk/v2/client"
import {
  TAIL_LINES,
  appendTail,
  applyShellEvent,
  clipTail,
  formatElapsed,
  mergeShellList,
  runningCount,
  shellElapsed,
  type ShellEntry,
} from "@/hooks/use-background-shells"

const entry = (id: string, extra: Partial<ShellEntry> = {}): ShellEntry => ({
  id,
  sessionID: "ses_1",
  command: "sleep 100",
  pid: 10,
  outputPath: "/out/" + id,
  startedAt: 1_000,
  status: "running",
  tail: "",
  ...extra,
})

const shell = (id: string, extra: Partial<BackgroundShell> = {}): BackgroundShell => ({
  id,
  sessionID: "ses_1",
  command: "sleep 100",
  pid: 10,
  outputPath: "/out/" + id,
  startedAt: 1_000,
  status: "running",
  ...extra,
})

describe("applyShellEvent", () => {
  test("started appends a running placeholder keyed by id", () => {
    const next = applyShellEvent("ses_1", [], {
      type: "shell.background.started",
      properties: { sessionID: "ses_1", id: "bash_1", command: "npm run dev", pid: 42, startedAt: 5_000 },
    })
    expect(next).toEqual([
      {
        id: "bash_1",
        sessionID: "ses_1",
        command: "npm run dev",
        pid: 42,
        outputPath: "",
        startedAt: 5_000,
        status: "running",
        tail: "",
      },
    ])
  })

  test("started for a known id does not duplicate or lose its output path", () => {
    const list = [entry("bash_1", { outputPath: "/out/known", tail: "hi" })]
    const next = applyShellEvent("ses_1", list, {
      type: "shell.background.started",
      properties: { sessionID: "ses_1", id: "bash_1", command: "sleep 100", pid: 10, startedAt: 1_000 },
    })
    expect(next).toHaveLength(1)
    expect(next[0].outputPath).toBe("/out/known")
    expect(next[0].tail).toBe("hi")
  })

  test("output replaces the tail of the matching shell only", () => {
    const list = [entry("bash_1"), entry("bash_2")]
    const next = applyShellEvent("ses_1", list, {
      type: "shell.background.output",
      properties: { sessionID: "ses_1", id: "bash_2", bytes: 9, tail: "a\nb\n" },
    })
    expect(next[0]).toBe(list[0])
    expect(next[1].tail).toBe("a\nb")
  })

  test("output for an unknown shell is ignored", () => {
    const list = [entry("bash_1")]
    const next = applyShellEvent("ses_1", list, {
      type: "shell.background.output",
      properties: { sessionID: "ses_1", id: "bash_9", bytes: 1, tail: "x" },
    })
    expect(next).toBe(list)
  })

  test("exited records status, exit code and end time", () => {
    const next = applyShellEvent(
      "ses_1",
      [entry("bash_1")],
      {
        type: "shell.background.exited",
        properties: { sessionID: "ses_1", id: "bash_1", status: "exited", exitCode: 3 },
      },
      9_000,
    )
    expect(next[0]).toMatchObject({ status: "exited", exitCode: 3, endedAt: 9_000 })
  })

  test("events for another session are ignored", () => {
    const list = [entry("bash_1")]
    const next = applyShellEvent("ses_1", list, {
      type: "shell.background.exited",
      properties: { sessionID: "ses_2", id: "bash_1", status: "killed" },
    })
    expect(next).toBe(list)
  })
})

describe("mergeShellList", () => {
  test("keeps live tails, takes server fields and prunes shells that disappeared", () => {
    const current = [entry("bash_1", { tail: "live", outputPath: "" }), entry("bash_2", { tail: "gone" })]
    const next = mergeShellList(current, [shell("bash_1", { status: "exited", exitCode: 0, endedAt: 2_000 })])
    expect(next.map((item) => item.id)).toEqual(["bash_1"])
    expect(next[0]).toMatchObject({ tail: "live", outputPath: "/out/bash_1", status: "exited", exitCode: 0 })
  })

  test("adds shells the server knows about with an empty tail", () => {
    const next = mergeShellList([], [shell("bash_4")])
    expect(next).toEqual([{ ...shell("bash_4"), tail: "" }])
  })
})

describe("appendTail", () => {
  test("splices an overlapping event tail onto a longer loaded tail", () => {
    expect(appendTail("l1\nl2\nl3", "l2\nl3\nl4\n")).toBe("l1\nl2\nl3\nl4")
  })

  test("keeps the loaded tail when the event adds nothing and replaces it without overlap", () => {
    expect(appendTail("l1\nl2", "l2")).toBe("l1\nl2")
    expect(appendTail("old", "brand new")).toBe("brand new")
    expect(appendTail("", "first\n")).toBe("first")
  })
})

describe("clipTail", () => {
  test("keeps only the last 200 lines", () => {
    const text = Array.from({ length: 450 }, (_, index) => `line ${index}`).join("\n")
    const lines = clipTail(text).split("\n")
    expect(TAIL_LINES).toBe(200)
    expect(lines).toHaveLength(200)
    expect(lines[0]).toBe("line 250")
    expect(lines.at(-1)).toBe("line 449")
  })

  test("leaves short output alone and drops one trailing newline", () => {
    expect(clipTail("a\nb\n")).toBe("a\nb")
    expect(clipTail("")).toBe("")
  })
})

describe("formatElapsed", () => {
  test("formats seconds, minutes and hours compactly", () => {
    expect(formatElapsed(-5)).toBe("0s")
    expect(formatElapsed(4_900)).toBe("4s")
    expect(formatElapsed(65_000)).toBe("1m 05s")
    expect(formatElapsed(3_600_000 + 125_000)).toBe("1h 02m")
  })

  test("shellElapsed stops counting at the end time", () => {
    expect(shellElapsed(entry("a"), 11_000)).toBe(10_000)
    expect(shellElapsed(entry("a", { status: "exited", endedAt: 4_000 }), 99_000)).toBe(3_000)
  })
})

describe("runningCount", () => {
  test("counts only running shells", () => {
    expect(runningCount([entry("a"), entry("b", { status: "killed" }), entry("c")])).toBe(2)
  })
})
