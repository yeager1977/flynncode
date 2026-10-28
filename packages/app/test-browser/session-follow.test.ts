import { describe, expect, test } from "bun:test"
import { sessionFollowHref } from "@/pages/session/session-follow"

const href = ({ directory, id }: { directory: string; id: string }) => `/${directory}/session/${id}`

describe("sessionFollowHref", () => {
  test("follows the routed session when its directory changes under the open route", () => {
    expect(
      sessionFollowHref({ routeDirectory: "/repo", sessionID: "ses_1", from: "/repo", to: "/repo/.wt/a", href }),
    ).toBe("//repo/.wt/a/session/ses_1")
  })

  test("follows back out of the worktree", () => {
    expect(
      sessionFollowHref({ routeDirectory: "/repo/.wt/a", sessionID: "ses_1", from: "/repo/.wt/a", to: "/repo", href }),
    ).toBe("//repo/session/ses_1")
  })

  test("stays put when the directory did not change", () => {
    expect(
      sessionFollowHref({ routeDirectory: "/repo", sessionID: "ses_1", from: "/repo", to: "/repo/", href }),
    ).toBeUndefined()
  })

  test("stays put when the view is not on the folder the session left", () => {
    expect(
      sessionFollowHref({ routeDirectory: "/other", sessionID: "ses_1", from: "/repo", to: "/repo/.wt/a", href }),
    ).toBeUndefined()
  })

  test("needs a known previous and next directory and a routed session", () => {
    expect(
      sessionFollowHref({ routeDirectory: "/repo", sessionID: "ses_1", from: undefined, to: "/wt", href }),
    ).toBeUndefined()
    expect(
      sessionFollowHref({ routeDirectory: "/repo", sessionID: "ses_1", from: "/repo", to: undefined, href }),
    ).toBeUndefined()
    expect(
      sessionFollowHref({ routeDirectory: "/repo", sessionID: undefined, from: "/repo", to: "/wt", href }),
    ).toBeUndefined()
  })
})
