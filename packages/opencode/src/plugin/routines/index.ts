import path from "path"
import { Global } from "@opencode-ai/core/global"
import { applyEdits, modify, parse } from "jsonc-parser"
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { dueRoutines } from "./due"
import { parseRoutines, type Routine } from "./parse"

// Mirrors globalConfigFile() precedence so we patch the file OpenCode loads.
const CONFIG_CANDIDATES = ["opencode.jsonc", "opencode.json", "config.json"]
const FILE = path.join(Global.Path.config, "routines.jsonc")
const PREFIX = "[routines]"

type Client = PluginInput["client"]

function stored(routine: Routine) {
  return {
    id: routine.id,
    name: routine.name,
    prompt: routine.prompt,
    enabled: routine.enabled,
    lastRun: routine.lastRun,
    schedule: routine.dailyAt ? { dailyAt: routine.dailyAt } : undefined,
  }
}

function configFile() {
  for (const name of CONFIG_CANDIDATES) {
    const candidate = path.join(Global.Path.config, name)
    if (Bun.file(candidate).size > 0) return candidate
  }
  return path.join(Global.Path.config, CONFIG_CANDIDATES[0] ?? "opencode.jsonc")
}

async function readConfigRoutines() {
  const file = Bun.file(configFile())
  if (!(await file.exists())) return
  const data = parse(await file.text()) as { routines?: unknown }
  if (!data || data.routines === undefined) return
  const parsed = parseRoutines(data.routines)
  if (!parsed.ok) {
    console.warn(`${PREFIX} invalid config:\n- ${parsed.errors.join("\n- ")}`)
    return []
  }
  return parsed.value.routines
}

async function readFileRoutines() {
  const file = Bun.file(FILE)
  if (!(await file.exists())) return []
  const parsed = parseRoutines(parse(await file.text()))
  if (!parsed.ok) {
    console.warn(`${PREFIX} invalid file:\n- ${parsed.errors.join("\n- ")}`)
    return []
  }
  return parsed.value.routines
}

export async function loadRoutines() {
  const fromConfig = await readConfigRoutines()
  if (fromConfig) return { source: "config" as const, routines: fromConfig }
  return { source: "file" as const, routines: await readFileRoutines() }
}

export async function markRan(loaded: { source: "config" | "file"; routines: Routine[] }, ids: string[], now: Date) {
  const next = loaded.routines.map((routine) =>
    ids.includes(routine.id) ? { ...routine, lastRun: now.toISOString() } : routine,
  )
  const storedRoutines = next.map(stored)
  if (loaded.source === "file") {
    await Bun.write(FILE, JSON.stringify({ routines: storedRoutines }, null, 2))
    return next
  }
  const text = await Bun.file(configFile()).text()
  const edits = modify(text, ["routines"], { routines: storedRoutines }, { formattingOptions: { insertSpaces: true, tabSize: 2 } })
  await Bun.write(configFile(), applyEdits(text, edits))
  return next
}

async function runOne(client: Client, directory: string, routine: Routine) {
  const created = await client.session.create({
    body: { title: routine.name },
    query: { directory },
  })
  const session = created.data
  if (!session?.id) return
  await client.session.promptAsync({
    path: { id: session.id },
    query: { directory },
    body: {
      agent: "build",
      parts: [{ type: "text", text: routine.prompt }],
    },
  })
}

export function startScheduler(client: Client, directory: string) {
  const timer = setInterval(() => {
    void tick()
  }, 30_000)
  const tick = async () => {
    const loaded = await loadRoutines()
    const due = dueRoutines(loaded.routines, new Date())
    if (due.length === 0) return
    await Promise.all(due.map((routine) => runOne(client, directory, routine)))
    await markRan(loaded, due.map((routine) => routine.id), new Date())
  }
  return () => clearInterval(timer)
}

export const RoutinesPlugin = async (input: PluginInput): Promise<Hooks> => {
  startScheduler(input.client, input.directory)
  return {}
}

export default {
  id: "routines",
  server: RoutinesPlugin,
}
