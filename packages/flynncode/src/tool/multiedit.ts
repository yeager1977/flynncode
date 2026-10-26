import * as path from "path"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { LSP } from "@/lsp/lsp"
import { createTwoFilesPatch, diffLines } from "diff"
import DESCRIPTION from "./multiedit.txt"
import { FileSystem } from "@flynncode/core/filesystem"
import { Watcher } from "@flynncode/core/filesystem/watcher"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Format } from "../format"
import { InstanceState } from "@/effect/instance-state"
import { Snapshot } from "@/snapshot"
import { assertExternalDirectoryEffect } from "./external-directory"
import { FSUtil } from "@flynncode/core/fs-util"
import * as Bom from "@/util/bom"
import { convertToLineEnding, detectLineEnding, lock, normalizeLineEndings, replace, trimDiff } from "./edit"

const Edit = Schema.Struct({
  old_string: Schema.String.annotate({ description: "The text to replace" }),
  new_string: Schema.String.annotate({
    description: "The text to replace it with (must be different from old_string)",
  }),
  replace_all: Schema.optional(Schema.Boolean).annotate({
    description: "Replace all occurrences of old_string (default false)",
  }),
})

export const Parameters = Schema.Struct({
  file_path: Schema.String.annotate({ description: "The absolute path to the file to modify" }),
  edits: Schema.Array(Edit)
    .check(Schema.isMinLength(1))
    .annotate({ description: "The edits to apply in order; each operates on the result of the previous one" }),
})

export const MultiEditTool = Tool.define(
  "multiedit",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const afs = yield* FSUtil.Service
    const format = yield* Format.Service
    const events = yield* EventV2Bridge.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (!params.file_path) throw new Error("file_path is required")
          if (params.edits.length === 0) throw new Error("edits must contain at least one edit")

          const instance = yield* InstanceState.context
          const filePath = path.isAbsolute(params.file_path)
            ? params.file_path
            : path.join(instance.directory, params.file_path)
          yield* assertExternalDirectoryEffect(ctx, filePath)

          let diff = ""
          let contentOld = ""
          let contentNew = ""
          yield* lock(filePath).withPermits(1)(
            Effect.gen(function* () {
              const existed = yield* afs.existsSafe(filePath)
              const creating = params.edits[0].old_string === ""
              if (creating && existed) {
                throw new Error(
                  "Edit 1 failed: old_string cannot be empty when editing an existing file. Provide the exact text to replace, or use write for an intentional full-file replacement.",
                )
              }

              if (!creating) {
                const info = yield* afs.stat(filePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
                if (!info) throw new Error(`File ${filePath} not found`)
                if (info.type === "Directory") throw new Error(`Path is a directory, not a file: ${filePath}`)
              }
              const source = creating ? { bom: false, text: "" } : yield* Bom.readFile(afs, filePath)
              contentOld = source.text
              const ending = detectLineEnding(contentOld)

              // Edits run against the in-memory result of the previous edit; nothing touches disk until all succeed.
              const applied = params.edits.reduce((content, edit, index) => {
                const fail = (reason: string) =>
                  new Error(`Edit ${index + 1} failed: ${reason.replaceAll("oldString", "old_string")}`)
                if (edit.old_string === edit.new_string) {
                  throw fail("No changes to apply: old_string and new_string are identical.")
                }
                // The first edit of a new file supplies its whole content.
                if (creating && index === 0) return edit.new_string
                const current = creating ? detectLineEnding(content) : ending
                try {
                  return replace(
                    content,
                    convertToLineEnding(normalizeLineEndings(edit.old_string), current),
                    convertToLineEnding(normalizeLineEndings(edit.new_string), current),
                    edit.replace_all,
                  )
                } catch (error) {
                  throw fail(error instanceof Error ? error.message : String(error))
                }
              }, contentOld)

              const next = Bom.split(applied)
              const desiredBom = source.bom || next.bom
              contentNew = next.text

              const patch = () =>
                trimDiff(
                  createTwoFilesPatch(
                    filePath,
                    filePath,
                    normalizeLineEndings(contentOld),
                    normalizeLineEndings(contentNew),
                  ),
                )
              diff = patch()
              yield* ctx.ask({
                permission: "edit",
                patterns: [path.relative(instance.worktree, filePath)],
                always: ["*"],
                metadata: {
                  filepath: filePath,
                  diff,
                },
              })

              yield* afs.writeWithDirs(filePath, Bom.join(contentNew, desiredBom))
              if (yield* format.file(filePath)) {
                contentNew = yield* Bom.syncFile(afs, filePath, desiredBom)
              }
              yield* events.publish(FileSystem.Event.Edited, { file: filePath })
              yield* events.publish(Watcher.Event.Updated, {
                file: filePath,
                event: existed ? "change" : "add",
              })
              diff = patch()
            }).pipe(Effect.orDie),
          )

          let additions = 0
          let deletions = 0
          for (const change of diffLines(contentOld, contentNew)) {
            if (change.added) additions += change.count || 0
            if (change.removed) deletions += change.count || 0
          }
          const filediff: Snapshot.FileDiff = {
            file: filePath,
            patch: diff,
            additions,
            deletions,
          }

          yield* ctx.metadata({
            metadata: {
              diff,
              filediff,
              diagnostics: {},
            },
          })

          let output = `Applied ${params.edits.length} edit${params.edits.length === 1 ? "" : "s"} successfully.`
          yield* lsp.touchFile(filePath, "document")
          const diagnostics = yield* lsp.diagnostics()
          const normalizedFilePath = FSUtil.normalizePath(filePath)
          const block = LSP.Diagnostic.report(filePath, diagnostics[normalizedFilePath] ?? [])
          if (block) output += `\n\nLSP errors detected in this file, please fix:\n${block}`

          return {
            metadata: {
              diagnostics,
              diff,
              filediff,
            },
            title: `${path.relative(instance.worktree, filePath)}`,
            output,
          }
        }),
    }
  }),
)
