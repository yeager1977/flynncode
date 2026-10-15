import { describe, expect, test } from "bun:test"
import { channelDatabaseName } from "@flynncode/core/database/database"

describe("channelDatabaseName", () => {
  test("names the database after the channel", () => {
    expect(channelDatabaseName("dev")).toBe("opencode-dev.db")
    expect(channelDatabaseName("local")).toBe("opencode-local.db")
  })

  test("an empty channel falls back to the dev database", () => {
    expect(channelDatabaseName("")).toBe("opencode-dev.db")
  })

  test("sanitizes branch-like channels", () => {
    expect(channelDatabaseName("feat/x y")).toBe("opencode-feat-x-y.db")
  })
})
