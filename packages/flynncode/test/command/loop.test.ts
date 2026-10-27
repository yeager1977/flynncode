import { LayerNode } from "@flynncode/core/effect/layer-node"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import path from "path"
import { Command } from "../../src/command"
import { instructions, parseInterval } from "../../src/command/loop"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Command.node])))

describe("parseInterval", () => {
  test("minutes that divide an hour map to a step", () => {
    expect(parseInterval("5m")).toEqual({ cron: "*/5 * * * *" })
    expect(parseInterval("1m")).toEqual({ cron: "*/1 * * * *" })
    expect(parseInterval("30m")).toEqual({ cron: "*/30 * * * *" })
    expect(parseInterval("15M")).toEqual({ cron: "*/15 * * * *" })
  })

  test("minutes that do not divide an hour round to the nearest step and say so", () => {
    expect(parseInterval("7m")?.cron).toBe("*/6 * * * *")
    expect(parseInterval("7m")?.note).toContain("every 6 minutes")
    expect(parseInterval("8m")?.cron).toBe("*/10 * * * *")
    // A tie rounds to the longer interval: 45 is as far from 30 as from 60.
    expect(parseInterval("45m")?.cron).toBe("0 */1 * * *")
    expect(parseInterval("45m")?.note).toContain("every 1 hour")
  })

  test("minutes beyond an hour round to hours", () => {
    expect(parseInterval("60m")).toEqual({ cron: "0 */1 * * *" })
    expect(parseInterval("120m")).toEqual({ cron: "0 */2 * * *" })
    expect(parseInterval("90m")?.cron).toBe("0 */2 * * *")
    expect(parseInterval("90m")?.note).toContain("rounded to every 2 hours")
    expect(parseInterval("1440m")).toEqual({ cron: "0 0 */1 * *" })
  })

  test("hours that divide a day map to a step; others round", () => {
    expect(parseInterval("1h")).toEqual({ cron: "0 */1 * * *" })
    expect(parseInterval("2h")).toEqual({ cron: "0 */2 * * *" })
    expect(parseInterval("12h")).toEqual({ cron: "0 */12 * * *" })
    expect(parseInterval("5h")?.cron).toBe("0 */6 * * *")
    expect(parseInterval("5h")?.note).toContain("every 6 hours")
    expect(parseInterval("9h")?.cron).toBe("0 */8 * * *")
    expect(parseInterval("24h")).toEqual({ cron: "0 0 */1 * *" })
    expect(parseInterval("48h")).toEqual({ cron: "0 0 */2 * *" })
  })

  test("days map to a day-of-month step", () => {
    expect(parseInterval("1d")).toEqual({ cron: "0 0 */1 * *" })
    expect(parseInterval("3d")).toEqual({ cron: "0 0 */3 * *" })
    expect(parseInterval("45d")?.cron).toBe("0 0 */31 * *")
    expect(parseInterval("45d")?.note).toContain("every 31 days")
  })

  test("seconds round up to whole minutes", () => {
    expect(parseInterval("30s")?.cron).toBe("*/1 * * * *")
    expect(parseInterval("30s")?.note).toContain("every 1 minute")
    expect(parseInterval("1s")?.cron).toBe("*/1 * * * *")
    expect(parseInterval("90s")?.cron).toBe("*/2 * * * *")
    expect(parseInterval("300s")).toEqual({ cron: "*/5 * * * *" })
  })

  test("anything else is not an interval", () => {
    for (const text of ["", "x", "5", "m", "0m", "-5m", "5mm", "1.5h", "5 m", "stop", "check"])
      expect(parseInterval(text)).toBeUndefined()
  })
})

describe("loop instructions", () => {
  test("an interval and a prompt run now, then schedule the cron", () => {
    const text = instructions("5m check the deploy")
    expect(text).toContain("*/5 * * * *")
    expect(text).toContain("cron_create")
    expect(text).toContain("Prompt: check the deploy")
    expect(text).toContain("now")
    expect(text).not.toContain("Note:")
    expect(text).not.toContain("schedule_wakeup")
  })

  test("a slash command stays the prompt, verbatim", () => {
    expect(instructions("10m /babysit-prs --all")).toContain("Prompt: /babysit-prs --all")
  })

  test("a rounded interval shows the chosen cron and a note", () => {
    const text = instructions("90m look at the queue")
    expect(text).toContain("0 */2 * * *")
    expect(text).toContain("Note: 90m cannot be scheduled exactly")
  })

  test("recurring jobs are said to expire after 7 days", () => {
    expect(instructions("1h x")).toContain("7 days")
  })

  test("a prompt alone is a self-paced loop with schedule_wakeup", () => {
    const text = instructions("fix the failing tests until they pass")
    expect(text).toContain("schedule_wakeup")
    expect(text).toContain("Prompt: fix the failing tests until they pass")
    expect(text).toContain("schedule nothing")
    expect(text).not.toContain("cron_create")
  })

  test("a prompt that merely starts with a number is still self-paced", () => {
    expect(instructions("5 minutes of cleanup")).toContain("schedule_wakeup")
    expect(instructions("5mins cleanup")).toContain("schedule_wakeup")
  })

  test("stop deletes this session's jobs through cron_list and cron_delete", () => {
    for (const text of [instructions("stop"), instructions("  STOP ")]) {
      expect(text).toContain("cron_list")
      expect(text).toContain("cron_delete")
      expect(text).not.toContain("cron_create")
      expect(text).not.toContain("schedule_wakeup")
    }
  })

  test("no arguments, or an interval without a prompt, gives usage and schedules nothing", () => {
    for (const text of [instructions(""), instructions("   "), instructions("5m")]) {
      expect(text).toContain("Do not schedule anything")
      expect(text).toContain("/loop <interval> <prompt>")
    }
  })
})

describe("the loop command", () => {
  it.instance(
    "is a built-in command that expands its arguments",
    () =>
      Effect.gen(function* () {
        const command = yield* Command.Service
        const loop = yield* command.get("loop")
        expect(loop?.source).toBe("command")
        expect(loop?.expand?.("5m x")).toContain("*/5 * * * *")
        expect(loop?.expand?.("x")).toContain("schedule_wakeup")
        expect(loop?.expand?.("stop")).toContain("cron_delete")
        expect((yield* command.list()).map((item) => item.name)).toContain("loop")
      }),
    { git: true },
  )

  it.instance(
    "a native config loop command overrides it",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* Effect.promise(async () => {
          const file = path.join(test.directory, ".opencode", "commands", "loop.md")
          await fs.mkdir(path.dirname(file), { recursive: true })
          await Bun.write(file, "---\ndescription: My loop\n---\nMine: $ARGUMENTS")
        })
        const loop = yield* (yield* Command.Service).get("loop")
        expect(loop?.description).toBe("My loop")
        expect(loop?.expand).toBeUndefined()
        expect(yield* Effect.promise(async () => loop?.template)).toBe("Mine: $ARGUMENTS")
      }),
    { git: true },
  )

  it.instance(
    "a Claude loop command overrides it, though Claude commands never replace other built-ins",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* Effect.promise(async () => {
          const dir = path.join(test.directory, ".claude", "commands")
          await fs.mkdir(dir, { recursive: true })
          await Bun.write(path.join(dir, "loop.md"), "---\ndescription: Claude loop\n---\nClaude: $ARGUMENTS")
          await Bun.write(path.join(dir, "init.md"), "---\ndescription: Hijack\n---\nHijacked")
        })
        const command = yield* Command.Service
        const loop = yield* command.get("loop")
        expect(loop?.description).toBe("Claude loop")
        expect(loop?.expand).toBeUndefined()
        expect((yield* command.get("init"))?.description).toBe("guided AGENTS.md setup")
      }),
    { git: true },
  )
})
