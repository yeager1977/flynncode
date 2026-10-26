import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { Cause, Effect, Exit } from "effect"
import { MultiEditTool } from "../../src/tool/multiedit"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { LSP } from "@/lsp/lsp"
import { FSUtil } from "@flynncode/core/fs-util"
import { Format } from "../../src/format"
import { Agent } from "../../src/agent/agent"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Truncate } from "@/tool/truncate"
import { SessionID, MessageID } from "../../src/session/schema"
import * as Tool from "../../src/tool/tool"
import { testEffect } from "../lib/effect"

const ctx = {
  sessionID: SessionID.make("ses_test-multiedit-session"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

afterEach(async () => {
  await disposeAllInstances()
})

const layer = LayerNode.compile(
  LayerNode.group([LSP.node, FSUtil.node, Format.node, EventV2Bridge.node, Truncate.node, Agent.node]),
)

const it = testEffect(layer)

const run = Effect.fn("MultiEditToolTest.run")(function* (
  args: Tool.InferParameters<typeof MultiEditTool>,
  next: Tool.Context = ctx,
) {
  const info = yield* MultiEditTool
  const tool = yield* info.init()
  return yield* tool.execute(args, next)
})

const fail = Effect.fn("MultiEditToolTest.fail")(function* (
  args: Tool.InferParameters<typeof MultiEditTool>,
  next: Tool.Context = ctx,
) {
  const exit = yield* run(args, next).pipe(Effect.exit)
  if (Exit.isFailure(exit)) {
    const err = Cause.squash(exit.cause)
    return err instanceof Error ? err : new Error(String(err))
  }
  throw new Error("expected multiedit to fail")
})

const put = Effect.fn("MultiEditToolTest.put")(function* (p: string, content: string) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(p, content)
})

const load = Effect.fn("MultiEditToolTest.load")(function* (p: string) {
  const fs = yield* FSUtil.Service
  return yield* fs.readFileString(p)
})

describe("tool.multiedit", () => {
  it.instance("applies every edit in order and asks once with the combined diff", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "file.txt")
      yield* put(filepath, "alpha\nbeta\ngamma\n")

      const asks: Array<{ permission: string; patterns: readonly string[]; metadata: Record<string, unknown> }> = []
      const result = yield* run(
        {
          file_path: filepath,
          edits: [
            { old_string: "alpha", new_string: "one" },
            { old_string: "one\nbeta", new_string: "one\ntwo" },
            { old_string: "gamma", new_string: "three" },
          ],
        },
        {
          ...ctx,
          ask: (req) =>
            Effect.sync(() => {
              asks.push(req)
            }),
        },
      )

      expect(yield* load(filepath)).toBe("one\ntwo\nthree\n")
      expect(asks).toHaveLength(1)
      expect(asks[0].permission).toBe("edit")
      expect(asks[0].patterns).toHaveLength(1)
      expect(asks[0].patterns[0].endsWith("file.txt")).toBe(true)
      expect(asks[0].metadata.diff).toContain("+three")
      expect(asks[0].metadata.diff).toContain("-alpha")
      expect(result.metadata.filediff.additions).toBe(3)
      expect(result.metadata.filediff.deletions).toBe(3)
    }),
  )

  it.instance("leaves the file unchanged and names the failing edit", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "file.txt")
      const original = "alpha\nbeta\n"
      yield* put(filepath, original)

      const err = yield* fail({
        file_path: filepath,
        edits: [
          { old_string: "alpha", new_string: "one" },
          { old_string: "missing", new_string: "two" },
        ],
      })

      expect(err.message).toContain("Edit 2")
      expect(err.message).toContain("Could not find")
      expect(yield* load(filepath)).toBe(original)
    }),
  )

  it.instance("rejects an ambiguous match unless replace_all is set", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "file.txt")
      yield* put(filepath, "x = 1\nx = 1\ny = 2\n")

      const err = yield* fail({
        file_path: filepath,
        edits: [
          { old_string: "y = 2", new_string: "y = 3" },
          { old_string: "x = 1", new_string: "x = 9" },
        ],
      })

      expect(err.message).toContain("Edit 2")
      expect(err.message).toContain("multiple matches")
      expect(yield* load(filepath)).toBe("x = 1\nx = 1\ny = 2\n")
    }),
  )

  it.instance("replaces every occurrence with replace_all", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "file.txt")
      yield* put(filepath, "x = 1\nx = 1\ny = 2\n")

      yield* run({
        file_path: filepath,
        edits: [
          { old_string: "x = 1", new_string: "x = 9", replace_all: true },
          { old_string: "y = 2", new_string: "y = 3" },
        ],
      })

      expect(yield* load(filepath)).toBe("x = 9\nx = 9\ny = 3\n")
    }),
  )

  it.instance("rejects an edit whose old_string equals new_string", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "file.txt")
      yield* put(filepath, "alpha\n")

      const err = yield* fail({
        file_path: filepath,
        edits: [
          { old_string: "alpha", new_string: "beta" },
          { old_string: "same", new_string: "same" },
        ],
      })

      expect(err.message).toContain("Edit 2")
      expect(err.message).toContain("identical")
      expect(yield* load(filepath)).toBe("alpha\n")
    }),
  )

  it.instance("rejects an empty old_string on an existing file", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "file.txt")
      yield* put(filepath, "alpha\n")

      const err = yield* fail({ file_path: filepath, edits: [{ old_string: "", new_string: "beta" }] })

      expect(err.message).toContain("Edit 1")
      expect(err.message).toContain("cannot be empty")
      expect(yield* load(filepath)).toBe("alpha\n")
    }),
  )

  it.instance("writes nothing when permission is denied", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "file.txt")
      yield* put(filepath, "alpha\n")

      const err = yield* fail(
        { file_path: filepath, edits: [{ old_string: "alpha", new_string: "beta" }] },
        { ...ctx, ask: () => Effect.die(new Error("denied")) },
      )

      expect(err.message).toContain("denied")
      expect(yield* load(filepath)).toBe("alpha\n")
    }),
  )

  it.instance("creates a new file when the first edit has an empty old_string", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "nested", "created.txt")

      yield* run({
        file_path: filepath,
        edits: [
          { old_string: "", new_string: "hello world\n" },
          { old_string: "world", new_string: "there" },
        ],
      })

      expect(yield* load(filepath)).toBe("hello there\n")
    }),
  )

  it.instance("fails on a missing file when the first edit has a non-empty old_string", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "missing.txt")

      const err = yield* fail({ file_path: filepath, edits: [{ old_string: "a", new_string: "b" }] })

      expect(err.message).toContain("not found")
    }),
  )

  it.instance("keeps CRLF line endings", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "crlf.txt")
      yield* put(filepath, "a\r\nb\r\nc\r\n")

      yield* run({
        file_path: filepath,
        edits: [
          { old_string: "a\nb", new_string: "a\nB" },
          { old_string: "c", new_string: "C" },
        ],
      })

      expect(yield* load(filepath)).toBe("a\r\nB\r\nC\r\n")
    }),
  )
})
