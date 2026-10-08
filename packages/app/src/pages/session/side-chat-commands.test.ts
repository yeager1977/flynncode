import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

// Source-level contract tests for the /btw side chat and view-mode commands.
// DOM rendering is not available under --conditions=solid, so behavioral
// contracts are pinned at the source level (same approach as
// session-todo-dock.test.tsx and ci-status.test.ts).

const commandsSource = readFileSync(new URL("./use-session-commands.tsx", import.meta.url), "utf8")
const storeSource = readFileSync(new URL("./composer/session-side-chat-store.ts", import.meta.url), "utf8")
const controllerSource = readFileSync(new URL("./composer/session-side-chat-controller.ts", import.meta.url), "utf8")
const contextSource = readFileSync(new URL("./composer/session-side-chat-context.tsx", import.meta.url), "utf8")
const dockStateSource = readFileSync(new URL("./composer/session-side-chat-dock-state.ts", import.meta.url), "utf8")
const dockSource = readFileSync(new URL("./composer/session-side-chat-dock.tsx", import.meta.url), "utf8")
const regionSource = readFileSync(new URL("./composer/session-composer-region.tsx", import.meta.url), "utf8")
const layoutSource = readFileSync(new URL("../../context/layout.tsx", import.meta.url), "utf8")

describe("session side chat commands", () => {
  test("/btw opens the dock through a session-scoped command", () => {
    expect(commandsSource).toContain('id: "session.sidechat"')
    expect(commandsSource).toContain('slash: "btw"')
    expect(commandsSource).toContain('keybind: "mod+;"')
    expect(commandsSource).toContain("sideChat.open()")
  })

  test("mod+shift+m cycles transcript view modes through the layout store", () => {
    expect(commandsSource).toContain('id: "session.viewMode.cycle"')
    expect(commandsSource).toContain('keybind: "mod+shift+m"')
    expect(commandsSource).toContain("view().cycleViewMode()")
  })

  test("the mcp toggle no longer claims mod+; globally inside the session", () => {
    const mcpCommand = commandsSource.match(/mcpCommand\(\{[\s\S]*?\}\)/)?.[0] ?? ""
    expect(mcpCommand).not.toContain("keybind:")
    expect(mcpCommand).toContain('slash: "mcp"')
  })
})

describe("side chat non-persistence", () => {
  test("the store keeps records only in module memory", () => {
    expect(storeSource).not.toContain("persisted(")
    expect(storeSource).not.toContain("localStorage.")
    expect(storeSource).toContain("createStore")
    expect(storeSource).toContain("close(sessionKey")
  })

  test("closing removes the record and removes the transient forked session", () => {
    expect(controllerSource).toContain("sideChatStore.close(key)")
    expect(controllerSource).toContain(".fork({ sessionID: id })")
    expect(controllerSource).toContain("api.session.remove")
    expect(controllerSource).not.toContain("session.prompt(")
  })

  test("side chat turns reach a one-shot generate transport, not the durable prompt", () => {
    expect(controllerSource).toContain("api.session.generate")
    expect(controllerSource).not.toContain("api.session.prompt")
    expect(controllerSource).not.toContain("promptAsync")
  })

  test("open() is idempotent per session and the dock state reads isOpen", () => {
    expect(controllerSource).toContain("isOpen()")
    expect(dockStateSource).toContain("sideChat.isOpen()")
  })

  test("dock copy is i18n-prop driven, never hardcoded English", () => {
    expect(dockSource).not.toMatch(/>Side chat<|>Close<|>Send</)
    expect(regionSource).toContain('language.t("session.sidechat.label")')
    expect(dockSource).toContain("props.closeLabel")
    // Visually distinct: the dock carries an accent border, unlike other docks.
    expect(dockSource).toContain("border-v2-border-border-focus")
  })

  test("provider scopes the controller per session page and the region mounts the dock", () => {
    expect(contextSource).toContain("createSideChatController")
    expect(regionSource).toContain("SessionSideChatDock")
    expect(dockSource).toContain('data-component="session-side-chat-dock"')
  })
})

describe("view mode persistence", () => {
  test("layout SessionView persists viewMode per session", () => {
    expect(layoutSource).toContain('viewMode?: SessionTimelineViewMode')
    expect(layoutSource).toContain("setStore(\"sessionView\", session, \"viewMode\", mode)")
    expect(layoutSource).toContain("function cycleViewMode()")
  })
})