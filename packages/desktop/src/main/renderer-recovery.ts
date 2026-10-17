// Decides how a window recovers from a dead renderer process. A first death
// reloads the webContents in place — like a browser recovering a crashed tab —
// while a death soon after a reload falls back to the manual recovery dialog
// so a renderer that cannot stay up cannot loop silent reloads forever.
export function rendererDeathAction(
  death: { reason: string; lastReloadAt: number; now: number },
  cooldownMs = 30_000,
): "reload" | "dialog" {
  if (death.reason !== "killed" && death.reason !== "crashed" && death.reason !== "oom") return "dialog"
  if (death.now - death.lastReloadAt < cooldownMs) return "dialog"
  return "reload"
}