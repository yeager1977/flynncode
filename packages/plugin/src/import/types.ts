export type ImportedMessage =
  | { readonly role: "user"; readonly text: string; readonly time: number }
  | { readonly role: "assistant"; readonly text: string; readonly time: number }

export type ParsedSession = {
  readonly sourceSessionID: string
  readonly sourcePath: string
  readonly cwd: string
  readonly title: string
  readonly messages: ReadonlyArray<ImportedMessage>
}

export type ImportSource = "claude-code" | "codex"