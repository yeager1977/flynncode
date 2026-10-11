import { afterEach, describe, expect, test } from "bun:test"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { unlink } from "node:fs/promises"
import type { Part } from "@flynncode/sdk/v2"
import { parseOutputSchema, readStructuredResult } from "@/cli/cmd/run/output-schema"

const written: string[] = []
afterEach(async () => {
  await Promise.all(written.splice(0).map((file) => unlink(file).catch(() => {})))
})

async function schemaFile(body: string): Promise<string> {
  const file = join(tmpdir(), `output-schema-${Math.random().toString(36).slice(2)}.json`)
  await Bun.write(file, body)
  written.push(file)
  return file
}

function toolPart(tool: string, status: "completed" | "error", input: Record<string, unknown>): Part {
  return {
    id: "prt_1",
    sessionID: "ses_1",
    messageID: "msg_1",
    type: "tool",
    callID: "call_1",
    tool,
    state:
      status === "completed"
        ? {
            status,
            input,
            output: "Structured output captured successfully.",
            title: "Structured Output",
            metadata: {},
            time: { start: 1, end: 2 },
          }
        : {
            status,
            input,
            error: "boom",
            time: { start: 1, end: 2 },
          },
  }
}

describe("parseOutputSchema", () => {
  test("parses inline JSON objects", async () => {
    expect(await parseOutputSchema('{"type":"object"}')).toEqual({ type: "object" })
  })

  test("reads @file schemas", async () => {
    const file = await schemaFile('{"type":"object","x":1}')
    expect(await parseOutputSchema(`@${file}`)).toEqual({ type: "object", x: 1 })
  })

  test("rejects empty input", async () => {
    await expect(parseOutputSchema("  ")).rejects.toThrow("--output-schema must not be empty")
  })

  test("rejects non-object schemas", async () => {
    await expect(parseOutputSchema("[1]")).rejects.toThrow("--output-schema must be a JSON object schema")
  })

  test("rejects invalid inline JSON", async () => {
    await expect(parseOutputSchema("not json")).rejects.toThrow("--output-schema is not valid JSON")
  })

  test("rejects missing files", async () => {
    await expect(parseOutputSchema("@/tmp/opencode-no-such-schema.json")).rejects.toThrow(
      "--output-schema file not found",
    )
  })

  test("rejects invalid JSON files", async () => {
    const file = await schemaFile("not json")
    await expect(parseOutputSchema(`@${file}`)).rejects.toThrow("--output-schema file is not valid JSON")
  })
})

describe("readStructuredResult", () => {
  test("returns input of a completed StructuredOutput tool part", () => {
    expect(readStructuredResult(toolPart("StructuredOutput", "completed", { a: 1 }))).toEqual({ a: 1 })
  })

  test("ignores other tools", () => {
    expect(readStructuredResult(toolPart("bash", "completed", { a: 1 }))).toBeUndefined()
  })

  test("ignores errored StructuredOutput parts", () => {
    expect(readStructuredResult(toolPart("StructuredOutput", "error", { a: 1 }))).toBeUndefined()
  })

  test("ignores non-tool parts", () => {
    const part: Part = {
      id: "prt_2",
      sessionID: "ses_1",
      messageID: "msg_1",
      type: "text",
      text: "hi",
    }
    expect(readStructuredResult(part)).toBeUndefined()
  })
})
