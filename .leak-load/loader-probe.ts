import { PluginLoader } from "@/plugin/loader"
import type * as ConfigPluginNS from "@/config/plugin"

const origin: ConfigPluginNS.Origin = { spec: "opencode-mobile@latest", source: "probe", scope: "global" }

const result = await PluginLoader.loadExternal({
  items: [origin],
  kind: "server",
  report: {
    start: (candidate) => console.log("[start]", candidate.plan.spec),
    missing: (candidate, retry, message, resolved) =>
      console.log("[missing]", candidate.plan.spec, "retry:", retry, message, {
        target: resolved?.target,
        entry: resolved?.entry,
        pkg: resolved?.pkg?.pkg?.name,
      }),
    error: (candidate, retry, stage, error, resolved) =>
      console.log("[error]", candidate.plan.spec, "stage:", stage, "retry:", retry, error instanceof Error ? (error.cause ?? error) : error, { target: resolved?.target, entry: resolved?.entry }),
  },
})
for (const item of result) console.log("[loaded]", item.spec, item.entry)
await new Promise((r) => setTimeout(r, 3000))
process.exit(0)