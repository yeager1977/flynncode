import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"
import path from "node:path"

const directory = "C:/OpenCode/OmoBackground"
const projectID = "proj_omo_background"
const sessionID = "ses_omo_background"
const sessionTitle = "OMO background wake regression"

// OMO sendParentWakePrompt appends this marker as the trailing line of a
// normal /session/:id/message prompt. The app normalization must classify the
// wake as synthetic and render it as managed background activity.
const WAKE_TEXT = "wake task-agent-reliability\n<!-- OMO_INTERNAL_INITIATOR -->"
// A user quoting the marker mid-prose is genuine content and must stay a user message.
const QUOTE_TEXT = "note the marker <!-- OMO_INTERNAL_INITIATOR --> appears mid-prose here"

const wakeMessageID = "msg_omo_wake"
const quoteMessageID = "msg_omo_quote"

test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" })

test.beforeEach(async ({ page }) => {
  await mockOpenCodeServer(page, {
    protocol: "v2",
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "omo-background",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: { test: { id: "test", name: "Test", limit: { context: 200_000 } } },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "test" },
    },
    sessions: [
      {
        id: sessionID,
        slug: "omo-background",
        projectID,
        directory,
        title: sessionTitle,
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    pageMessages: () => ({
      items: [
        {
          info: { id: wakeMessageID, sessionID, role: "user", time: { created: 1700000000000 } },
          parts: [
            { id: "prt_omo_wake", sessionID, messageID: wakeMessageID, type: "text", text: WAKE_TEXT },
          ],
        },
        {
          info: { id: quoteMessageID, sessionID, role: "user", time: { created: 1700000001000 } },
          parts: [
            { id: "prt_omo_quote", sessionID, messageID: quoteMessageID, type: "text", text: QUOTE_TEXT },
          ],
        },
      ],
    }),
  })
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
  })
})

test("renders an OMO wake prompt as managed background activity and keeps quoted markers genuine", async ({
  page,
}) => {
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectSessionTitle(page, sessionTitle)

  // The wake turn renders as a background divider with the localized label.
  const divider = page.locator('[data-timeline-row="TurnDivider"]')
  await expect(divider).toHaveCount(1)
  await expect(divider.getByText("Response ready", { exact: true })).toBeVisible()

  // The wake prompt text is not rendered as a user bubble.
  await expect(page.getByText("wake task-agent-reliability")).toHaveCount(0)
  await expect(page.locator('[data-timeline-row="UserMessage"]')).toHaveCount(1)

  // A genuine message quoting the marker mid-prose stays an ordinary user message.
  const userRow = page.locator('[data-timeline-row="UserMessage"]')
  await expect(userRow.getByText(QUOTE_TEXT, { exact: false })).toBeVisible()

  await page.screenshot({
    path: path.resolve(
      "/home/yeager1977/GitHub/flynncode/.omo/evidence/task-agent-reliability/ui/omo-background-divider.png",
    ),
  })
})
