import { createMemo, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { useTheme } from "../../context/theme"
import { useSync } from "../../context/sync"
import { useDirectory } from "../../context/directory"
import { useConnected } from "../../component/use-connected"
import { createStore } from "solid-js/store"
import { useRoute } from "../../context/route"
import { StatusLineRows } from "./status-line"

// Shown while the configured status line command has output for the open session.
export function SessionStatusLine() {
  const { theme } = useTheme()
  const sync = useSync()
  const route = useRoute()
  const lines = createMemo(() => statusLines(sync, route))
  return (
    <Show when={lines().length > 0}>
      <StatusLineRows lines={lines()} fg={theme.textMuted} />
    </Show>
  )
}

function statusLines(sync: ReturnType<typeof useSync>, route: ReturnType<typeof useRoute>) {
  if (route.data.type !== "session") return []
  return sync.data.statusline[route.data.sessionID] ?? []
}

export function Footer() {
  const { theme } = useTheme()
  const sync = useSync()
  const route = useRoute()
  const mcp = createMemo(() => Object.values(sync.data.mcp).filter((x) => x.status === "connected").length)
  const mcpError = createMemo(() => Object.values(sync.data.mcp).some((x) => x.status === "failed"))
  const lsp = createMemo(() => Object.keys(sync.data.lsp))
  const permissions = createMemo(() => {
    if (route.data.type !== "session") return []
    return sync.data.permission[route.data.sessionID] ?? []
  })
  const directory = useDirectory()
  const connected = useConnected()
  const statusline = createMemo(() => statusLines(sync, route))

  const [store, setStore] = createStore({
    welcome: false,
  })

  onMount(() => {
    // Track all timeouts to ensure proper cleanup
    const timeouts: ReturnType<typeof setTimeout>[] = []

    function tick() {
      if (connected()) return
      if (!store.welcome) {
        setStore("welcome", true)
        timeouts.push(setTimeout(() => tick(), 5000))
        return
      }

      if (store.welcome) {
        setStore("welcome", false)
        timeouts.push(setTimeout(() => tick(), 10_000))
        return
      }
    }
    timeouts.push(setTimeout(() => tick(), 10_000))

    onCleanup(() => {
      timeouts.forEach(clearTimeout)
    })
  })

  return (
    <Show when={statusline().length === 0} fallback={<StatusLineRows lines={statusline()} fg={theme.textMuted} />}>
      <box flexDirection="row" justifyContent="space-between" gap={1} flexShrink={0}>
        <text fg={theme.textMuted}>{directory()}</text>
        <box gap={2} flexDirection="row" flexShrink={0}>
          <Switch>
            <Match when={store.welcome}>
              <text fg={theme.text}>
                Get started <span style={{ fg: theme.textMuted }}>/connect</span>
              </text>
            </Match>
            <Match when={connected()}>
              <Show when={permissions().length > 0}>
                <text fg={theme.warning}>
                  <span style={{ fg: theme.warning }}>△</span> {permissions().length} Permission
                  {permissions().length > 1 ? "s" : ""}
                </text>
              </Show>
              <text fg={theme.text}>
                <span style={{ fg: lsp().length > 0 ? theme.success : theme.textMuted }}>•</span> {lsp().length} LSP
              </text>
              <Show when={mcp()}>
                <text fg={theme.text}>
                  <Switch>
                    <Match when={mcpError()}>
                      <span style={{ fg: theme.error }}>⊙ </span>
                    </Match>
                    <Match when={true}>
                      <span style={{ fg: theme.success }}>⊙ </span>
                    </Match>
                  </Switch>
                  {mcp()} MCP
                </text>
              </Show>
              <text fg={theme.textMuted}>/status</text>
            </Match>
          </Switch>
        </box>
      </box>
    </Show>
  )
}
