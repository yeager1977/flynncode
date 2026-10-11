import { run as runTui, type TuiInput } from "@flynncode/tui"
import { Global } from "@flynncode/core/global"
import { AppNodeBuilder } from "@flynncode/core/effect/app-node-builder"
import { Effect } from "effect"

export function run(input: TuiInput) {
  return runTui(input).pipe(Effect.provide(AppNodeBuilder.build(Global.node)))
}
