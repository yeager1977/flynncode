import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { type Component, For, Show, createEffect, createResource, createSignal, onCleanup } from "solid-js"
import { useLanguage } from "@/context/language"
import { normalizeServerUrl, serverName, useServer, type ServerConnection } from "@/context/server"
import { SettingsListV2 } from "./parts/list"
import { canEncodeQr, drawQrToCanvas } from "./phone-qr"

type MobileGatewayStatus = {
  running: boolean
  port: number
  lanUrls: string[]
  launcherUrls: string[]
  tailnetUrls?: string[]
  tailnetLauncherUrls?: string[]
}

const STOPPED_STATUS: MobileGatewayStatus = { running: false, port: 4097, lanUrls: [], launcherUrls: [], tailnetUrls: [], tailnetLauncherUrls: [] }
const STATUS_POLL_INTERVAL_MS = 5000

export const PhoneCard: Component = () => {
  const language = useLanguage()
  const server = useServer()
  const [status, { refetch }] = createResource(async () => {
    const api = (window as unknown as { api?: { getMobileGatewayStatus?: () => Promise<MobileGatewayStatus> } })
      .api
    if (!api?.getMobileGatewayStatus) return STOPPED_STATUS
    return api.getMobileGatewayStatus()
  })
  // The card mounts once; if Settings opens before the sidecar is ready the
  // first fetch resolves stopped. Keep polling until the gateway is running.
  const timer = setInterval(() => {
    if (status()?.running !== true) refetch()
    else clearInterval(timer)
  }, STATUS_POLL_INTERVAL_MS)
  onCleanup(() => clearInterval(timer))
  const [copied, setCopied] = createSignal<string>()
  let qrCanvas: HTMLCanvasElement | undefined
  let qrCanvasRelay: HTMLCanvasElement | undefined

  const launcherUrls = () => status()?.launcherUrls ?? []
  const gatewayRunning = () => status()?.running === true
  const hasUrls = () => launcherUrls().length > 0
  const loopbackUrl = () => `http://127.0.0.1:${status()?.port ?? STOPPED_STATUS.port}/m`
  const qrUrl = () => {
    const first = launcherUrls()[0]
    return first && canEncodeQr(first) ? first : undefined
  }
  const tailnetLauncherUrls = () => status()?.tailnetLauncherUrls ?? []
  const tailnetUrl = () => tailnetLauncherUrls()[0]
  const relayLauncherUrl = () => {
    for (const entry of server.list) {
      const url = relayLauncherUrlFor(entry)
      if (url) return url
    }
    return
  }
  const relayQrUrl = () => {
    const url = relayLauncherUrl()
    return url && canEncodeQr(url) ? url : undefined
  }

  const copyUrl = (url: string) => {
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard
    if (!clipboard?.writeText) return
    void clipboard.writeText(url).then(() => {
      setCopied(url)
      setTimeout(() => setCopied((current) => (current === url ? undefined : current)), 2000)
    })
  }

  createEffect(() => {
    const url = qrUrl()
    if (qrCanvas && url) drawQrToCanvas(qrCanvas, url)
  })

  createEffect(() => {
    const url = relayQrUrl()
    if (qrCanvasRelay && url) drawQrToCanvas(qrCanvasRelay, url)
  })

  return (
    <Show when={!status.loading}>
      <SettingsListV2>
        <div class="settings-v2-servers-row">
          <div class="settings-v2-servers-lead">
            <div
              aria-hidden="true"
              classList={{
                "size-1.5 rounded-full shrink-0 my-[3.5px]": true,
                "bg-icon-success-base": gatewayRunning(),
                "bg-border-weak-base": !gatewayRunning(),
              }}
            />
            <div class="settings-v2-servers-copy">
              <span class="settings-v2-servers-name">{language.t("server.phone.title")}</span>
              <span class="settings-v2-servers-meta">
                <Show when={gatewayRunning()} fallback={language.t("server.phone.stopped")}>
                  <Show when={hasUrls()} fallback={language.t("server.phone.noWifi")}>
                    {language.t("server.phone.hint")}
                  </Show>
                </Show>
              </span>
            </div>
          </div>
        </div>
        <Show when={gatewayRunning() && hasUrls()}>
          <For each={launcherUrls()}>
            {(url) => (
              <div class="settings-v2-servers-row">
                <div class="settings-v2-servers-lead">
                  <div class="settings-v2-servers-copy">
                    <span class="settings-v2-servers-name">{url}</span>
                  </div>
                </div>
                <div class="settings-v2-servers-actions">
                  <ButtonV2 size="small" variant="ghost-muted" onClick={() => copyUrl(url)}>
                    <Show when={copied() === url} fallback={language.t("server.phone.copy")}>
                      {language.t("session.share.copy.copied")}
                    </Show>
                  </ButtonV2>
                </div>
              </div>
            )}
          </For>
          <Show when={qrUrl()}>
            <div class="settings-v2-servers-row">
              <canvas
                ref={(element) => {
                  qrCanvas = element
                }}
                aria-label={language.t("server.phone.title")}
                style={{ width: "128px", height: "128px", "image-rendering": "pixelated" }}
              />
            </div>
          </Show>
        </Show>
        <Show when={gatewayRunning() && !hasUrls()}>
          <div class="settings-v2-servers-row">
            <div class="settings-v2-servers-lead">
              <div class="settings-v2-servers-copy">
                <span class="settings-v2-servers-name">{loopbackUrl()}</span>
              </div>
            </div>
            <div class="settings-v2-servers-actions">
              <ButtonV2 size="small" variant="ghost-muted" onClick={() => copyUrl(loopbackUrl())}>
                <Show when={copied() === loopbackUrl()} fallback={language.t("server.phone.copy")}>
                  {language.t("session.share.copy.copied")}
                </Show>
              </ButtonV2>
            </div>
          </div>
        </Show>
        <div class="settings-v2-servers-row">
          <div class="settings-v2-servers-lead">
            <div class="settings-v2-servers-copy">
              <span class="settings-v2-servers-name">{language.t("server.phone.away.title")}</span>
              <span class="settings-v2-servers-meta">{language.t("server.phone.away.direct")}</span>
            </div>
          </div>
        </div>
        <Show when={tailnetUrl()} fallback={<div class="settings-v2-servers-row">
          <div class="settings-v2-servers-lead">
            <div class="settings-v2-servers-copy">
              <span class="settings-v2-servers-meta">{language.t("server.phone.noWifi")}</span>
            </div>
          </div>
        </div>}>
          {(url) => (
            <div class="settings-v2-servers-row">
              <div class="settings-v2-servers-lead">
                <div class="settings-v2-servers-copy">
                  <span class="settings-v2-servers-name">{url()}</span>
                </div>
              </div>
              <div class="settings-v2-servers-actions">
                <ButtonV2 size="small" variant="ghost-muted" onClick={() => copyUrl(url())}>
                  <Show when={copied() === url()} fallback={language.t("server.phone.copy")}>
                    {language.t("session.share.copy.copied")}
                  </Show>
                </ButtonV2>
              </div>
            </div>
          )}
        </Show>
        <div class="settings-v2-servers-row">
          <div class="settings-v2-servers-lead">
            <div class="settings-v2-servers-copy">
              <span class="settings-v2-servers-name">{language.t("server.phone.relay.title")}</span>
              <span class="settings-v2-servers-meta">{language.t("server.phone.relay.hint")}</span>
            </div>
          </div>
        </div>
        <Show when={relayLauncherUrl()} fallback={<div class="settings-v2-servers-row">
          <div class="settings-v2-servers-lead">
            <div class="settings-v2-servers-copy">
              <span class="settings-v2-servers-meta">{language.t("server.phone.relay.stopped")}</span>
            </div>
          </div>
        </div>}>
          {(url) => (
            <>
              <div class="settings-v2-servers-row">
                <div class="settings-v2-servers-lead">
                  <div class="settings-v2-servers-copy">
                    <span class="settings-v2-servers-name">{url()}</span>
                  </div>
                </div>
                <div class="settings-v2-servers-actions">
                  <ButtonV2 size="small" variant="ghost-muted" onClick={() => copyUrl(url())}>
                    <Show when={copied() === url()} fallback={language.t("server.phone.copy")}>
                      {language.t("session.share.copy.copied")}
                    </Show>
                  </ButtonV2>
                </div>
              </div>
              <Show when={relayQrUrl()}>
                <div class="settings-v2-servers-row">
                  <canvas
                    ref={(element) => {
                      qrCanvasRelay = element
                    }}
                    aria-label={language.t("server.phone.relay.title")}
                    style={{ width: "128px", height: "128px", "image-rendering": "pixelated" }}
                  />
                </div>
              </Show>
            </>
          )}
        </Show>
      </SettingsListV2>
    </Show>
  )
}

// The relay row points at the deepthought host's own gateway launcher. The QR
// encodes the bare http(s) .../m URL only — the phone credential is typed
// once, and the relay token never leaves the two hosts.
function relayLauncherUrlFor(entry: ServerConnection.Any) {
  const host = entry.http.url.replace(/^https?:\/\//, "").split(":")[0].split("/")[0].toLowerCase()
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return
  const name = serverName(entry).toLowerCase()
  if (!name.includes("deepthought") && host !== "192.168.4.251") return
  const normalized = normalizeServerUrl(entry.http.url)
  if (!normalized) return
  const match = /^(https?):\/\/([^/:]+)(?::(\d+))?/.exec(normalized)
  if (!match) return
  return `${match[1]}://${match[2]}:4097/m`
}
