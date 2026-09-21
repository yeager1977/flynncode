import { describe, expect, test } from "bun:test"
import { hasOmoPlugin, setOmoPlugin } from "./omo-plugin"

describe("setOmoPlugin", () => {
  test("adds oh-my-openagent without dropping others", () => {
    expect(setOmoPlugin(["opencode-wakatime"], true)).toEqual(["opencode-wakatime", "oh-my-openagent"])
  })

  test("removes both current and legacy names", () => {
    expect(setOmoPlugin(["oh-my-opencode", "foo", ["oh-my-openagent", { x: 1 }]], false)).toEqual(["foo"])
  })

  test("does not duplicate when already present", () => {
    expect(setOmoPlugin(["oh-my-openagent", "foo"], true)).toEqual(["oh-my-openagent", "foo"])
  })

  test("treats missing plugin as empty", () => {
    expect(setOmoPlugin(undefined, true)).toEqual(["oh-my-openagent"])
    expect(hasOmoPlugin(undefined)).toBe(false)
  })
})
