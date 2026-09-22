import { homedir } from "os"
import path from "path"
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { dueRoutines } from "./due"
import { parseRoutines, type Routine } from "./parse"

const FILE = path.join(homedir(), ".config", "opencode", "routines.jsonc")
const PREFIX = "[routines]"

type Client = PluginInput["client"]

export async function loadRoutines() {
  const file = Bun.file(FILE)
  if (!(await file.exists())) return []
  const parsed = parseRoutines(await file.json())
  if (!parsed.ok) {
    console.warn(`${PREFIX} invalid file:\n- ${parsed.errors.join("\n- ")}`)
    return []
  }
  return parsed.value.routines
}

export async function markRan(routines: Routine[], ids: string[], now: Date) {
  const next = routines.map((routine) =>
    ids.includes(routine.id) ? { ...routine, lastRun: now.toISOString() } : routine,
  )
  await Bun.write(FILE, JSON.stringify({ routines: next }, null, 2))
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
  let timer: ReturnType<typeof setInterval> | undefined
  const tick = async () => {
    const routines = await loadRoutines()
    const due = dueRoutines(routines, new Date())
    if (due.length === 0) return
    await Promise.all(due.map((routine) => runOne(client, directory, routine)))
    await markRan(routines, due.map((routine) => routine.id), new Date())
  }
  const arm = async () => {
    const routines = await loadRoutines()
    if (!routines.some((routine) => routine.enabled && routine.dailyAt)) return
    timer = setInterval(() => {
      void tick()
    }, 30_000)
  }
  void arm()
  return () => {
    if (!timer) return
    clearInterval(timer)
  }
}

export const RoutinesPlugin = async (input: PluginInput): Promise<Hooks> => {
  startScheduler(input.client, input.directory)
  return {}
}

export default {
  id: "routines",
  server: RoutinesPlugin,
}
