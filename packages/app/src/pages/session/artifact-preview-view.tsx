import { createResource, Show } from "solid-js"
import { Markdown } from "@opencode-ai/session-ui/markdown"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { artifactMime, artifactPreviewKind, artifactText } from "./artifact-preview"

export function ArtifactPreview(props: { path: string }) {
  const sdk = useSDK()
  const language = useLanguage()
  const kind = () => artifactPreviewKind(props.path)
  const [file] = createResource(
    () => props.path,
    (path) =>
      sdk()
        .client.file.read({ path })
        .then((result) => result.data)
        .catch(() => undefined),
  )
  const text = () => {
    const value = file()
    if (!value || value.type === "binary") return
    return artifactText(value.content, value.encoding)
  }
  const image = () => {
    const value = file()
    if (!value || value.encoding !== "base64") return
    return `data:${value.mimeType ?? artifactMime(props.path)};base64,${value.content}`
  }

  return (
    <div class="size-full overflow-auto bg-background-base p-3" data-component="artifact-preview">
      <Show when={file.state !== "pending"} fallback={null}>
      <Show when={file()} fallback={<p class="text-12-regular text-text-weak">{language.t("common.requestFailed")}</p>}>
        <Show when={kind() === "markdown" && text()}>
          <Markdown text={text() ?? ""} />
        </Show>
        <Show when={kind() === "html" && text()}>
          <iframe
            class="h-full min-h-96 w-full border-0"
            sandbox="allow-scripts allow-forms"
            srcdoc={text()}
            title={language.t("sidebar.artifacts.title")}
          />
        </Show>
        <Show when={kind() === "image" && image()}>
          <img class="max-w-full" src={image()} alt={props.path} />
        </Show>
      </Show>
      </Show>
    </div>
  )
}
