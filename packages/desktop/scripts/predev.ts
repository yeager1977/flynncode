import { $ } from "bun"
import { stageForkCliToResources } from "./utils"

await $`bun run install-electron`

await $`bun ./scripts/copy-icons.ts ${process.env.OPENCODE_CHANNEL ?? "dev"}`

await $`cd ../flynncode && bun script/build-node.ts`
await stageForkCliToResources({ buildIfMissing: true })
