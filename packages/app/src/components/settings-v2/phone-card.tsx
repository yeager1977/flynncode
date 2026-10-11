import { ButtonV2 } from "@flynncode/ui/v2/button-v2"
import { Switch } from "@flynncode/ui/v2/switch-v2"
import { TextInputV2 } from "@flynncode/ui/v2/text-input-v2"
import { type Component, For, Show, createEffect, createResource, createSignal, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { showToast } from "@/utils/toast"
import { useLanguage } from "@/context/language"
import { normalizeServerUrl, serverName, useServer, type ServerConnection } from "@/context/server"
import { SettingsListV2 } from "./parts/list"
import { createPhoneAccessController } from "./phone-access-controller"
import { isHttpUrl } from "./phone-relay-url"
import { canEncodeQr, drawQrToCanvas } from "./phone-qr"

type MobileGatewayStatus = {
  running: boolean
  port: number
  lanUrls: string[]
  launcherUrls: string[]
  tailnetUrls?: string[]
  tailnetLauncherUrls?: string[]
}

type PhoneApi = {
  getMobileGatewayStatus?: () => Promise<MobileGatewayStatus>
  getMobilePhonePassword?: () => Promise<string | null>
  rotateMobilePhonePassword?: () => Promise<string>
  getPhoneAccess?: () => Promise<boolean>
  setPhoneAccess?: (enabled: boolean) => Promise<void>
  // Live relay updates: the desktop main process rebuilds the running relay
  // publisher after a successful save, so a restart is not needed.
  setRelayConfig?: (config: { token?: string; remoteToken?: string; url?: string }) => Promise<void>
}

const STOPPED_STATUS: MobileGatewayStatus = { running: false, port: 4097, lanUrls: [], launcherUrls: [], tailnetUrls: [], tailnetLauncherUrls: [] }
const STATUS_POLL_INTERVAL_MS = 5000
const MASKED_PASSWORD = "••••••••"

export const PhoneCard: Component = () => {
  const language = useLanguage()
  const server = useServer()
  const phoneApi = (window as unknown as { api?: PhoneApi }).api
  // The web build has no desktop bridge, so there is no gateway to poll.
  const available = typeof phoneApi?.getMobileGatewayStatus === "function"
  const [status, { refetch }] = createResource(async () => {
    if (!phoneApi?.getMobileGatewayStatus) return STOPPED_STATUS
    return phoneApi.getMobileGatewayStatus().catch(() => STOPPED_STATUS)
  })
  // Read through `latest` so a background refetch keeps the last value instead
  // of suspending, which would unmount the card and drop input focus.
  const current = () => status.latest
  // The card mounts once; if Settings opens before the sidecar is ready the
  // first fetch resolves stopped. Keep polling until the gateway is running.
  const timer = available
    ? setInterval(() => {
        if (current()?.running !== true) refetch()
        else clearInterval(timer)
      }, STATUS_POLL_INTERVAL_MS)
    : undefined
  onCleanup(() => clearInterval(timer))
  const [phonePassword, setPhonePassword] = createStore({
    value: undefined as string | undefined,
    visible: false,
    rotated: false,
  })
  onMount(() => {
    void phoneApi
      ?.getMobilePhonePassword?.()
      .then((value) => setPhonePassword("value", value ?? undefined))
      .catch(() => undefined)
  })
  const rotatePhonePassword = () => {
    void phoneApi
      ?.rotateMobilePhonePassword?.()
      .then((value) => setPhonePassword({ value, rotated: true }))
      .catch(() => undefined)
  }
  const phoneAccess = createPhoneAccessController({ api: phoneApi, refetch: () => void refetch() })
  const [copied, setCopied] = createSignal<string>()
  const [remoteToken, setRemoteToken] = createSignal("")
  const [tokenSaved, setTokenSaved] = createSignal(false)
  let qrCanvas: HTMLCanvasElement | undefined
  let qrCanvasRelay: HTMLCanvasElement | undefined

  // The outbound relay token is the deepthought host's inbound token, pasted
  // once here. It lives in the desktop settings store and is sent only as an
  // outbound Bearer header — never rendered into QR codes or URLs.
  const storeApi = () =>
    (window as unknown as { api?: { storeGet?: (name: string, key: string) => Promise<string | null>; storeSet?: (name: string, key: string, value: string) => Promise<void> } }).api

  onMount(() => {
    void storeApi()?.storeGet?.("opencode.settings", "relayRemoteToken").then((value) => {
      if (value) setTokenSaved(true)
    }).catch(() => undefined)
    void storeApi()?.storeGet?.("opencode.settings", "relayPublishUrl").then((value) => {
      if (value) setPublishUrl("stored", value)
    }).catch(() => undefined)
  })

  const saveRemoteToken = () => {
    const value = remoteToken().trim()
    if (!value) return
    void storeApi()?.storeSet?.("opencode.settings", "relayRemoteToken", value).then(() => {
      setRemoteToken("")
      setTokenSaved(true)
      void phoneApi?.setRelayConfig?.({ remoteToken: value }).catch(() => undefined)
    }).catch(() => undefined)
  }

  // The relay publish URL is the deepthought host's gateway URL that the
  // sidecar posts needs-input notices to. The desktop main process reads this
  // store key at sidecar start and pushes a saved value to the sidecar live,
  // so the running publisher rebuilds without restarting the app.
  const [publishUrl, setPublishUrl] = createStore({
    stored: undefined as string | undefined,
    input: "",
    saved: false,
  })

  const saveRelayUrl = () => {
    const value = publishUrl.input.trim()
    if (!isHttpUrl(value)) {
      showToast({ variant: "error", description: language.t("settings.phone.relayUrl.invalid") })
      return
    }
    void storeApi()?.storeSet?.("opencode.settings", "relayPublishUrl", value).then(() => {
      setPublishUrl({ stored: value, input: "", saved: true })
      void phoneApi?.setRelayConfig?.({ url: value }).catch(() => undefined)
    }).catch(() => undefined)
  }

  const launcherUrls = () => current()?.launcherUrls ?? []
  const gatewayRunning = () => current()?.running === true
  const hasUrls = () => launcherUrls().length > 0
  const loopbackUrl = () => `http://127.0.0.1:${current()?.port ?? STOPPED_STATUS.port}/m`
  const qrUrl = () => {
    const first = launcherUrls()[0]
    return first && canEncodeQr(first) ? first : undefined
  }
  const tailnetLauncherUrls = () => current()?.tailnetLauncherUrls ?? []
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
  // Display the stored gateway URL, falling back to the derived-from-servers
  // address while nothing is persisted.
  const relayUrlValue = () => publishUrl.stored ?? relayLauncherUrl()

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
    <Show when={available && current()}>
      <SettingsListV2>
        <div class="settings-v2-servers-row">
          <div class="settings-v2-servers-lead">
            <div
              aria-hidden="true"
              classList={{
                "size-1.5 rounded-full shrink-0 my-[3.5px]": true,
                "bg-icon-success-base": phoneAccess.enabled() && gatewayRunning(),
                "bg-border-weak-base": !(phoneAccess.enabled() && gatewayRunning()),
              }}
            />
            <div class="settings-v2-servers-copy">
              <span class="settings-v2-servers-name">{language.t("server.phone.title")}</span>
              <span class="settings-v2-servers-meta">
                <Show when={phoneAccess.enabled()} fallback={language.t("server.phone.access.off")}>
                  <Show when={gatewayRunning()} fallback={language.t("server.phone.stopped")}>
                    <Show when={hasUrls()} fallback={language.t("server.phone.noWifi")}>
                      {language.t("server.phone.hint")}
                    </Show>
                  </Show>
                </Show>
              </span>
            </div>
          </div>
        </div>
        <div class="settings-v2-servers-row">
          <div class="settings-v2-servers-lead">
            <div class="settings-v2-servers-copy">
              <span class="settings-v2-servers-name">{language.t("server.phone.access.label")}</span>
              <span class="settings-v2-servers-meta">{language.t("server.phone.access.hint")}</span>
            </div>
          </div>
          <div class="settings-v2-servers-actions">
            <Switch checked={phoneAccess.enabled()} onChange={phoneAccess.toggle} hideLabel>
              {language.t("server.phone.access.label")}
            </Switch>
          </div>
        </div>
        <Show when={phoneAccess.enabled()}>
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
                <span class="settings-v2-servers-name">{language.t("server.phone.password.label")}</span>
                <span class="settings-v2-servers-meta">
                  <Show when={phonePassword.value} fallback={language.t("server.phone.password.unavailable")}>
                    {language.t("server.phone.password.hint")}
                  </Show>
                </span>
              </div>
            </div>
          </div>
          <Show when={phonePassword.value}>
            {(password) => (
              <div class="settings-v2-servers-row">
                <div class="settings-v2-servers-lead">
                  <div class="settings-v2-servers-copy">
                    <span class="settings-v2-servers-name font-mono select-all">
                      {phonePassword.visible ? password() : MASKED_PASSWORD}
                    </span>
                  </div>
                </div>
                <div class="settings-v2-servers-actions">
                  <ButtonV2
                    size="small"
                    variant="ghost-muted"
                    onClick={() => setPhonePassword("visible", (visible) => !visible)}
                  >
                    {phonePassword.visible
                      ? language.t("server.phone.password.hide")
                      : language.t("server.phone.password.show")}
                  </ButtonV2>
                  <ButtonV2 size="small" variant="ghost-muted" onClick={() => copyUrl(password())}>
                    <Show when={copied() === password()} fallback={language.t("server.phone.copy")}>
                      {language.t("session.share.copy.copied")}
                    </Show>
                  </ButtonV2>
                  <ButtonV2 size="small" variant="ghost-muted" onClick={rotatePhonePassword}>
                    {language.t("server.phone.password.rotate")}
                  </ButtonV2>
                </div>
              </div>
            )}
          </Show>
          <Show when={phonePassword.rotated}>
            <div class="settings-v2-servers-row">
              <div class="settings-v2-servers-lead">
                <div class="settings-v2-servers-copy">
                  <span class="settings-v2-servers-meta">{language.t("server.phone.password.rotated")}</span>
                </div>
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
          <Show
            when={tailnetUrl()}
            fallback={
              <div class="settings-v2-servers-row">
                <div class="settings-v2-servers-lead">
                  <div class="settings-v2-servers-copy">
                    <span class="settings-v2-servers-meta">{language.t("server.phone.noWifi")}</span>
                  </div>
                </div>
              </div>
            }
          >
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
          <Show
            when={relayLauncherUrl()}
            fallback={
              <div class="settings-v2-servers-row">
                <div class="settings-v2-servers-lead">
                  <div class="settings-v2-servers-copy">
                    <span class="settings-v2-servers-meta">{language.t("server.phone.relay.stopped")}</span>
                  </div>
                </div>
              </div>
            }
          >
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
          <div class="settings-v2-servers-row">
            <div class="settings-v2-servers-lead">
              <div class="settings-v2-servers-copy">
                <span class="settings-v2-servers-name">{language.t("server.phone.relay.token.label")}</span>
                <span class="settings-v2-servers-meta">{language.t("server.phone.relay.token.hint")}</span>
              </div>
            </div>
          </div>
          <div class="settings-v2-servers-row">
            <div class="settings-v2-servers-lead">
              <TextInputV2
                type="password"
                appearance="base"
                value={remoteToken()}
                onInput={(event) => setRemoteToken(event.currentTarget.value)}
                placeholder={language.t("server.phone.relay.token.placeholder")}
                spellcheck={false}
                autocorrect="off"
                autocomplete="off"
                autocapitalize="off"
                aria-label={language.t("server.phone.relay.token.label")}
              />
            </div>
            <div class="settings-v2-servers-actions">
              <ButtonV2 size="small" variant="ghost-muted" onClick={saveRemoteToken}>
                {language.t("server.phone.relay.token.save")}
              </ButtonV2>
            </div>
          </div>
          <Show when={tokenSaved()}>
            <div class="settings-v2-servers-row">
              <div class="settings-v2-servers-lead">
                <div class="settings-v2-servers-copy">
                  <span class="settings-v2-servers-meta">{language.t("server.phone.relay.token.saved")}</span>
                </div>
              </div>
            </div>
          </Show>
          <div class="settings-v2-servers-row">
            <div class="settings-v2-servers-lead">
              <div class="settings-v2-servers-copy">
                <span class="settings-v2-servers-name">{language.t("settings.phone.relayUrl.label")}</span>
                <span class="settings-v2-servers-meta">{language.t("settings.phone.relayUrl.hint")}</span>
              </div>
            </div>
          </div>
          <div class="settings-v2-servers-row">
            <div class="settings-v2-servers-lead">
              <div class="settings-v2-servers-copy">
                <Show
                  when={relayUrlValue()}
                  fallback={
                    <span class="settings-v2-servers-meta">{language.t("server.phone.relay.stopped")}</span>
                  }
                >
                  {(url) => <span class="settings-v2-servers-name font-mono select-all">{url()}</span>}
                </Show>
              </div>
            </div>
          </div>
          <div class="settings-v2-servers-row">
            <div class="settings-v2-servers-lead">
              <TextInputV2
                appearance="base"
                value={publishUrl.input}
                onInput={(event) => setPublishUrl("input", event.currentTarget.value)}
                placeholder={language.t("settings.phone.relayUrl.placeholder")}
                spellcheck={false}
                autocorrect="off"
                autocomplete="off"
                autocapitalize="off"
                aria-label={language.t("settings.phone.relayUrl.label")}
              />
            </div>
            <div class="settings-v2-servers-actions">
              <ButtonV2 size="small" variant="ghost-muted" onClick={saveRelayUrl}>
                {language.t("settings.phone.relayUrl.save")}
              </ButtonV2>
            </div>
          </div>
          <Show when={publishUrl.saved}>
            <div class="settings-v2-servers-row">
              <div class="settings-v2-servers-lead">
                <div class="settings-v2-servers-copy">
                  <span class="settings-v2-servers-meta">{language.t("settings.phone.relayUrl.saved")}</span>
                </div>
              </div>
            </div>
          </Show>
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
