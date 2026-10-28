import type { RGBA } from "@opentui/core"
import { For } from "solid-js"
import { statusLineChunks } from "../../util/status-line"

export function StatusLineRows(props: { lines: string[]; fg: RGBA }) {
  return (
    <box flexDirection="column" flexShrink={0}>
      <For each={props.lines}>
        {(line) => (
          <text fg={props.fg} wrapMode="none">
            <For each={statusLineChunks(line)}>
              {(chunk) => <span style={{ fg: chunk.fg, attributes: chunk.attributes }}>{chunk.text}</span>}
            </For>
          </text>
        )}
      </For>
    </box>
  )
}
