import * as path from "path"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { createTwoFilesPatch, diffLines } from "diff"
import DESCRIPTION from "./notebook-edit.txt"
import { FileSystem } from "@flynncode/core/filesystem"
import { Watcher } from "@flynncode/core/filesystem/watcher"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { Snapshot } from "@/snapshot"
import { assertExternalDirectoryEffect } from "./external-directory"
import { FSUtil } from "@flynncode/core/fs-util"
import * as Bom from "@/util/bom"
import { lock, normalizeLineEndings, trimDiff } from "./edit"
import * as Notebook from "./notebook"

export const Parameters = Schema.Struct({
  notebook_path: Schema.String.annotate({
    description: "The absolute path to the Jupyter notebook (.ipynb) to modify",
  }),
  cell_id: Schema.optional(Schema.String).annotate({
    description:
      "The id of the cell to edit (`cell-<index>`, 0-based, for cells without ids). For insert, the new cell goes after this cell; omit it to insert at the start",
  }),
  new_source: Schema.optional(Schema.String).annotate({
    description: "The new source of the cell (required for replace and insert)",
  }),
  cell_type: Schema.optional(Schema.Literals(["code", "markdown", "raw"])).annotate({
    description: "The cell type (required for insert; on replace it changes the type of the cell)",
  }),
  edit_mode: Schema.optional(Schema.Literals(["replace", "insert", "delete"])).annotate({
    description: "The kind of edit (default replace)",
  }),
})

export const NotebookEditTool = Tool.define(
  "notebook_edit",
  Effect.gen(function* () {
    const afs = yield* FSUtil.Service
    const events = yield* EventV2Bridge.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const filePath = path.isAbsolute(params.notebook_path)
            ? params.notebook_path
            : path.join(instance.directory, params.notebook_path)
          if (path.extname(filePath).toLowerCase() !== ".ipynb") {
            throw new Error(`File is not a Jupyter notebook (.ipynb): ${filePath}`)
          }
          yield* assertExternalDirectoryEffect(ctx, filePath)

          const done = yield* lock(filePath).withPermits(1)(
            Effect.gen(function* () {
              const info = yield* afs.stat(filePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
              if (!info) throw new Error(`File ${filePath} not found`)
              if (info.type === "Directory") throw new Error(`Path is a directory, not a file: ${filePath}`)

              const source = yield* Bom.readFile(afs, filePath)
              const notebook = Notebook.parse(source.text)
              if (!notebook) {
                throw new Error(`${filePath} is not a valid notebook: expected JSON with a cells array (nbformat 4)`)
              }
              if (notebook.value.nbformat !== 4) {
                throw new Error(
                  `Only nbformat 4 notebooks can be edited (this one is ${String(notebook.value.nbformat)})`,
                )
              }

              const message = Notebook.apply(notebook, {
                edit_mode: params.edit_mode ?? "replace",
                cell_id: params.cell_id,
                cell_type: params.cell_type,
                new_source: params.new_source,
              })
              const next = Notebook.serialize(notebook)
              const diff = trimDiff(
                createTwoFilesPatch(filePath, filePath, normalizeLineEndings(source.text), normalizeLineEndings(next)),
              )
              yield* ctx.ask({
                permission: "edit",
                patterns: [path.relative(instance.worktree, filePath)],
                always: ["*"],
                metadata: {
                  filepath: filePath,
                  diff,
                },
              })

              yield* afs.writeWithDirs(filePath, Bom.join(next, source.bom))
              yield* events.publish(FileSystem.Event.Edited, { file: filePath })
              yield* events.publish(Watcher.Event.Updated, { file: filePath, event: "change" })
              return { message, diff, before: source.text, after: next }
            }).pipe(Effect.orDie),
          )

          const changes = diffLines(done.before, done.after)
          const filediff: Snapshot.FileDiff = {
            file: filePath,
            patch: done.diff,
            additions: changes.reduce((sum, change) => sum + (change.added ? change.count || 0 : 0), 0),
            deletions: changes.reduce((sum, change) => sum + (change.removed ? change.count || 0 : 0), 0),
          }

          yield* ctx.metadata({
            metadata: {
              diff: done.diff,
              filediff,
              diagnostics: {},
            },
          })

          return {
            metadata: {
              diagnostics: {},
              diff: done.diff,
              filediff,
            },
            title: `${path.relative(instance.worktree, filePath)}`,
            output: done.message,
          }
        }),
    }
  }),
)
