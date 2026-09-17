/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { readdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Show, createEffect, createSignal } from "solid-js"
import { parseClaudeCode } from "./claude-code.js"
import { parseCodex } from "./codex.js"
import { discover, type SourceCandidate } from "./discover.js"
import { buildOptions, toggleSelection } from "./selection.js"
import type { ImportSource, ParsedSession } from "./types.js"

const sourceLabel = (source: ImportSource) => (source === "claude-code" ? "Claude Code" : "Codex")

const hasErrorCode = (error: unknown, code: string) =>
  typeof error === "object" && error !== null && "code" in error && error.code === code

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

async function listDir(dir: string) {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.map((entry) => path.join(dir, entry.name))
  } catch (error) {
    if (hasErrorCode(error, "ENOTDIR")) return []
    if (hasErrorCode(error, "ENOENT")) return []
    throw error
  }
}

async function readFile(file: string) {
  const handle = Bun.file(file)
  if (!(await handle.exists())) return undefined
  return handle.text()
}

type ProjectEntry = { readonly id: string; readonly directory: string }

function ImportFlow(props: { api: TuiPluginApi }) {
  const [source, setSource] = createSignal<ImportSource>()
  const [target, setTarget] = createSignal<string>()
  const [candidates, setCandidates] = createSignal<ReadonlyArray<SourceCandidate>>([])
  const [imported, setImported] = createSignal<ReadonlySet<string>>(new Set())
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set())
  const [status, setStatus] = createSignal("")

  const options = () => buildOptions(candidates(), imported())

  createEffect(() => {
    const current = source()
    const directory = target()
    if (!current || !directory) return
    setStatus("Scanning…")
    void Promise.all([
      discover({ source: current, home: os.homedir(), read: readFile, list: listDir }),
      props.api.client.v2.import.imported({ source: current, directory }, { throwOnError: true }).catch(() => undefined),
    ]).then(([found, response]) => {
      setImported(new Set(response?.data?.data?.map((item) => item.sourceSessionID) ?? []))
      setCandidates(found)
      setSelected(new Set<string>())
      setStatus(`${found.length} sessions found`)
    }).catch((error) => {
      setStatus(`Scan failed: ${errorMessage(error)}`)
    })
  })

  const run = async () => {
    const directory = target()
    const current = source()
    if (!directory || !current) return
    let ok = 0
    let failed = 0
    for (const item of candidates().filter((entry) => selected().has(entry.sourceSessionID))) {
      const text = await readFile(item.path)
      if (text === undefined) {
        failed += 1
        continue
      }
      const parsed: ParsedSession =
        item.source === "claude-code" ? parseClaudeCode({ path: item.path, text }) : parseCodex({ path: item.path, text })
      try {
        await props.api.client.v2.import.session(
          {
            source: item.source,
            sourceSessionID: item.sourceSessionID,
            sourcePath: item.path,
            title: item.title,
            location: { directory },
            transcript: [...parsed.messages],
          },
          { throwOnError: true },
        )
        ok += 1
      } catch {
        failed += 1
      }
    }
    props.api.ui.toast({ variant: failed ? "error" : "info", message: `Imported ${ok}, failed ${failed}` })
    props.api.ui.dialog.clear()
  }

  const RUN_SENTINEL = "__import__run"

  return (
    <Show when={target()} fallback={<TargetPicker api={props.api} onPick={setTarget} />}>
      <Show when={source()} fallback={<SourcePicker api={props.api} onPick={setSource} />}>
        <props.api.ui.DialogSelect<string>
          title={`Import from ${sourceLabel(source()!)}`}
          placeholder="Enter to toggle, select Import selected to run"
          options={[
            {
              title: `Import ${selected().size} selected`,
              value: RUN_SENTINEL,
            },
            ...options().map((option) => ({
              title: `${selected().has(option.value.sourceSessionID) ? "[x] " : "[ ] "}${option.title}`,
              description: option.description,
              value: option.value.sourceSessionID,
              disabled: option.disabled,
            })),
          ]}
          onSelect={(option) => {
            if (option.value === RUN_SENTINEL) {
              void run()
              return
            }
            setSelected(toggleSelection(selected(), option.value))
          }}
        />
        <text>{status()}</text>
      </Show>
    </Show>
  )
}

function SourcePicker(props: { api: TuiPluginApi; onPick: (source: ImportSource) => void }) {
  return (
    <props.api.ui.DialogSelect<ImportSource>
      title="Import source"
      options={[
        { title: "Claude Code", value: "claude-code" },
        { title: "Codex", value: "codex" },
      ]}
      onSelect={(option) => props.onPick(option.value)}
    />
  )
}

function TargetPicker(props: { api: TuiPluginApi; onPick: (directory: string) => void }) {
  const [projects, setProjects] = createSignal<ReadonlyArray<ProjectEntry>>([])

  createEffect(() => {
    props.api.client.project
      .list()
      .then((response) => {
        setProjects(
          (response.data ?? []).flatMap((project) => {
            const directory = project.worktree
            if (!directory) return []
            return [{ id: project.id, directory }]
          }),
        )
      })
      .catch(() => setProjects([]))
  })

  const current = process.cwd()

  return (
    <props.api.ui.DialogSelect<string>
      title="Target project directory"
      options={[
        { title: `${current} (current)`, value: current },
        ...projects()
          .filter((project) => project.directory !== current)
          .map((project) => ({ title: project.directory, value: project.directory })),
      ]}
      onSelect={(option) => props.onPick(option.value)}
    />
  )
}

const tui: TuiPlugin = async (api) => {
  api.route.register([
    {
      name: "session-import",
      render: () => <ImportFlow api={api} />,
    },
  ])
  api.keymap.registerLayer({
    commands: [
      {
        name: "session-import.open",
        title: "Import sessions",
        category: "Session",
        run() {
          api.route.navigate("session-import")
        },
      },
    ],
    bindings: [{ key: "ctrl+shift+i", cmd: "session-import.open", desc: "Import sessions" }],
  })
}

export const ImportTuiPlugin: TuiPluginModule = {
  id: "opencode-session-import",
  tui,
}

export default ImportTuiPlugin