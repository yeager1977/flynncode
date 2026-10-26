import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { Cause, Effect, Exit } from "effect"
import { NotebookEditTool } from "../../src/tool/notebook-edit"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { FSUtil } from "@flynncode/core/fs-util"
import { Agent } from "../../src/agent/agent"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Truncate } from "@/tool/truncate"
import { SessionID, MessageID } from "../../src/session/schema"
import * as Tool from "../../src/tool/tool"
import { testEffect } from "../lib/effect"

const ctx = {
  sessionID: SessionID.make("ses_test-notebook-edit-session"),
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

const layer = LayerNode.compile(LayerNode.group([FSUtil.node, EventV2Bridge.node, Truncate.node, Agent.node]))

const it = testEffect(layer)

const run = Effect.fn("NotebookEditToolTest.run")(function* (
  args: Tool.InferParameters<typeof NotebookEditTool>,
  next: Tool.Context = ctx,
) {
  const info = yield* NotebookEditTool
  const tool = yield* info.init()
  return yield* tool.execute(args, next)
})

const fail = Effect.fn("NotebookEditToolTest.fail")(function* (
  args: Tool.InferParameters<typeof NotebookEditTool>,
  next: Tool.Context = ctx,
) {
  const exit = yield* run(args, next).pipe(Effect.exit)
  if (Exit.isFailure(exit)) {
    const err = Cause.squash(exit.cause)
    return err instanceof Error ? err : new Error(String(err))
  }
  throw new Error("expected notebook_edit to fail")
})

const put = Effect.fn("NotebookEditToolTest.put")(function* (p: string, content: string) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(p, content)
})

const load = Effect.fn("NotebookEditToolTest.load")(function* (p: string) {
  const fs = yield* FSUtil.Service
  return yield* fs.readFileString(p)
})

// Keys are alphabetical like Jupyter writes them; indent is one space.
const code = (id: string | undefined, source: string[], outputs: unknown[] = [], count: number | null = null) => ({
  cell_type: "code",
  execution_count: count,
  ...(id ? { id } : {}),
  metadata: {},
  outputs,
  source,
})

const markdown = (id: string | undefined, source: string[]) => ({
  cell_type: "markdown",
  ...(id ? { id } : {}),
  metadata: {},
  source,
})

const notebook = (cells: unknown[], minor = 5) => ({
  cells,
  metadata: { kernelspec: { display_name: "Python 3", language: "python", name: "python3" } },
  nbformat: 4,
  nbformat_minor: minor,
})

const stream = [{ name: "stdout", output_type: "stream", text: ["hi\n"] }]
const result = [{ data: { "text/plain": ["3"] }, execution_count: 2, metadata: {}, output_type: "execute_result" }]

const sample = () =>
  notebook([
    markdown("aaaa1111", ["# Title\n", "intro"]),
    code("bbbb2222", ["print('hi')"], stream, 1),
    code("cccc3333", ["1 + 2\n", "3"], result, 2),
  ])

const dump = (nb: unknown, indent: number | undefined = 1) => JSON.stringify(nb, null, indent) + "\n"

describe("tool.notebook_edit", () => {
  it.instance("replaces a cell, clears its outputs and keeps the others untouched", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "nb.ipynb")
      yield* put(filepath, dump(sample()))

      const asks: Array<{ permission: string; patterns: readonly string[]; metadata: Record<string, unknown> }> = []
      const out = yield* run(
        { notebook_path: filepath, cell_id: "bbbb2222", new_source: "print('bye')\nx = 1" },
        { ...ctx, ask: (req) => Effect.sync(() => void asks.push(req)) },
      )

      const expected = sample()
      expected.cells[1] = code("bbbb2222", ["print('bye')\n", "x = 1"], [], null)
      expect(yield* load(filepath)).toBe(dump(expected))
      expect(asks).toHaveLength(1)
      expect(asks[0].permission).toBe("edit")
      expect(asks[0].patterns[0].endsWith("nb.ipynb")).toBe(true)
      expect(String(asks[0].metadata.diff)).toContain("+  \"print('bye')\\n\"")
      expect(out.output).toContain("bbbb2222")
      expect(out.metadata.filediff.additions).toBeGreaterThan(0)
    }),
  )

  it.instance("replaces a markdown cell without adding code fields", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "nb.ipynb")
      yield* put(filepath, dump(sample()))

      yield* run({ notebook_path: filepath, cell_id: "aaaa1111", new_source: "# New" })

      const expected = sample()
      expected.cells[0] = markdown("aaaa1111", ["# New"])
      expect(yield* load(filepath)).toBe(dump(expected))
    }),
  )

  it.instance("can change a cell type on replace", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "nb.ipynb")
      yield* put(filepath, dump(sample()))

      yield* run({ notebook_path: filepath, cell_id: "aaaa1111", new_source: "x = 1", cell_type: "code" })

      const expected = sample()
      expected.cells[0] = code("aaaa1111", ["x = 1"], [], null)
      expect(yield* load(filepath)).toBe(dump(expected))
    }),
  )

  it.instance("inserts after the given cell with a generated id", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "nb.ipynb")
      yield* put(filepath, dump(sample()))

      const out = yield* run({
        notebook_path: filepath,
        cell_id: "aaaa1111",
        edit_mode: "insert",
        cell_type: "code",
        new_source: "import os",
      })

      const saved = JSON.parse(yield* load(filepath))
      expect(saved.cells).toHaveLength(4)
      expect(saved.cells[1].cell_type).toBe("code")
      expect(saved.cells[1].id).toMatch(/^[0-9a-f]{8}$/)
      expect(saved.cells[1].source).toEqual(["import os"])
      expect(saved.cells[1].outputs).toEqual([])
      expect(saved.cells[1].execution_count).toBeNull()
      expect(saved.cells[1].metadata).toEqual({})
      expect(Object.keys(saved.cells[1])).toEqual([
        "cell_type",
        "execution_count",
        "id",
        "metadata",
        "outputs",
        "source",
      ])
      expect(saved.cells[2].id).toBe("bbbb2222")
      expect(saved.cells[3].outputs).toEqual(result)
      expect(out.output).toContain(saved.cells[1].id)
    }),
  )

  it.instance("inserts at the start when no cell_id is given", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "nb.ipynb")
      yield* put(filepath, dump(sample()))

      yield* run({ notebook_path: filepath, edit_mode: "insert", cell_type: "markdown", new_source: "top" })

      const saved = JSON.parse(yield* load(filepath))
      expect(saved.cells.map((cell: { cell_type: string }) => cell.cell_type)).toEqual([
        "markdown",
        "markdown",
        "code",
        "code",
      ])
      expect(saved.cells[0].source).toEqual(["top"])
      expect(Object.keys(saved.cells[0])).toEqual(["cell_type", "id", "metadata", "source"])
      expect(saved.cells[1].id).toBe("aaaa1111")
    }),
  )

  it.instance("requires cell_type to insert", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "nb.ipynb")
      const original = dump(sample())
      yield* put(filepath, original)

      const err = yield* fail({ notebook_path: filepath, edit_mode: "insert", new_source: "x" })

      expect(err.message).toContain("cell_type")
      expect(yield* load(filepath)).toBe(original)
    }),
  )

  it.instance("deletes a cell and keeps the others", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "nb.ipynb")
      yield* put(filepath, dump(sample()))

      yield* run({ notebook_path: filepath, cell_id: "bbbb2222", edit_mode: "delete" })

      const expected = sample()
      expected.cells.splice(1, 1)
      expect(yield* load(filepath)).toBe(dump(expected))
    }),
  )

  it.instance("preserves indentation, key order, trailing newline and source form", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "nb.ipynb")
      // Four-space indent, unsorted keys, string sources, no trailing newline.
      const nb = {
        nbformat: 4,
        nbformat_minor: 4,
        metadata: { zeta: 1, alpha: 2 },
        cells: [
          { source: "a = 1\nb = 2", outputs: stream, metadata: {}, execution_count: 3, cell_type: "code" },
          { source: "text", metadata: {}, cell_type: "markdown" },
        ],
      }
      yield* put(filepath, JSON.stringify(nb, null, 4))

      yield* run({ notebook_path: filepath, cell_id: "cell-1", new_source: "changed\nlines" })
      const edited = {
        ...nb,
        cells: [nb.cells[0], { source: "changed\nlines", metadata: {}, cell_type: "markdown" }],
      }
      expect(yield* load(filepath)).toBe(JSON.stringify(edited, null, 4))

      yield* run({ notebook_path: filepath, cell_id: "cell-0", new_source: "a = 5\nb = 6" })
      const again = {
        ...edited,
        cells: [
          { source: "a = 5\nb = 6", outputs: [], metadata: {}, execution_count: null, cell_type: "code" },
          edited.cells[1],
        ],
      }
      expect(yield* load(filepath)).toBe(JSON.stringify(again, null, 4))
    }),
  )

  it.instance("addresses cells of a notebook without ids as cell-<index> and adds no ids", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "nb.ipynb")
      const nb = notebook([code(undefined, ["a"], stream, 1), markdown(undefined, ["b"]), code(undefined, ["c"])], 2)
      yield* put(filepath, dump(nb))

      yield* run({ notebook_path: filepath, cell_id: "cell-1", edit_mode: "insert", cell_type: "raw", new_source: "r" })
      const saved = JSON.parse(yield* load(filepath))
      expect(saved.cells.map((cell: { source: string[] }) => cell.source[0])).toEqual(["a", "b", "r", "c"])
      expect(saved.cells.some((cell: { id?: string }) => cell.id !== undefined)).toBe(false)
      expect(saved.cells[2]).toEqual({ cell_type: "raw", metadata: {}, source: ["r"] })

      yield* run({ notebook_path: filepath, cell_id: "cell-3", edit_mode: "delete" })
      expect(JSON.parse(yield* load(filepath)).cells).toHaveLength(3)
    }),
  )

  it.instance("rejects an unknown cell id and leaves the file unchanged", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "nb.ipynb")
      const original = dump(sample())
      yield* put(filepath, original)

      for (const args of [
        { cell_id: "nope", new_source: "x" },
        { cell_id: "cell-9", new_source: "x" },
        { cell_id: "nope", edit_mode: "delete" as const },
        { cell_id: "nope", edit_mode: "insert" as const, cell_type: "code" as const, new_source: "x" },
      ]) {
        const err = yield* fail({ notebook_path: filepath, ...args })
        expect(err.message).toContain("not found")
        expect(err.message).toContain("aaaa1111")
        expect(yield* load(filepath)).toBe(original)
      }
    }),
  )

  it.instance("requires cell_id to replace", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "nb.ipynb")
      const original = dump(sample())
      yield* put(filepath, original)

      const err = yield* fail({ notebook_path: filepath, new_source: "x" })

      expect(err.message).toContain("cell_id")
      expect(yield* load(filepath)).toBe(original)
    }),
  )

  it.instance("rejects invalid JSON and non-notebook JSON without writing", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "nb.ipynb")
      for (const original of ["{not json", '{"a": 1}\n']) {
        yield* put(filepath, original)
        const err = yield* fail({ notebook_path: filepath, cell_id: "x", new_source: "y" })
        expect(err.message).toContain("not a valid notebook")
        expect(yield* load(filepath)).toBe(original)
      }
    }),
  )

  it.instance("rejects files that are not .ipynb and missing files", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const other = path.join(test.directory, "file.py")
      yield* put(other, "x = 1\n")
      expect((yield* fail({ notebook_path: other, cell_id: "x", new_source: "y" })).message).toContain(".ipynb")
      const missing = path.join(test.directory, "missing.ipynb")
      expect((yield* fail({ notebook_path: missing, cell_id: "x", new_source: "y" })).message).toContain("not found")
    }),
  )

  it.instance("writes nothing when permission is denied", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "nb.ipynb")
      const original = dump(sample())
      yield* put(filepath, original)

      const err = yield* fail(
        { notebook_path: filepath, cell_id: "bbbb2222", edit_mode: "delete" },
        { ...ctx, ask: () => Effect.die(new Error("denied")) },
      )

      expect(err.message).toContain("denied")
      expect(yield* load(filepath)).toBe(original)
    }),
  )
})
