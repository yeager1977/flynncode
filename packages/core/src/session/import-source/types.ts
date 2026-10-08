export type ImportedMessage =
  | { readonly role: "user"; readonly text: string; readonly time: number }
  | { readonly role: "assistant"; readonly text: string; readonly time: number }

export type ParsedSession = {
  readonly sourceSessionID: string
  readonly sourcePath: string
  readonly cwd: string
  readonly title: string
  /** Empty when the reader ran with `keepMessages: false`; use messageCount. */
  readonly messages: ReadonlyArray<ImportedMessage>
  readonly messageCount: number
  /** Time of the first message, or 0 when there is none. */
  readonly time: number
}

/** Line-at-a-time transcript parser. */
export type SessionReader = {
  readonly push: (line: string) => void
  readonly finish: () => ParsedSession
  /** The session's working directory once a record has revealed it. */
  readonly cwd: () => string | undefined
}

export type ImportSource = "claude-code" | "codex"
