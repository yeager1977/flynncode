import type { RGBA } from "@opentui/core"
import { createEffect, createSignal, For, on, onCleanup, Show } from "solid-js"
import { useEvent } from "../../context/event"
import { useSDK } from "../../context/sdk"
import { useTheme } from "../../context/theme"
import { createStatusLineSource, statusLineChunks } from "../../util/status-line"

// Mounted only by the main session view, below the prompt. Its GET is what makes the server watch a session (sub-agent
// cards never ask) and renews the watch, which lapses after five idle minutes without one.
export function SessionStatusLine(props: { sessionID: string }) {
  const { theme } = useTheme()
  const sdk = useSDK()
  const event = useEvent()
  const [lines, setLines] = createSignal<string[]>([])
  const source = createStatusLineSource(setLines)
  const fetch = () => {
    const sessionID = props.sessionID
    void source.fetch(async () => (await sdk.client.session.statusline.get({ sessionID })).data?.lines)
  }

  createEffect(
    on(
      () => props.sessionID,
      () => {
        source.reset()
        fetch()
      },
    ),
  )
  onCleanup(
    event.on("session.statusline", (evt) => {
      if (evt.properties.sessionID === props.sessionID) source.push(evt.properties.lines)
    }),
  )
  // A turn starting or ending renews the watch, so a session left open and idle keeps updating when it works again.
  onCleanup(
    event.on("session.status", (evt) => {
      if (evt.properties.sessionID === props.sessionID) fetch()
    }),
  )
  // The server keeps watches in memory only: after the event stream reconnects to a restarted server, ask again.
  onCleanup(event.on("server.connected", fetch))

  return (
    <Show when={lines().length > 0}>
      <StatusLineRows lines={lines()} fg={theme.textMuted} />
    </Show>
  )
}

export function StatusLineRows(props: { lines: string[]; fg: RGBA }) {
  return (
    <box flexDirection="column" flexShrink={0}>
      <For each={props.lines}>
        {(line) => (
          <text fg={props.fg} wrapMode="none">
            <For each={statusLineChunks(line)}>
              {(chunk) => (
                <span style={{ fg: chunk.fg, bg: chunk.bg, attributes: chunk.attributes }}>{chunk.text}</span>
              )}
            </For>
          </text>
        )}
      </For>
    </box>
  )
}
