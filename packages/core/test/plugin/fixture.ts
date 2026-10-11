import { AgentV2 } from "@flynncode/core/agent"
import { AISDK } from "@flynncode/core/aisdk"
import { Catalog } from "@flynncode/core/catalog"
import { CommandV2 } from "@flynncode/core/command"
import { Credential } from "@flynncode/core/credential"
import { AppNodeBuilder } from "@flynncode/core/effect/app-node-builder"
import { LayerNodePlatform } from "@flynncode/core/effect/app-node-platform"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { EventV2 } from "@flynncode/core/event"
import { FileSystem } from "@flynncode/core/filesystem"
import { FSUtil } from "@flynncode/core/fs-util"
import { Integration } from "@flynncode/core/integration"
import { Location } from "@flynncode/core/location"
import { Npm } from "@flynncode/core/npm"
import { PluginV2 } from "@flynncode/core/plugin"
import { Reference } from "@flynncode/core/reference"
import { SkillV2 } from "@flynncode/core/skill"
import { Effect, Layer } from "effect"
import { tempLocationLayer } from "../fixture/location"

const npmLayer = Layer.succeed(
  Npm.Service,
  Npm.Service.of({
    add: () => Effect.succeed({ directory: "", entrypoint: undefined }),
    install: () => Effect.void,
    which: () => Effect.succeed(undefined),
  }),
)

const pluginNodes = LayerNode.group([
  FileSystem.node,
  FSUtil.node,
  Location.node,
  Npm.node,
  Credential.node,
  EventV2.node,
  LayerNodePlatform.httpClient,
  PluginV2.node,
  AgentV2.node,
  AISDK.node,
  Catalog.node,
  CommandV2.node,
  Integration.node,
  Reference.node,
  SkillV2.node,
])
const replacements: LayerNode.Replacements = [
  [Location.node, tempLocationLayer],
  [Npm.node, npmLayer],
]

export const PluginTestLayer = AppNodeBuilder.build(pluginNodes, replacements)

export const PluginTestLayerWithEvent = (event: Layer.Layer<EventV2.Service>) =>
  AppNodeBuilder.build(pluginNodes, replacements.concat([[EventV2.node, event]]))
