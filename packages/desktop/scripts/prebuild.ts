#!/usr/bin/env bun
import { $ } from "bun"

import { resolveChannel, stageForkCliToResources } from "./utils"

const channel = resolveChannel()
await $`bun ./scripts/copy-icons.ts ${channel}`
await $`bun ./scripts/copy-metainfo.ts ${channel}`

await $`cd ../flynncode && bun script/build.ts --single`
await $`cd ../flynncode && bun script/build-node.ts`
if (channel === "dev") await stageForkCliToResources()
