import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { bind, makeDispatch, renderOutput } from "@opencode-ai/core/tool/task"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"

const parent = SessionV2.ID.make("ses_parent")
const child = SessionV2.ID.make("ses_child")
const location = { directory: "/project" } as SessionV2.Info["location"]

const dispatch = () => {
  const prompts: { sessionID: string; text: string }[] = []
  let resumed = ""
  const sessions = {
    get: (id: string) =>
      Effect.succeed({
        id,
        location,
        parentID: id === parent ? undefined : parent,
        model: undefined,
      }),
    create: () => Effect.succeed({ id: child, location, parentID: parent }),
    prompt: (item: { sessionID: string; prompt: { text: string } }) => {
      prompts.push({ sessionID: item.sessionID, text: item.prompt.text })
      return Effect.succeed({ sessionID: item.sessionID })
    },
    resume: (id: string) => {
      resumed = id
      return Effect.void
    },
    messages: () =>
      Effect.succeed([
        {
          type: "assistant" as const,
          content: [{ type: "text" as const, text: "child answer" }],
        },
      ]),
  }
  return {
    prompts,
    resumed: () => resumed,
    run: makeDispatch({
      sessions: sessions as unknown as SessionV2.Interface,
      locations: {
        get: () =>
          Layer.succeed(AgentV2.Service, {
            get: () => Effect.succeed({ id: AgentV2.ID.make("explore") }),
          } as unknown as AgentV2.Interface),
      },
      jobs: { start: () => Effect.die("background unused") } as never,
    }),
  }
}

const context = {
  sessionID: parent,
  agent: AgentV2.ID.make("build"),
  assistantMessageID: SessionMessage.ID.make("msg_parent"),
  toolCallID: "call_1",
}

describe("TaskTool dispatch", () => {
  test("creates a child, waits, and returns its text", async () => {
    const harness = dispatch()
    const output = await Effect.runPromise(
      harness.run({ description: "Look around", prompt: "find the bug", subagent_type: "explore" }, context),
    )
    expect(harness.resumed()).toBe(child)
    expect(harness.prompts[0]?.text).toBe("find the bug")
    expect(output).toBe(renderOutput({ sessionID: child, state: "completed", summary: "Look around", text: "child answer" }))
  })

  test("rejects a task sent to the current session", async () => {
    const harness = dispatch()
    const exit = await Effect.runPromiseExit(
      harness.run(
        { description: "Look around", prompt: "find the bug", subagent_type: "explore", task_id: parent },
        context,
      ),
    )
    expect(exit._tag).toBe("Failure")
  })

  test("an unbind does not clobber another active binding", async () => {
    const first = dispatch()
    const second = dispatch()
    const unbindFirst = bind(first.run)
    const unbindSecond = bind(second.run)

    unbindFirst()
    unbindSecond()
    // Both binders were released; rebinding one still works after the stack drained.
    const unbindThird = bind(first.run)
    const output = await Effect.runPromise(
      first.run({ description: "Look around", prompt: "find the bug", subagent_type: "explore" }, context),
    )
    unbindThird()
    expect(output).toBe(
      renderOutput({ sessionID: child, state: "completed", summary: "Look around", text: "child answer" }),
    )
  })
})
