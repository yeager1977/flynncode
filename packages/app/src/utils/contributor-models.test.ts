import { describe, expect, test } from "bun:test"
import { contributorModelKey, isContributorAcked, isContributorModel, markContributorAcked } from "./contributor-models"

describe("isContributorModel", () => {
  test("matches both Meta Contributor models", () => {
    expect(isContributorModel("meta", "muse-spark-1.3-contributor")).toBe(true)
    expect(isContributorModel("meta", "muse-spark-1.2-contributor")).toBe(true)
  })

  test("rejects lookalikes", () => {
    expect(isContributorModel("meta", "muse-spark-1.3")).toBe(false)
    expect(isContributorModel("meta", "muse-spark-1.3-contributor-free")).toBe(false)
    expect(isContributorModel("opencode", "muse-spark-1.3-contributor-free")).toBe(false)
    expect(isContributorModel("anthropic", "claude-sonnet-5")).toBe(false)
  })

  test("memory ack round-trips", () => {
    const key = contributorModelKey("meta", "muse-spark-1.3-contributor")
    expect(isContributorAcked("session:abc")).toBe(false)
    markContributorAcked("session:abc")
    expect(isContributorAcked("session:abc")).toBe(true)
    expect(key).toBe("meta/muse-spark-1.3-contributor")
  })
})
