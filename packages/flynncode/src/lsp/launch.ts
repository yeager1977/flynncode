import type { ChildProcess, ChildProcessWithoutNullStreams } from "child_process"
import { Process } from "@/util/process"

type Child = Process.Child & ChildProcessWithoutNullStreams

const STOP_GRACE_MS = 2_000

export function spawn(cmd: string, args: string[], opts?: Process.Options): Child
export function spawn(cmd: string, opts?: Process.Options): Child
export function spawn(cmd: string, argsOrOpts?: string[] | Process.Options, opts?: Process.Options) {
  const args = Array.isArray(argsOrOpts) ? [...argsOrOpts] : []
  const cfg = Array.isArray(argsOrOpts) ? opts : argsOrOpts
  // Each server leads its own process group so stopping it also reaps the helpers it
  // starts (tsserver, workers) instead of orphaning them.
  const proc = Process.spawn([cmd, ...args], {
    ...cfg,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    detached: process.platform !== "win32",
  }) as Child

  if (!proc.stdin || !proc.stdout || !proc.stderr) throw new Error("Process output not available")

  return proc
}

// SIGTERM the server's whole group, give it a grace period, then SIGKILL whatever is left
// of the group (helpers can outlive a leader that exited on SIGTERM).
export async function stop(proc: ChildProcess) {
  if (process.platform === "win32" || !proc.pid) return Process.stop(proc)
  const pid = proc.pid
  signal(pid, "SIGTERM")
  await exited(proc, STOP_GRACE_MS)
  signal(pid, "SIGKILL")
}

// Synchronous so it can run from a process "exit" listener; a group that is already gone is skipped.
export function signal(pid: number, sig: NodeJS.Signals) {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, sig)
  } catch {}
}

function exited(proc: ChildProcess, ms: number) {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    proc.once("exit", () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

export * as LSPLaunch from "./launch"
