import { describe, expect } from "bun:test"
import fs from "fs/promises"
import { Effect } from "effect"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { SessionProjector } from "@flynncode/core/session/projector"
import type { SessionV1 } from "@flynncode/core/v1/session"
import { ProviderV2 } from "@flynncode/core/provider"
import { ModelV2 } from "@flynncode/core/model"
import { ClaudeTranscript } from "../../src/hooks/claude-transcript"
import { Session } from "../../src/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Session.node, MessageV2.node, SessionProjector.node])))

const addUser = Effect.fn("Test.addUser")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const id = MessageID.ascending()
  yield* session.updateMessage({
    id,
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "test",
    model: { providerID: "test", modelID: "test" },
    tools: {},
    mode: "",
  } as unknown as SessionV1.Info)
  yield* session.updatePart({ id: PartID.ascending(), sessionID, messageID: id, type: "text", text })
  return id
})

const addAssistant = Effect.fn("Test.addAssistant")(function* (
  sessionID: SessionID,
  parentID: MessageID,
  input: { text?: string; tools?: SessionV1.ToolPart["state"][]; completed?: boolean },
) {
  const session = yield* Session.Service
  const id = MessageID.ascending()
  const created = Date.now()
  yield* session.updateMessage({
    id,
    sessionID,
    role: "assistant",
    time: { created, ...(input.completed === false ? {} : { completed: created }) },
    parentID,
    modelID: ModelV2.ID.make("test"),
    providerID: ProviderV2.ID.make("test"),
    mode: "",
    agent: "default",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  } as unknown as SessionV1.Info)
  yield* session.updatePart({
    id: PartID.ascending(),
    sessionID,
    messageID: id,
    type: "reasoning",
    text: "thinking about it",
    time: { start: created },
  })
  if (input.text)
    yield* session.updatePart({ id: PartID.ascending(), sessionID, messageID: id, type: "text", text: input.text })
  yield* Effect.forEach(input.tools ?? [], (state, index) =>
    session.updatePart({
      id: PartID.ascending(),
      sessionID,
      messageID: id,
      type: "tool",
      callID: `call_${index}`,
      tool: "bash",
      state,
    } as SessionV1.ToolPart),
  )
  return id
})

const completed = {
  status: "completed",
  input: { command: "ls" },
  output: "a.txt",
  title: "ls",
  metadata: {},
  time: { start: 1, end: 2 },
} as const
const errored = { status: "error", input: { command: "false" }, error: "exit 1", time: { start: 1, end: 2 } } as const
const running = { status: "running", input: { command: "sleep" }, time: { start: 1 } } as const

const read = (file: string) =>
  Effect.promise(() => Bun.file(file).text()).pipe(
    Effect.map((text) =>
      text
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as Record<string, any>),
    ),
  )

const withSession = <A, E, R>(fn: (input: { session: Session.Interface; sessionID: SessionID }) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const session = yield* Session.Service
      const created = yield* session.create({})
      return { session, sessionID: created.id }
    }),
    fn,
    (input) => input.session.remove(input.sessionID).pipe(Effect.ignore),
  )

const hasJq = Bun.which("jq") !== null
if (!hasJq) console.warn("claude-transcript: jq not found on PATH, skipping the tail | jq -s check")

describe("ClaudeTranscript", () => {
  it.instance("writes Claude-format JSONL for text and tool messages", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const user = yield* addUser(sessionID, "list files")
        const assistant = yield* addAssistant(sessionID, user, { text: "running ls", tools: [completed, errored] })
        const file = yield* ClaudeTranscript.sync({ sessionID })
        expect(file).toBe(ClaudeTranscript.path(sessionID))
        const lines = yield* read(file)
        expect(lines.map((line) => line.uuid)).toEqual([user, assistant, `${assistant}:tool_result`])
        expect(lines[0]).toMatchObject({
          type: "user",
          message: { role: "user", content: [{ type: "text", text: "list files" }] },
          parentUuid: null,
          sessionId: sessionID,
        })
        expect(typeof lines[0]?.cwd).toBe("string")
        expect(new Date(lines[0]?.timestamp).toISOString()).toBe(lines[0]?.timestamp)
        expect(lines[1]).toMatchObject({
          type: "assistant",
          parentUuid: user,
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "running ls" },
              { type: "tool_use", id: "call_0", name: "bash", input: { command: "ls" } },
              { type: "tool_use", id: "call_1", name: "bash", input: { command: "false" } },
            ],
          },
        })
        expect(lines[2]).toMatchObject({
          type: "user",
          parentUuid: assistant,
          message: {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "call_0", content: "a.txt", is_error: false },
              { type: "tool_result", tool_use_id: "call_1", content: "exit 1", is_error: true },
            ],
          },
        })
        // Reasoning parts never reach the transcript.
        expect(JSON.stringify(lines)).not.toContain("thinking about it")
      }),
    ),
  )

  it.instance("a second sync appends only the new lines", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const user = yield* addUser(sessionID, "first")
        const file = yield* ClaudeTranscript.sync({ sessionID })
        const before = yield* Effect.promise(() => Bun.file(file).text())
        expect((yield* read(file)).length).toBe(1)

        yield* ClaudeTranscript.sync({ sessionID })
        expect(yield* Effect.promise(() => Bun.file(file).text())).toBe(before)

        const assistant = yield* addAssistant(sessionID, user, { text: "second" })
        yield* ClaudeTranscript.sync({ sessionID })
        const after = yield* Effect.promise(() => Bun.file(file).text())
        expect(after.startsWith(before)).toBe(true)
        const lines = yield* read(file)
        expect(lines.map((line) => line.uuid)).toEqual([user, assistant])
        expect(lines[1]?.parentUuid).toBe(user)
        expect(
          (yield* Effect.promise(() => Bun.file(ClaudeTranscript.path(sessionID).replace(/\.jsonl$/, ".cursor")).text())),
        ).toBe(assistant)
      }),
    ),
  )

  it.instance("skips a still-running last assistant message until it completes", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const user = yield* addUser(sessionID, "go")
        const assistant = yield* addAssistant(sessionID, user, { text: "working", tools: [running], completed: false })
        const file = yield* ClaudeTranscript.sync({ sessionID })
        expect((yield* read(file)).map((line) => line.uuid)).toEqual([user])

        const session = yield* Session.Service
        const stored = yield* session.messages({ sessionID })
        const message = stored.find((item) => item.info.id === assistant)!
        yield* session.updateMessage({
          ...message.info,
          time: { created: message.info.time.created, completed: Date.now() },
        } as SessionV1.Info)
        yield* Effect.forEach(
          message.parts.filter((part) => part.type === "tool"),
          (part) => session.updatePart({ ...part, state: completed } as SessionV1.ToolPart),
        )
        yield* ClaudeTranscript.sync({ sessionID })
        expect((yield* read(file)).map((line) => line.uuid)).toEqual([user, assistant, `${assistant}:tool_result`])
      }),
    ),
  )

  it.instance("tail -n 4 | jq -s . parses through a real shell", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        if (!hasJq) return
        const user = yield* addUser(sessionID, "q")
        yield* addAssistant(sessionID, user, { text: "a", tools: [completed] })
        const file = yield* ClaudeTranscript.sync({ sessionID })
        const out = yield* Effect.promise(async () => {
          const proc = Bun.spawn(["sh", "-c", 'tail -n 4 "$TRANSCRIPT" | jq -s .'], {
            env: { ...process.env, TRANSCRIPT: file },
            stdout: "pipe",
            stderr: "pipe",
          })
          const text = await new Response(proc.stdout).text()
          return { code: await proc.exited, text }
        })
        expect(out.code).toBe(0)
        const parsed = JSON.parse(out.text) as Array<{ type: string }>
        expect(parsed.map((line) => line.type)).toEqual(["user", "assistant", "user"])
      }),
    ),
  )

  it.instance("deleting the session removes the transcript and cursor", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const created = yield* session.create({})
      yield* addUser(created.id, "bye")
      const file = yield* ClaudeTranscript.sync({ sessionID: created.id })
      const cursor = file.replace(/\.jsonl$/, ".cursor")
      expect(yield* Effect.promise(() => Bun.file(file).exists())).toBe(true)
      expect(yield* Effect.promise(() => Bun.file(cursor).exists())).toBe(true)
      yield* session.remove(created.id)
      expect(yield* Effect.promise(() => Bun.file(file).exists())).toBe(false)
      expect(yield* Effect.promise(() => Bun.file(cursor).exists())).toBe(false)
    }),
  )

  it.instance("returns an empty path without throwing when the file cannot be written", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        yield* addUser(sessionID, "x")
        const file = ClaudeTranscript.path(sessionID)
        // A directory where the file belongs makes every write fail.
        yield* Effect.promise(() => fs.mkdir(file, { recursive: true }))
        expect(yield* ClaudeTranscript.sync({ sessionID })).toBe("")
        yield* Effect.promise(() => fs.rm(file, { recursive: true, force: true }))
      }),
    ),
  )

  it.instance("keeps the last good path when a later write fails", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const user = yield* addUser(sessionID, "x")
        const file = yield* ClaudeTranscript.sync({ sessionID })
        expect(file).not.toBe("")
        yield* addAssistant(sessionID, user, { text: "y" })
        yield* Effect.promise(() => fs.chmod(file, 0o444))
        const again = yield* ClaudeTranscript.sync({ sessionID })
        yield* Effect.promise(() => fs.chmod(file, 0o644))
        // Root ignores file modes; the append then succeeds, which is also fine.
        expect(again).toBe(file)
      }),
    ),
  )

  it.instance("rebuilds the file when the cursor message no longer exists", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const first = yield* addUser(sessionID, "one")
        const file = yield* ClaudeTranscript.sync({ sessionID })
        const second = yield* addUser(sessionID, "two")
        yield* ClaudeTranscript.sync({ sessionID })
        yield* session.removeMessage({ sessionID, messageID: second })
        yield* ClaudeTranscript.sync({ sessionID })
        expect((yield* read(file)).map((line) => line.uuid)).toEqual([first])
      }),
    ),
  )
})
