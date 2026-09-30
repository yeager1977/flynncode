import { expect, test } from "bun:test"
import type { Session, Todo } from "@opencode-ai/sdk/v2/client"
import { OpencodeClient } from "@opencode-ai/sdk/v2/client"
import { createServerSession } from "./server-session"

const todo = (content: string): Todo => ({ content, status: "pending", priority: "low" })
const session = (id: string): Session => ({
  id,
  slug: id,
  projectID: "project",
  directory: "/repo",
  title: id,
  version: "1",
  time: { created: 1, updated: 1 },
})

test("todo updates preserve independent session lists when one list shrinks", () => {
  const server = createServerSession(new OpencodeClient())
  server.remember(session("ses_a"))
  server.remember(session("ses_b"))
  server.apply({
    type: "todo.updated",
    properties: { sessionID: "ses_a", todos: [todo("a1"), todo("a2")] },
  })
  server.apply({
    type: "todo.updated",
    properties: { sessionID: "ses_b", todos: [todo("b1"), todo("b2")] },
  })

  server.apply({
    type: "todo.updated",
    properties: { sessionID: "ses_a", todos: [todo("a3")] },
  })

  expect(server.data.todo.ses_a).toEqual([todo("a3")])
  expect(server.data.todo.ses_a).toHaveLength(1)
  expect(server.data.todo.ses_b).toEqual([todo("b1"), todo("b2")])
})
