import { describe, expect, test } from "bun:test"
import { ProviderMeta } from "@/provider/meta"

// Shapes captured from Meta's real /v1/responses stream (2026-11-11): the
// model calls wrapped tools under dotted `namespace.tool` names.
const OUTPUT_ITEM_ADDED =
  `event: response.output_item.added\n` +
  `data: {"item":{"id":"fc_01a1cd87487177c0889a17bb9f8f86c6","status":"in_progress","type":"function_call","name":"opencode.bash"},"output_index":2,"sequence_number":10,"type":"response.output_item.added"}\n\n`
const ARGUMENTS_DELTA =
  `event: response.function_call_arguments.delta\n` +
  `data: {"delta":"{\\"command\\":\\"echo hi\\"}","item_id":"fc_01a1cd87487177c0889a17bb9f8f86c6","output_index":2,"sequence_number":11,"type":"response.function_call_arguments.delta"}\n\n`
const ARGUMENTS_DONE =
  `event: response.function_call_arguments.done\n` +
  `data: {"arguments":"{\\"command\\":\\"echo hi\\"}","item_id":"fc_01a1cd87487177c0889a17bb9f8f86c6","name":"opencode.bash","output_index":2,"sequence_number":12,"type":"response.function_call_arguments.done"}\n\n`
const OUTPUT_ITEM_DONE =
  `event: response.output_item.done\n` +
  `data: {"item":{"type":"function_call","id":"fc_01a1cd87487177c0889a17bb9f8f86c6","call_id":"call_584e8fe2","name":"opencode.bash","arguments":"{\\"command\\":\\"echo hi\\"}"},"type":"response.output_item.done"}\n\n`
const COMPLETED =
  `event: response.completed\n` +
  `data: {"response":{"id":"resp_1","output":[{"type":"reasoning","id":"rs_1"},{"type":"function_call","id":"fc_1","call_id":"call_584e8fe2","name":"opencode.bash","arguments":"{}"}],"type":"response.completed"},"sequence_number":13,"type":"response.completed"}\n\n`
const SUBSCRIPTION_USAGE =
  `event: response.subscription_usage\n` +
  `data: {"period":"five_hour","utilization":0.42,"type":"response.subscription_usage"}\n\n`

describe("ProviderMeta.wrapToolsIntoNamespace", () => {
  const bashTool = {
    type: "function",
    name: "bash",
    description: "Run a shell command",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  }
  const readTool = { type: "function", name: "read", description: "Read a file", parameters: { type: "object", properties: {} } }

  function request(input: unknown[]) {
    return JSON.stringify({
      model: "muse-wonder-full-1.0",
      stream: true,
      instructions: "You are a coding agent.",
      input,
      tools: [bashTool, readTool],
      store: false,
    })
  }

  test("wraps function tools into a single opencode namespace tool", () => {
    const body = JSON.parse(ProviderMeta.wrapToolsIntoNamespace(request([])))
    expect(body.tools).toHaveLength(1)
    expect(body.tools[0].type).toBe("namespace")
    expect(body.tools[0].name).toBe("opencode")
    expect(body.tools[0].tools).toEqual([bashTool, readTool])
    expect(body.model).toBe("muse-wonder-full-1.0")
    expect(body.store).toBe(false)
  })

  test("re-prefixes echoed function_call history names", () => {
    const input = [
      { type: "message", role: "user", content: [{ type: "input_text", text: "run echo hi" }] },
      { type: "function_call", call_id: "call_1", name: "bash", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "hi" },
      { type: "function_call", call_id: "call_2", name: "opencode.read", arguments: "{}" },
    ]
    const body = JSON.parse(ProviderMeta.wrapToolsIntoNamespace(request(input)))
    expect(body.input[1].name).toBe("opencode.bash")
    expect(body.input[2].call_id).toBe("call_1")
    expect(body.input[2].output).toBe("hi")
    expect(body.input[3].name).toBe("opencode.read")
    expect(body.input[0].content[0].text).toBe("run echo hi")
  })

  test("prefixes a forced function tool_choice", () => {
    const body = JSON.stringify({
      model: "muse-wonder-full-1.0",
      input: [],
      tools: [bashTool],
      tool_choice: { type: "function", name: "bash" },
    })
    expect(JSON.parse(ProviderMeta.wrapToolsIntoNamespace(body)).tool_choice.name).toBe("opencode.bash")
  })

  test("passes through bodies without function tools unchanged (same string)", () => {
    expect(ProviderMeta.wrapToolsIntoNamespace(JSON.stringify({ model: "x", input: [] }))).toBe(
      JSON.stringify({ model: "x", input: [] }),
    )
    expect(ProviderMeta.wrapToolsIntoNamespace("not json")).toBe("not json")
  })

  test("passes through mixed tool sets unchanged so refusals stay visible", () => {
    const body = JSON.stringify({ model: "x", input: [], tools: [bashTool, { type: "web_search" }] })
    expect(ProviderMeta.wrapToolsIntoNamespace(body)).toBe(body)
  })

  test("is idempotent on already-wrapped bodies", () => {
    const once = ProviderMeta.wrapToolsIntoNamespace(request([]))
    expect(ProviderMeta.wrapToolsIntoNamespace(once)).toBe(once)
  })
})

describe("ProviderMeta namespace response rewriting", () => {
  function runStreamTransform(stream: ReadableStream<Uint8Array>): Promise<string> {
    const fetchImpl = ProviderMeta.createResponsesFetch(async (_input, _init) =>
      new Response(stream, { headers: { "content-type": "text/event-stream" } }),
    )
    return fetchImpl("https://api.meta.ai/v1/responses", { method: "POST" }).then((res) => res.text())
  }

  function sseStream(chunks: string[]) {
    const encoder = new TextEncoder()
    return new ReadableStream({
      async pull(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    })
  }

  test("un-prefixes dotted tool-call names across the stream, arguments untouched", async () => {
    const events = [OUTPUT_ITEM_ADDED, ARGUMENTS_DELTA, ARGUMENTS_DONE, OUTPUT_ITEM_DONE, COMPLETED, SUBSCRIPTION_USAGE].join("\n\n")
    const text = await runStreamTransform(sseStream([events.slice(0, 60), events.slice(60)]))
    expect(text).not.toContain("opencode.bash")
    expect(text).toContain(`"name":"bash"`)
    // The model's command content must survive untouched (JSON-escaped inside
    // the arguments string).
    expect(text).toContain('{\\"command\\":\\"echo hi\\"}')
    expect(text).toContain("response.subscription_usage")
  })

  test("handles chunk boundaries splitting SSE lines mid-event", async () => {
    const events = [OUTPUT_ITEM_ADDED, ARGUMENTS_DONE, COMPLETED].join("\n\n")
    let text = ""
    // Feed byte-by-byte to exercise the line reassembly path.
    const chars = events.split("")
    const fetchImpl = ProviderMeta.createResponsesFetch(async () => new Response(sseStream(chars.map((c) => c)), { headers: { "content-type": "text/event-stream" } }))
    text = await (await fetchImpl("https://api.meta.ai/v1/responses", { method: "POST" })).text()
    expect(text).not.toContain("opencode.bash")
    expect(text).toContain(`"name":"bash"`)
  })

  test("leaves event markers, keep-alives and unrelated names alone", async () => {
    const keepAlive = ": keep-alive\n\n"
    const unrelated =
      `event: response.output_text.delta\n` +
      `data: {"delta":"visit opencode.ai for docs","item_id":"m_1","type":"response.output_text.delta"}\n\n`
    const text = await runStreamTransform(sseStream([keepAlive, unrelated]))
    expect(text).toContain("opencode.ai for docs")
  })

  test("rewrites non-streaming JSON responses", async () => {
    const json = JSON.stringify({
      id: "resp_1",
      output: [
        { type: "reasoning", id: "rs_1" },
        { type: "function_call", id: "fc_1", call_id: "call_1", name: "opencode.bash", arguments: "{}" },
        { type: "message", id: "m_1", content: "echo hi wrote opencode.bash docs" },
      ],
    })
    const fetchImpl = ProviderMeta.createResponsesFetch(async () => new Response(json, { headers: { "content-type": "application/json" } }))
    const res = await fetchImpl("https://api.meta.ai/v1/responses", { method: "POST" })
    const body = await res.json()
    expect(body.output[1].name).toBe("bash")
    expect(body.output[2].content).toBe("echo hi wrote opencode.bash docs")
  })

  test("non-responses URLs pass through untouched", async () => {
    const original = { data: [{ id: "muse-spark-1.3" }] }
    const fetchImpl = ProviderMeta.createResponsesFetch(async () => new Response(JSON.stringify(original)))
    const res = await fetchImpl("https://api.meta.ai/v1/models", { method: "GET" })
    expect(await res.json()).toEqual(original)
  })
})
