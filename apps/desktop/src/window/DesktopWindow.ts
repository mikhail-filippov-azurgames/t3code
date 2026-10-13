import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as NodePerformance from "node:perf_hooks";
// @effect-diagnostics nodeBuiltinImport:off -- WMI creates the server process outside the window job.
import * as NodeChildProcess from "node:child_process";
// @effect-diagnostics nodeBuiltinImport:off -- Persisting health records must not depend on Effect fibers.
import * as NodeFs from "node:fs";

import * as Electron from "electron";

import { type DesktopSnapShotEvent, DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";

import * as DesktopAssets from "../app/DesktopAssets.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import { getDesktopUrl } from "../electron/ElectronProtocol.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import {
  MENU_ACTION_CHANNEL,
  EXTERNAL_BACKEND_AVAILABILITY_CHANNEL,
  QUIT_SHORTCUT_CHANNEL,
  RENDERER_HEARTBEAT_CHANNEL,
  SNAP_SHOT_EVENT_CHANNEL,
  WINDOW_FULLSCREEN_STATE_CHANNEL,
} from "../ipc/channels.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopExternalBackend from "../backend/DesktopExternalBackend.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import { makeQuitShortcutHandler } from "./QuitHold.ts";

const TITLEBAR_HEIGHT = 40;
// Matches --workspace-topbar-height in apps/web/src/index.css. Native macOS
// buttons are 14 points tall and do not scale with the renderer's zoom.
const MACOS_WORKSPACE_TOPBAR_HEIGHT = 52;
const MACOS_WINDOW_BUTTON_RADIUS = 7;

function syncMacosWindowButtons(window: Electron.BrowserWindow): void {
  if (window.isDestroyed() || window.isFullScreen()) return;
  window.setWindowButtonPosition({
    x: 16,
    y: Math.round(
      (MACOS_WORKSPACE_TOPBAR_HEIGHT * window.webContents.getZoomFactor()) / 2 -
        MACOS_WINDOW_BUTTON_RADIUS,
    ),
  });
}

const TITLEBAR_COLOR = "#01000000"; // #00000000 does not work correctly on Linux
const TITLEBAR_LIGHT_SYMBOL_COLOR = "#1f2937";
const TITLEBAR_DARK_SYMBOL_COLOR = "#f8fafc";
const MAIN_WINDOW_BOUNDS_PERSIST_DEBOUNCE_MS = 500;
const DEVELOPMENT_LOAD_RETRY_DELAYS_MS = [100, 250, 500, 1_000, 2_000] as const;
// Renderer crash (usually V8 OOM on long sessions) recovery: reload after a
// short delay, at most MAX_ATTEMPTS times per rolling WINDOW so a renderer
// that dies on boot cannot reload-loop forever.
const RENDERER_RECOVERY_RELOAD_DELAY_MS = 500;
const RENDERER_RECOVERY_MAX_ATTEMPTS = 3;
const RENDERER_RECOVERY_WINDOW_MS = 60_000;
const WINDOW_HEALTH_LOG_MAX_BYTES = 5 * 1024 * 1024;
const WINDOW_HEALTH_LOG_BACKUP_COUNT = 3;
const DEVELOPMENT_RETRYABLE_LOAD_ERROR_CODES = new Set([
  -2, // ERR_FAILED
  -7, // ERR_TIMED_OUT
  -9, // ERR_UNEXPECTED (custom protocol handler rejected)
  -102, // ERR_CONNECTION_REFUSED
  -105, // ERR_NAME_NOT_RESOLVED
  -106, // ERR_INTERNET_DISCONNECTED
  -118, // ERR_CONNECTION_TIMED_OUT
]);

type WindowTitleBarOptions = Pick<
  Electron.BrowserWindowConstructorOptions,
  "titleBarOverlay" | "titleBarStyle" | "trafficLightPosition"
>;

type DesktopWindowRuntimeServices =
  | DesktopEnvironment.DesktopEnvironment
  | DesktopAssets.DesktopAssets
  | DesktopAppSettings.DesktopAppSettings
  | DesktopClientSettings.DesktopClientSettings
  | ElectronApp.ElectronApp
  | ElectronMenu.ElectronMenu
  | ElectronShell.ElectronShell
  | ElectronTheme.ElectronTheme
  | ElectronWindow.ElectronWindow
  | PreviewManager.PreviewManager;

export type DesktopWindowError =
  | ElectronWindow.ElectronWindowCreateError
  | PreviewManager.PreviewManagerError;

export type MainWindowZoomDirection = "in" | "out" | "reset";

export class DesktopWindow extends Context.Service<
  DesktopWindow,
  {
    readonly createMain: Effect.Effect<Electron.BrowserWindow, DesktopWindowError>;
    readonly ensureMain: Effect.Effect<Electron.BrowserWindow, DesktopWindowError>;
    readonly revealOrCreateMain: Effect.Effect<Electron.BrowserWindow, DesktopWindowError>;
    readonly activate: Effect.Effect<void, DesktopWindowError>;
    readonly createMainIfBackendReady: Effect.Effect<void, DesktopWindowError>;
    // Show a lightweight "Connecting to WSL" splash window immediately (wsl-only
    // mode), before the WSL backend that acts as the primary is ready. It is
    // dismissed automatically once the real main window reveals.
    readonly showConnectingSplash: Effect.Effect<void>;
    readonly showExternalServerUnavailable: Effect.Effect<void>;
    // Marks the primary backend as ready so `createMainIfBackendReady` and the
    // macOS "activate without windows" path may open the real main window. The
    // renderer now always loads the local client URL (getDesktopUrl) and connects
    // to the backend through the connection layer, so the reported httpBaseUrl is
    // no longer used to point the window at the backend — it is kept only for the
    // readiness log and to preserve the callback contract the backend pool drives.
    readonly handleBackendReady: (httpBaseUrl: URL) => Effect.Effect<void, DesktopWindowError>;
    // Called when the backend transitions back to "not ready" (clean stop,
    // restart, crash). Clears the latch that lets `activate` auto-create a
    // window so a "macOS dock click" while the backend is down doesn't
    // produce a stranded window pointing at nothing.
    readonly handleBackendNotReady: Effect.Effect<void>;
    readonly flushMainWindowBounds: Effect.Effect<void>;
    readonly prepareCaptureReveal: Effect.Effect<void>;
    readonly dispatchMenuAction: (
      action: string,
      options?: { readonly reveal?: boolean },
    ) => Effect.Effect<void, DesktopWindowError>;
    /**
     * Push a capture lifecycle event to the renderer. Only `started` reveals the
     * window; the rest must not interrupt the app the user has switched to.
     */
    readonly dispatchSnapShotEvent: (
      event: DesktopSnapShotEvent,
    ) => Effect.Effect<void, DesktopWindowError>;
    // Zooms the main window's own webContents. The Electron `zoomIn`/`zoomOut`
    // menu roles act on whichever webContents has keyboard focus, so with an
    // embedded preview WebContentsView (or DevTools) focused they zoom the
    // guest page instead of the app UI. The menu routes here to always target
    // the main window.
    readonly zoomMain: (direction: MainWindowZoomDirection) => Effect.Effect<void>;
    readonly syncAppearance: Effect.Effect<void>;
  }
>()("@t3tools/desktop/window/DesktopWindow") {}

const { logInfo: logWindowInfo, logWarning: logWindowWarning } =
  makeComponentLogger("desktop-window");

function getIconOption(
  iconPaths: DesktopAssets.DesktopIconPaths,
  platform: NodeJS.Platform,
): { icon: string } | Record<string, never> {
  if (platform === "darwin") return {}; // macOS uses .icns from app bundle
  const ext = platform === "win32" ? "ico" : "png";
  return Option.match(iconPaths[ext], {
    onNone: () => ({}),
    onSome: (icon) => ({ icon }),
  });
}

function getInitialWindowBackgroundColor(shouldUseDarkColors: boolean): string {
  return shouldUseDarkColors ? "#0a0a0a" : "#ffffff";
}

type DisplayBounds = Pick<Electron.Rectangle, "x" | "y" | "width" | "height">;

function windowFitsWithinDisplay(
  windowBounds: DesktopAppSettings.DesktopWindowBounds,
  displayBounds: DisplayBounds,
): boolean {
  return (
    windowBounds.x >= displayBounds.x &&
    windowBounds.y >= displayBounds.y &&
    windowBounds.x + windowBounds.width <= displayBounds.x + displayBounds.width &&
    windowBounds.y + windowBounds.height <= displayBounds.y + displayBounds.height
  );
}

function windowBoundsEqual(
  left: DesktopAppSettings.DesktopWindowBounds,
  right: DesktopAppSettings.DesktopWindowBounds,
): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

export function resolveInitialMainWindowBounds(
  persistedBounds: DesktopAppSettings.DesktopWindowBounds | null,
  displays: readonly DisplayBounds[],
): DesktopAppSettings.DesktopWindowBounds | typeof DesktopAppSettings.DEFAULT_MAIN_WINDOW_SIZE {
  if (
    persistedBounds !== null &&
    displays.some((display) => windowFitsWithinDisplay(persistedBounds, display))
  ) {
    return persistedBounds;
  }
  return DesktopAppSettings.DEFAULT_MAIN_WINDOW_SIZE;
}

// A self-contained "Connecting to WSL" splash, shown immediately in wsl-only
// mode while the WSL backend (which serves the renderer) cold-boots. Inlined as
// a data URL so it needs no bundled asset and no backend — pure CSS, no JS.
function buildConnectingSplashDataUrl(shouldUseDarkColors: boolean): string {
  const background = getInitialWindowBackgroundColor(shouldUseDarkColors);
  const label = shouldUseDarkColors ? "#9ca3af" : "#6b7280";
  const accent = shouldUseDarkColors ? "#f8fafc" : "#1f2937";
  const track = shouldUseDarkColors ? "rgba(248,250,252,0.18)" : "rgba(31,41,55,0.18)";
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>html,body{margin:0;height:100%}body{background:${background};color:${label};font-family:system-ui,-apple-system,'Segoe UI',sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;-webkit-user-select:none;user-select:none;-webkit-app-region:drag}.spinner{width:26px;height:26px;border:3px solid ${track};border-top-color:${accent};border-radius:50%;animation:spin .8s linear infinite}.label{font-size:13px}@keyframes spin{to{transform:rotate(360deg)}}</style></head><body><div class="spinner"></div><div class="label">Connecting to WSL…</div></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function buildExternalServerUnavailableDataUrl(
  shouldUseDarkColors: boolean,
  lastConnectedAt: number | null,
): string {
  const background = getInitialWindowBackgroundColor(shouldUseDarkColors);
  const foreground = shouldUseDarkColors ? "#f8fafc" : "#111827";
  const muted = shouldUseDarkColors ? "#9ca3af" : "#6b7280";
  // @effect-diagnostics globalDate:off -- Format the last successful local server connection.
  const lastSeen =
    lastConnectedAt === null
      ? "Последней удачной связи ещё не было."
      : `Последняя удачная связь: ${new Date(lastConnectedAt).toLocaleString("ru-RU")}.`;
  const title = lastConnectedAt === null ? "Сервер ft3 не запущен" : "Сервер ft3 не отвечает";
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"><style>html,body{margin:0;height:100%}body{background:${background};color:${foreground};font-family:system-ui,-apple-system,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;text-align:center}.card{max-width:420px;padding:32px}.muted{color:${muted};font-size:13px;margin:12px 0 24px}.actions{display:flex;justify-content:center;gap:10px}button{border:0;border-radius:7px;padding:10px 16px;font:inherit;cursor:pointer}.primary{background:${shouldUseDarkColors ? "#f8fafc" : "#111827"};color:${shouldUseDarkColors ? "#111827" : "#fff"}}.secondary{background:${shouldUseDarkColors ? "#27272a" : "#e5e7eb"};color:${foreground}}</style></head><body><main class="card"><h2>${title}</h2><p class="muted">${lastSeen}</p><div class="actions"><button class="primary" onclick="location.href='ft3server://launch'">Запустить сервер</button><button class="secondary" onclick="location.href='ft3server://retry'">Повторить</button></div></main></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function launchExternalServer(): Promise<void> {
  const serverNode = process.env.FT3_SERVER_NODE;
  const serverLauncher = process.env.FT3_SERVER_LAUNCHER;
  if (!serverNode || !serverLauncher) {
    return Promise.reject(new Error("The detached ft3 server launcher is not configured."));
  }
  const script = [
    "$commandLine = '\"' + $env:FT3_SERVER_NODE + '\" \"' + $env:FT3_SERVER_LAUNCHER + '\"'",
    "$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $commandLine }",
    "if ($result.ReturnValue -ne 0) { throw ('Win32_Process.Create returned ' + $result.ReturnValue) }",
  ].join("; ");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const powerShell = NodeChildProcess.execFile(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    { windowsHide: true },
    (error) => {
      if (error) return;
    },
  );
  return new Promise((resolve, reject) => {
    powerShell.once("error", reject);
    powerShell.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`Win32_Process.Create failed with exit code ${code}.`)),
    );
  });
}

export function isSameOriginRendererNavigation(input: {
  readonly applicationUrl: string;
  readonly navigationUrl: string;
}): boolean {
  try {
    return new URL(input.applicationUrl).origin === new URL(input.navigationUrl).origin;
  } catch {
    return false;
  }
}

export function isRetryableDevelopmentRendererLoadFailure(input: {
  readonly applicationUrl: string;
  readonly errorCode: number;
  readonly isMainFrame: boolean;
  readonly validatedUrl: string;
}): boolean {
  return (
    input.isMainFrame &&
    DEVELOPMENT_RETRYABLE_LOAD_ERROR_CODES.has(input.errorCode) &&
    isSameOriginRendererNavigation({
      applicationUrl: input.applicationUrl,
      navigationUrl: input.validatedUrl,
    })
  );
}

export function concealPendingQuitWindow(
  window: Pick<
    Electron.BrowserWindow,
    "isDestroyed" | "isFullScreen" | "setFullScreen" | "setOpacity"
  >,
): void {
  if (window.isDestroyed()) return;
  if (window.isFullScreen()) {
    window.setFullScreen(false);
  }
  // Electron implements window opacity on macOS and Windows. Linux keeps the
  // release-gated quit behavior but cannot make the pending window disappear.
  window.setOpacity(0);
}

function getWindowTitleBarOptions(
  shouldUseDarkColors: boolean,
  platform: NodeJS.Platform,
): WindowTitleBarOptions {
  if (platform === "darwin") {
    return {
      titleBarStyle: "hiddenInset",
      trafficLightPosition: {
        x: 16,
        y: MACOS_WORKSPACE_TOPBAR_HEIGHT / 2 - MACOS_WINDOW_BUTTON_RADIUS,
      },
    };
  }

  return {
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: TITLEBAR_COLOR,
      height: TITLEBAR_HEIGHT,
      symbolColor: shouldUseDarkColors ? TITLEBAR_DARK_SYMBOL_COLOR : TITLEBAR_LIGHT_SYMBOL_COLOR,
    },
  };
}

function syncWindowAppearance(
  window: Electron.BrowserWindow,
  shouldUseDarkColors: boolean,
  platform: NodeJS.Platform,
): Effect.Effect<void> {
  return Effect.sync(() => {
    if (window.isDestroyed()) {
      return;
    }

    window.setBackgroundColor(getInitialWindowBackgroundColor(shouldUseDarkColors));
    const { titleBarOverlay } = getWindowTitleBarOptions(shouldUseDarkColors, platform);
    if (typeof titleBarOverlay === "object") {
      window.setTitleBarOverlay(titleBarOverlay);
    }
  });
}

type RevealSubscription = (listener: () => void) => void;

function bindFirstRevealTrigger(
  subscribers: readonly RevealSubscription[],
  reveal: () => void,
): void {
  let revealed = false;
  const fire = () => {
    if (revealed) return;
    revealed = true;
    reveal();
  };
  for (const subscribe of subscribers) {
    subscribe(fire);
  }
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const assets = yield* DesktopAssets.DesktopAssets;
  const electronMenu = yield* ElectronMenu.ElectronMenu;
  const electronShell = yield* ElectronShell.ElectronShell;
  const electronTheme = yield* ElectronTheme.ElectronTheme;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const previewManager = yield* PreviewManager.PreviewManager;
  const desktopSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
  const electronApp = yield* ElectronApp.ElectronApp;
  // Window-side latch for the primary backend's readiness. Set by
  // handleBackendReady (driven by the pool's onReady callback), cleared
  // by handleBackendNotReady (driven by onShutdown). Only consumed by
  // createMainIfBackendReady, which gates the post-readiness window
  // open in development and the macOS "activate without windows" path.
  const backendReadyRef = yield* Ref.make(false);
  const lastBackendConnectedAtRef = yield* Ref.make<number | null>(null);
  const externalStatusOnMainRef = yield* Ref.make(false);
  const externalServerScreenWindows = new WeakSet<Electron.BrowserWindow>();
  // The transient "Connecting to WSL" splash window, tracked separately so it
  // is never mistaken for the real main window.
  const splashWindowRef = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
  const context = yield* Effect.context<DesktopWindowRuntimeServices>();
  const runFork = Effect.runForkWith(context);
  const runPromise = Effect.runPromiseWith(context);
  let flushMainWindowBounds: Effect.Effect<void> = Effect.void;

  const dismissConnectingSplash = Effect.gen(function* () {
    const splash = yield* Ref.getAndSet(splashWindowRef, Option.none());
    if (Option.isSome(splash) && !splash.value.isDestroyed()) {
      splash.value.close();
    }
  });

  const installExternalServerScreenNavigation = (window: Electron.BrowserWindow) => {
    if (externalServerScreenWindows.has(window)) return;
    externalServerScreenWindows.add(window);
    window.webContents.on("will-navigate", (event, rawUrl) => {
      let url: URL;
      try {
        url = new URL(rawUrl);
      } catch {
        return;
      }
      if (url.protocol !== "ft3server:") return;
      event.preventDefault();
      if (
        (url.hostname === "launch" || url.hostname === "retry") &&
        environment.platform === "win32"
      ) {
        void launchExternalServer().catch((error: unknown) =>
          runPromise(
            logWindowWarning("failed to launch detached ft3 server", {
              message: error instanceof Error ? error.message : String(error),
            }),
          ),
        );
      }
    });
  };

  // currentMainOrFirst / focusedMainOrFirst fall back to "any first window",
  // which during WSL-only boot is the connecting splash. The splash is never
  // registered via setMain, so it must be treated as "no real main window" --
  // otherwise ensureMain/activate/dispatchMenuAction latch onto it and never
  // open (or retry) the real main. That is the failure the pool's swallowed
  // post-readiness window-open error would otherwise strand the user in:
  // splash up, backend ready, no main, and activation only re-reveals splash.
  const withoutSplash = (window: Option.Option<Electron.BrowserWindow>) =>
    Ref.get(splashWindowRef).pipe(
      Effect.map((splash) =>
        Option.isSome(splash) && Option.isSome(window) && window.value === splash.value
          ? Option.none<Electron.BrowserWindow>()
          : window,
      ),
    );

  const currentMainWindow = electronWindow.currentMainOrFirst.pipe(Effect.flatMap(withoutSplash));
  const focusedMainWindow = electronWindow.focusedMainOrFirst.pipe(Effect.flatMap(withoutSplash));

  const createWindow = Effect.fn("desktop.window.createWindow")(function* (): Effect.fn.Return<
    Electron.BrowserWindow,
    DesktopWindowError
  > {
    yield* previewManager.getBrowserSession();
    const applicationUrl = getDesktopUrl(environment.isDevelopment);
    const iconPaths = yield* assets.iconPaths;
    const iconOption = getIconOption(iconPaths, environment.platform);
    const shouldUseDarkColors = yield* electronTheme.shouldUseDarkColors;
    const persistedSettings = yield* desktopSettings.get;
    const persistedBounds = persistedSettings.mainWindowBounds;
    const displayBoundsResult = yield* Effect.sync(() => {
      try {
        return {
          _tag: "Success" as const,
          bounds: Electron.screen.getAllDisplays().map((display) => display.bounds),
        };
      } catch (cause) {
        return { _tag: "Failure" as const, cause };
      }
    });
    const displayBounds =
      displayBoundsResult._tag === "Success"
        ? displayBoundsResult.bounds
        : yield* logWindowWarning("failed to read connected displays; using defaults", {
            cause: displayBoundsResult.cause,
          }).pipe(Effect.as<readonly Electron.Rectangle[]>([]));
    const initialBounds = resolveInitialMainWindowBounds(persistedBounds, displayBounds);
    const restoredPersistedBounds = persistedBounds !== null && initialBounds === persistedBounds;
    if (persistedBounds !== null && initialBounds === DesktopAppSettings.DEFAULT_MAIN_WINDOW_SIZE) {
      yield* logWindowWarning("saved main window bounds could not be restored; using defaults");
    }
    const window = yield* electronWindow.create({
      ...initialBounds,
      minWidth: 840,
      minHeight: 620,
      show: false,
      autoHideMenuBar: true,
      ...(environment.platform === "darwin" ? { disableAutoHideCursor: true } : {}),
      backgroundColor: getInitialWindowBackgroundColor(shouldUseDarkColors),
      ...iconOption,
      title: environment.displayName,
      ...getWindowTitleBarOptions(shouldUseDarkColors, environment.platform),
      webPreferences: {
        preload: environment.preloadPath,
        // The window boots hidden (show: false until ready-to-show), and
        // Chromium throttles hidden renderers: timers coalesce and rAF stops,
        // which stalls first paint. Boot unthrottled; the first-reveal trigger
        // re-enables throttling so a hidden or minimized window goes back to
        // being cheap after it has been shown once.
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: true,
      },
    });

    if (environment.platform === "darwin") {
      window.setAutoHideCursor(false);
    }
    let boundsPersistFiber: Fiber.Fiber<void, never> | undefined;
    let pendingBoundsPersistFiber: Fiber.Fiber<void, never> | undefined;
    let boundsPersistenceEnabled = persistedBounds === null || restoredPersistedBounds;
    const readPersistableBounds = (): DesktopAppSettings.DesktopWindowBounds | null => {
      if (window.isDestroyed()) {
        return null;
      }
      const bounds =
        window.isFullScreen() || window.isMaximized() || window.isMinimized()
          ? window.getNormalBounds()
          : window.getBounds();
      return DesktopAppSettings.normalizeMainWindowBounds({
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
      });
    };
    const fallbackWindowBounds = boundsPersistenceEnabled ? null : readPersistableBounds();
    const fallbackWindowMaximized = persistedSettings.mainWindowMaximized;
    const persistCurrentBounds = (): Fiber.Fiber<void, never> | undefined => {
      if (!boundsPersistenceEnabled) {
        return pendingBoundsPersistFiber;
      }
      const bounds = readPersistableBounds();
      if (bounds === null) {
        return pendingBoundsPersistFiber;
      }
      pendingBoundsPersistFiber = runFork(
        desktopSettings.setMainWindowBounds(bounds, window.isMaximized()).pipe(
          Effect.asVoid,
          Effect.catch((error) =>
            logWindowWarning("failed to persist main window bounds", {
              message: error.message,
            }),
          ),
        ),
      );
      return pendingBoundsPersistFiber;
    };
    const scheduleBoundsPersist = () => {
      if (!boundsPersistenceEnabled) {
        const currentBounds = readPersistableBounds();
        if (
          currentBounds === null ||
          (fallbackWindowBounds !== null &&
            windowBoundsEqual(currentBounds, fallbackWindowBounds) &&
            window.isMaximized() === fallbackWindowMaximized)
        ) {
          return;
        }
      }
      boundsPersistenceEnabled = true;
      if (boundsPersistFiber !== undefined) {
        const fiber = boundsPersistFiber;
        boundsPersistFiber = undefined;
        runFork(Fiber.interrupt(fiber));
      }
      boundsPersistFiber = runFork(
        Effect.sleep(MAIN_WINDOW_BOUNDS_PERSIST_DEBOUNCE_MS).pipe(
          Effect.andThen(
            Effect.sync(() => {
              boundsPersistFiber = undefined;
              void persistCurrentBounds();
            }),
          ),
        ),
      );
    };
    const clearBoundsPersist = () => {
      if (boundsPersistFiber === undefined) {
        return;
      }
      const fiber = boundsPersistFiber;
      boundsPersistFiber = undefined;
      runFork(Fiber.interrupt(fiber));
    };
    const flushBoundsPersist = Effect.sync(() => {
      clearBoundsPersist();
      return persistCurrentBounds();
    }).pipe(
      Effect.flatMap((fiber) =>
        fiber === undefined ? Effect.void : Fiber.join(fiber).pipe(Effect.asVoid),
      ),
    );
    flushMainWindowBounds = flushBoundsPersist;

    yield* previewManager.setMainWindow(window);
    const windowHealthLogPath = environment.path.join(
      environment.logDir,
      "desktop-window-health.ndjson",
    );
    // @effect-diagnostics globalDateInEffect:off preferSchemaOverJson:off -- Write timestamped JSONL synchronously before logging.
    const persistWindowDiagnostic = (
      level: "INFO" | "WARN",
      message: string,
      annotations: Record<string, unknown> = {},
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const timestamp = new Date().toISOString();
        const line = `${JSON.stringify({ timestamp, level, message, pid: process.pid, ...annotations })}\n`;
        const saved = yield* Effect.sync(() => {
          try {
            NodeFs.mkdirSync(environment.logDir, { recursive: true });
            if (
              NodeFs.existsSync(windowHealthLogPath) &&
              NodeFs.statSync(windowHealthLogPath).size + Buffer.byteLength(line) >
                WINDOW_HEALTH_LOG_MAX_BYTES
            ) {
              NodeFs.rmSync(`${windowHealthLogPath}.${WINDOW_HEALTH_LOG_BACKUP_COUNT}`, {
                force: true,
              });
              for (let index = WINDOW_HEALTH_LOG_BACKUP_COUNT - 1; index >= 1; index -= 1) {
                const source = `${windowHealthLogPath}.${index}`;
                if (NodeFs.existsSync(source)) {
                  NodeFs.renameSync(source, `${windowHealthLogPath}.${index + 1}`);
                }
              }
              NodeFs.renameSync(windowHealthLogPath, `${windowHealthLogPath}.1`);
            }
            NodeFs.appendFileSync(windowHealthLogPath, line, "utf8");
            return true;
          } catch {
            return false;
          }
        });
        if (!saved) {
          yield* logWindowWarning("failed to persist desktop window diagnostic", {
            message,
            logPath: windowHealthLogPath,
          });
          return;
        }
        yield* (level === "WARN" ? logWindowWarning : logWindowInfo)(message, {
          ...annotations,
          timestamp,
        });
      });
    window.webContents.on("will-attach-webview", (event, webPreferences, params) => {
      if (
        typeof params.partition !== "string" ||
        !previewManager.isBrowserPartition(params.partition)
      ) {
        event.preventDefault();
        return;
      }
      webPreferences.sandbox = true;
      webPreferences.nodeIntegration = false;
      webPreferences.nodeIntegrationInSubFrames = false;
      webPreferences.contextIsolation = false;
    });

    const contextMenuContents = new WeakSet<Electron.WebContents>();
    const installContextMenu = (
      ownerWindow: Electron.BrowserWindow,
      contents: Electron.WebContents,
    ): void => {
      if (contextMenuContents.has(contents)) return;
      contextMenuContents.add(contents);
      contents.on("context-menu", (event, params) => {
        event.preventDefault();
        if (contents.isDestroyed() || ownerWindow.isDestroyed()) return;
        // Native editing roles act on the focused contents, which may still be
        // the host renderer when the user right-clicks inside a browser guest.
        contents.focus();

        const menuTemplate: Electron.MenuItemConstructorOptions[] = [];

        if (params.misspelledWord) {
          for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
            menuTemplate.push({
              label: suggestion,
              click: () => {
                if (!contents.isDestroyed()) contents.replaceMisspelling(suggestion);
              },
            });
          }
          if (params.dictionarySuggestions.length === 0) {
            menuTemplate.push({ label: "No suggestions", enabled: false });
          }
          menuTemplate.push({ type: "separator" });
        }

        if (Option.isSome(ElectronShell.parseSafeExternalUrl(params.linkURL))) {
          menuTemplate.push(
            {
              label: "Copy Link",
              click: () => {
                void runPromise(electronShell.copyText(params.linkURL));
              },
            },
            { type: "separator" },
          );
        }

        if (params.mediaType === "image") {
          menuTemplate.push({
            label: "Copy Image",
            click: () => {
              if (!contents.isDestroyed()) contents.copyImageAt(params.x, params.y);
            },
          });
          menuTemplate.push({ type: "separator" });
        }

        menuTemplate.push(
          { role: "cut", enabled: params.editFlags.canCut },
          { role: "copy", enabled: params.editFlags.canCopy },
          { role: "paste", enabled: params.editFlags.canPaste },
          { role: "selectAll", enabled: params.editFlags.canSelectAll },
        );

        void runPromise(
          electronMenu.popupTemplate({
            window: ownerWindow,
            template: menuTemplate,
            ...(params.frame ? { frame: params.frame } : {}),
          }),
        );
      });
      contents.on("did-create-window", (popup) => {
        installContextMenu(popup, popup.webContents);
      });
    };
    installContextMenu(window, window.webContents);
    window.webContents.on("did-attach-webview", (_event, contents) => {
      installContextMenu(window, contents);
    });

    yield* persistWindowDiagnostic("INFO", "GPU feature status", {
      ...Electron.app.getGPUFeatureStatus(),
    });
    let lastHeartbeatAt = NodePerformance.performance.now();
    let heartbeatMissStartedAt: number | undefined;
    let unresponsiveStartedAt: number | undefined;
    const onHeartbeat = (event: Electron.IpcMainEvent) => {
      if (event.sender !== window.webContents) return;
      const now = NodePerformance.performance.now();
      if (heartbeatMissStartedAt !== undefined) {
        void runPromise(
          persistWindowDiagnostic("INFO", "renderer heartbeat resumed", {
            missedForMs: now - heartbeatMissStartedAt,
          }),
        );
        heartbeatMissStartedAt = undefined;
      }
      lastHeartbeatAt = now;
    };
    const heartbeatFiber = runFork(
      Effect.forever(
        Effect.sleep(5_000).pipe(
          Effect.andThen(
            Effect.sync(() => {
              const missedForMs = Math.round(NodePerformance.performance.now() - lastHeartbeatAt);
              if (heartbeatMissStartedAt !== undefined || missedForMs <= 10_000) return;
              heartbeatMissStartedAt = lastHeartbeatAt;
              void runPromise(
                persistWindowDiagnostic("WARN", "renderer heartbeat missed", {
                  missedForMs,
                  thresholdMs: 10_000,
                }),
              );
            }),
          ),
        ),
      ),
    );
    Electron.ipcMain.on(RENDERER_HEARTBEAT_CHANNEL, onHeartbeat);
    const onChildProcessGone = (_event: Electron.Event, details: Electron.Details) => {
      void runPromise(
        persistWindowDiagnostic("WARN", "application child process gone", {
          type: details.type,
          reason: details.reason,
          exitCode: details.exitCode,
          gpuPriority: details.type === "GPU",
        }),
      );
    };
    const onSuspend = () =>
      void runPromise(persistWindowDiagnostic("INFO", "power state changed", { state: "suspend" }));
    const onResume = () =>
      void runPromise(persistWindowDiagnostic("INFO", "power state changed", { state: "resume" }));
    const onLock = () =>
      void runPromise(persistWindowDiagnostic("INFO", "power state changed", { state: "lock" }));
    const onUnlock = () =>
      void runPromise(persistWindowDiagnostic("INFO", "power state changed", { state: "unlock" }));
    const onDisplayAdded = (_event: Electron.Event, display: Electron.Display) =>
      void runPromise(
        persistWindowDiagnostic("INFO", "display changed", {
          change: "added",
          displayId: display.id,
        }),
      );
    const onDisplayRemoved = (_event: Electron.Event, display: Electron.Display) =>
      void runPromise(
        persistWindowDiagnostic("INFO", "display changed", {
          change: "removed",
          displayId: display.id,
        }),
      );
    const onDisplayMetricsChanged = (
      _event: Electron.Event,
      display: Electron.Display,
      changedMetrics: string[],
    ) =>
      void runPromise(
        persistWindowDiagnostic("INFO", "display changed", {
          change: "metrics",
          displayId: display.id,
          changedMetrics,
        }),
      );
    Electron.app.on("child-process-gone", onChildProcessGone);
    Electron.powerMonitor.on("suspend", onSuspend);
    Electron.powerMonitor.on("resume", onResume);
    Electron.powerMonitor.on("lock-screen", onLock);
    Electron.powerMonitor.on("unlock-screen", onUnlock);
    Electron.screen.on("display-added", onDisplayAdded);
    Electron.screen.on("display-removed", onDisplayRemoved);
    Electron.screen.on("display-metrics-changed", onDisplayMetricsChanged);
    const resourceSnapshotFiber = runFork(
      Effect.forever(
        Effect.sleep(60_000).pipe(
          Effect.andThen(
            Effect.sync(() => {
              if (window.isDestroyed()) return;
              const processMetrics = Electron.app.getAppMetrics().map((metric) => ({
                type: metric.type,
                pid: metric.pid,
                cpuPercent: metric.cpu.percentCPUUsage,
                workingSetSizeKb: metric.memory.workingSetSize,
              }));
              void runPromise(
                persistWindowDiagnostic("INFO", "desktop resource snapshot", {
                  mainMemoryBytes: process.memoryUsage().rss,
                  rendererMemory: processMetrics.filter((metric) => metric.type === "Tab"),
                  gpuMemory: processMetrics.filter((metric) => metric.type === "GPU"),
                  processes: processMetrics,
                }),
              );
            }),
          ),
        ),
      ),
    );

    window.webContents.on("unresponsive", () => {
      unresponsiveStartedAt ??= NodePerformance.performance.now();
      void runPromise(persistWindowDiagnostic("WARN", "renderer became unresponsive"));
    });
    window.webContents.on("responsive", () => {
      const startedAt = unresponsiveStartedAt;
      unresponsiveStartedAt = undefined;
      void runPromise(
        persistWindowDiagnostic("INFO", "renderer became responsive", {
          durationMs:
            startedAt === undefined
              ? null
              : Math.round(NodePerformance.performance.now() - startedAt),
        }),
      );
    });
    window.on(
      "show",
      () =>
        void runPromise(
          persistWindowDiagnostic("INFO", "main window visibility", { state: "show" }),
        ),
    );
    window.on(
      "hide",
      () =>
        void runPromise(
          persistWindowDiagnostic("INFO", "main window visibility", { state: "hide" }),
        ),
    );
    window.on(
      "minimize",
      () =>
        void runPromise(
          persistWindowDiagnostic("INFO", "main window visibility", { state: "minimize" }),
        ),
    );
    window.on(
      "restore",
      () =>
        void runPromise(
          persistWindowDiagnostic("INFO", "main window visibility", { state: "restore" }),
        ),
    );

    window.webContents.setWindowOpenHandler(({ url }) => {
      if (Option.isSome(ElectronShell.parseSafeExternalUrl(url))) {
        void runPromise(electronShell.openExternal(url));
      }
      return { action: "deny" };
    });
    window.webContents.on("will-navigate", (event, url) => {
      if (
        isSameOriginRendererNavigation({
          applicationUrl,
          navigationUrl: url,
        })
      ) {
        return;
      }

      event.preventDefault();
      if (Option.isSome(ElectronShell.parseSafeExternalUrl(url))) {
        void runPromise(electronShell.openExternal(url));
      }
    });

    // Electron's windowMenu close role owns CmdOrCtrl+W. Holding the
    // close-terminal shortcut can outlive the terminal that handled its first
    // press, so reject repeats before they reach the native window accelerator.
    // Deliberate presses still flow through the renderer or native menu.
    // Intercept the quit accelerator before the native menu sees it and apply
    // the configured direct, hold, or double-press behavior.
    const quitShortcutHandler = makeQuitShortcutHandler({
      platform: environment.platform,
      getMode: () =>
        runPromise(
          Effect.map(
            clientSettings.get,
            Option.match({
              onNone: () => DEFAULT_CLIENT_SETTINGS.confirmQuit,
              onSome: (settings) => settings.confirmQuit,
            }),
          ),
        ),
      notify: (hint) => {
        if (!window.isDestroyed()) {
          window.webContents.send(QUIT_SHORTCUT_CHANNEL, hint);
        }
      },
      // Keep the transparent window focused until the physical shortcut is
      // released so its remaining repeats cannot reach the next app.
      concealWindow: () => concealPendingQuitWindow(window),
      quit: () => {
        void runPromise(electronApp.quit);
      },
    });
    window.webContents.on("before-input-event", (event, input) => {
      quitShortcutHandler(event, input);
      if (input.type !== "keyDown" || !input.isAutoRepeat) return;
      const modifier = environment.platform === "darwin" ? input.meta : input.control;
      if (modifier && !input.alt && !input.shift && input.key.toLowerCase() === "w") {
        event.preventDefault();
      }
    });

    window.on("page-title-updated", (event) => {
      event.preventDefault();
      window.setTitle(environment.displayName);
    });
    window.on("resize", scheduleBoundsPersist);
    window.on("move", scheduleBoundsPersist);
    window.on("maximize", scheduleBoundsPersist);
    window.on("unmaximize", scheduleBoundsPersist);
    window.on("close", () => {
      runFork(flushBoundsPersist);
    });

    if (environment.platform === "darwin") {
      window.on("enter-full-screen", () => {
        window.webContents.send(WINDOW_FULLSCREEN_STATE_CHANNEL, true);
      });
      window.on("leave-full-screen", () => {
        syncMacosWindowButtons(window);
        window.webContents.send(WINDOW_FULLSCREEN_STATE_CHANNEL, false);
      });
    }

    let developmentLoadRetryIndex = 0;
    let developmentLoadRetryFiber: Fiber.Fiber<void, never> | undefined;
    let rendererRecoveryTimestamps: number[] = [];
    const clearDevelopmentLoadRetry = () => {
      if (developmentLoadRetryFiber === undefined) {
        return;
      }
      const retryFiber = developmentLoadRetryFiber;
      developmentLoadRetryFiber = undefined;
      runFork(Fiber.interrupt(retryFiber));
    };
    const loadApplication = () => {
      if (window.isDestroyed()) {
        return;
      }
      void window.loadURL(applicationUrl).catch(() => undefined);
    };
    const scheduleDevelopmentLoadRetry = () => {
      if (developmentLoadRetryFiber !== undefined || window.isDestroyed()) {
        return undefined;
      }

      const retryIndex = Math.min(
        developmentLoadRetryIndex,
        DEVELOPMENT_LOAD_RETRY_DELAYS_MS.length - 1,
      );
      const retryInMs = DEVELOPMENT_LOAD_RETRY_DELAYS_MS[retryIndex] ?? 2_000;
      developmentLoadRetryIndex += 1;
      developmentLoadRetryFiber = runFork(
        Effect.sleep(retryInMs).pipe(
          Effect.andThen(
            Effect.sync(() => {
              developmentLoadRetryFiber = undefined;
              if (!window.isDestroyed()) {
                loadApplication();
              }
            }),
          ),
        ),
      );
      return retryInMs;
    };

    window.webContents.on("did-finish-load", () => {
      if (DesktopExternalBackend.isExternalServerMode()) {
        runPromise(
          Effect.gen(function* () {
            if (
              !(yield* Ref.get(backendReadyRef)) &&
              (yield* Ref.get(lastBackendConnectedAtRef)) !== null &&
              !window.isDestroyed()
            ) {
              window.webContents.send(EXTERNAL_BACKEND_AVAILABILITY_CHANNEL, false);
            }
          }),
        );
      }
      if (
        environment.isDevelopment &&
        !isSameOriginRendererNavigation({
          applicationUrl,
          navigationUrl: window.webContents.getURL(),
        })
      ) {
        return;
      }
      clearDevelopmentLoadRetry();
      developmentLoadRetryIndex = 0;
      window.setTitle(environment.displayName);
      if (environment.platform === "darwin") syncMacosWindowButtons(window);
    });
    window.webContents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame) {
          return;
        }
        const retryInMs =
          environment.isDevelopment &&
          isRetryableDevelopmentRendererLoadFailure({
            applicationUrl,
            errorCode,
            isMainFrame,
            validatedUrl: validatedURL,
          })
            ? scheduleDevelopmentLoadRetry()
            : undefined;
        void runPromise(
          persistWindowDiagnostic("WARN", "main window failed to load", {
            errorCode,
            errorDescription,
            url: validatedURL,
            ...(retryInMs === undefined ? {} : { retryInMs }),
          }),
        );
      },
    );
    window.webContents.on("render-process-gone", (_event, details) => {
      const recoverable =
        details.reason === "crashed" ||
        details.reason === "oom" ||
        details.reason === "abnormal-exit";
      // Long sessions can OOM the renderer (V8 heap exhaustion from
      // accumulated thread state). Without a reload the user is left staring
      // at a dead white window while agents keep running invisibly, so
      // recover by reloading — the renderer rehydrates from the backend,
      // which is unaffected. Recovery attempts are bounded so a renderer
      // that dies immediately on boot cannot reload-loop forever.
      runFork(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          rendererRecoveryTimestamps = rendererRecoveryTimestamps.filter(
            (timestamp) => now - timestamp < RENDERER_RECOVERY_WINDOW_MS,
          );
          const shouldRecover =
            recoverable &&
            !window.isDestroyed() &&
            rendererRecoveryTimestamps.length < RENDERER_RECOVERY_MAX_ATTEMPTS;
          yield* persistWindowDiagnostic("WARN", "main window render process gone", {
            reason: details.reason,
            exitCode: details.exitCode,
            recovering: shouldRecover,
          });
          if (!shouldRecover) {
            return;
          }
          rendererRecoveryTimestamps.push(now);
          yield* Effect.sleep(RENDERER_RECOVERY_RELOAD_DELAY_MS);
          if (!window.isDestroyed()) {
            loadApplication();
          }
        }),
      );
    });

    const revealSubscribers: RevealSubscription[] = [(fire) => window.once("ready-to-show", fire)];
    if (environment.platform === "linux") {
      revealSubscribers.push((fire) => window.webContents.once("did-finish-load", fire));
    }
    bindFirstRevealTrigger(revealSubscribers, () => {
      // Boot is done; hand the window back to normal hidden-window throttling
      // (see the backgroundThrottling comment on the create options above).
      if (!window.isDestroyed()) {
        window.webContents.setBackgroundThrottling(true);
      }
      // Reveal the real window, then close the connecting splash (if any) so the
      // two don't overlap and there's no blank gap between them.
      if (persistedSettings.mainWindowMaximized) {
        window.maximize();
      }
      void runPromise(Effect.andThen(electronWindow.reveal(window), dismissConnectingSplash));
    });

    loadApplication();
    if (environment.isDevelopment) {
      window.webContents.openDevTools({ mode: "detach" });
    }

    window.on("closed", () => {
      runFork(Fiber.interrupt(heartbeatFiber));
      runFork(Fiber.interrupt(resourceSnapshotFiber));
      Electron.ipcMain.removeListener(RENDERER_HEARTBEAT_CHANNEL, onHeartbeat);
      Electron.app.removeListener("child-process-gone", onChildProcessGone);
      Electron.powerMonitor.removeListener("suspend", onSuspend);
      Electron.powerMonitor.removeListener("resume", onResume);
      Electron.powerMonitor.removeListener("lock-screen", onLock);
      Electron.powerMonitor.removeListener("unlock-screen", onUnlock);
      Electron.screen.removeListener("display-added", onDisplayAdded);
      Electron.screen.removeListener("display-removed", onDisplayRemoved);
      Electron.screen.removeListener("display-metrics-changed", onDisplayMetricsChanged);
      clearDevelopmentLoadRetry();
      clearBoundsPersist();
      void runPromise(electronWindow.clearMain(Option.some(window)));
    });

    return window;
  });

  const createMain = Effect.gen(function* () {
    const window = yield* createWindow();
    if (DesktopExternalBackend.isExternalServerMode())
      installExternalServerScreenNavigation(window);
    yield* electronWindow.setMain(window);
    yield* logWindowInfo("main window created");
    return window;
  }).pipe(Effect.withSpan("desktop.window.createMain"));

  const ensureMain = Effect.gen(function* () {
    const existingWindow = yield* currentMainWindow;
    if (Option.isSome(existingWindow)) {
      return existingWindow.value;
    }
    return yield* createMain;
  }).pipe(Effect.withSpan("desktop.window.ensureMain"));

  const revealOrCreateMain = Effect.gen(function* () {
    const window = yield* ensureMain;
    yield* electronWindow.reveal(window);
    return window;
  }).pipe(Effect.withSpan("desktop.window.revealOrCreateMain"));

  // With the local environment disabled there is no backend to wait for: the
  // renderer is served from bundled assets and only talks to remote environments.
  const waitingForBackend = Effect.gen(function* () {
    if (yield* Ref.get(backendReadyRef)) return false;
    return (yield* desktopSettings.get).localEnvironmentEnabled;
  });

  const createMainIfBackendReady = Effect.gen(function* () {
    if (yield* waitingForBackend) return;
    const existingWindow = yield* currentMainWindow;
    if (Option.isSome(existingWindow)) return;
    yield* createMain;
  }).pipe(Effect.withSpan("desktop.window.createMainIfBackendReady"));

  const showConnectingSplash = Effect.gen(function* () {
    // Only when nothing is shown yet: no real window, no existing splash.
    const existingSplash = yield* Ref.get(splashWindowRef);
    if (Option.isSome(existingSplash)) return;
    const existingWindow = yield* electronWindow.currentMainOrFirst;
    if (Option.isSome(existingWindow)) return;

    const shouldUseDarkColors = yield* electronTheme.shouldUseDarkColors;
    const splash = yield* electronWindow.create({
      width: 360,
      height: 220,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      frame: false,
      center: true,
      show: false,
      skipTaskbar: false,
      backgroundColor: getInitialWindowBackgroundColor(shouldUseDarkColors),
      title: environment.displayName,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    yield* Ref.set(splashWindowRef, Option.some(splash));
    splash.once("closed", () => {
      void runPromise(Ref.set(splashWindowRef, Option.none()));
    });
    splash.once("ready-to-show", () => {
      if (!splash.isDestroyed()) {
        splash.show();
      }
    });
    void splash.loadURL(buildConnectingSplashDataUrl(shouldUseDarkColors));
    yield* logWindowInfo("connecting splash shown");
  }).pipe(
    // The splash is best-effort UX — never let it fail startup.
    Effect.catch((error) =>
      logWindowWarning("failed to show connecting splash", { message: error.message }),
    ),
    Effect.withSpan("desktop.window.showConnectingSplash"),
  );

  const showExternalServerUnavailable = Effect.gen(function* () {
    if (!DesktopExternalBackend.isExternalServerMode()) return;
    const main = yield* currentMainWindow;
    const lastConnectedAt = yield* Ref.get(lastBackendConnectedAtRef);
    const dark = yield* electronTheme.shouldUseDarkColors;
    const page = buildExternalServerUnavailableDataUrl(dark, lastConnectedAt);
    if (Option.isSome(main)) {
      yield* Ref.set(externalStatusOnMainRef, true);
      void main.value.loadURL(page);
      yield* electronWindow.reveal(main.value);
      installExternalServerScreenNavigation(main.value);
      return;
    }
    const existingSplash = yield* Ref.get(splashWindowRef);
    if (Option.isSome(existingSplash)) {
      void existingSplash.value.loadURL(page);
      installExternalServerScreenNavigation(existingSplash.value);
      return;
    }
    const screen = yield* electronWindow.create({
      width: 520,
      height: 300,
      resizable: false,
      center: true,
      show: false,
      skipTaskbar: false,
      backgroundColor: getInitialWindowBackgroundColor(dark),
      title: environment.displayName,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    yield* Ref.set(splashWindowRef, Option.some(screen));
    installExternalServerScreenNavigation(screen);
    screen.once("closed", () => void runPromise(Ref.set(splashWindowRef, Option.none())));
    screen.once("ready-to-show", () => {
      if (!screen.isDestroyed()) screen.show();
    });
    void screen.loadURL(page);
  }).pipe(
    Effect.catch((error) =>
      logWindowWarning("failed to show external server screen", { message: error.message }),
    ),
  );

  const dispatchRendererEvent = Effect.fn("desktop.window.dispatchRendererEvent")(function* (
    channel: string,
    payload: unknown,
    { reveal = true }: { readonly reveal?: boolean } = {},
  ) {
    const existingWindow = yield* reveal ? focusedMainWindow : electronWindow.main;
    if (Option.isNone(existingWindow) && (!reveal || (yield* waitingForBackend))) return;
    const targetWindow = Option.isSome(existingWindow) ? existingWindow.value : yield* ensureMain;
    if (targetWindow.isDestroyed()) return;
    const send = Effect.sync(() => {
      if (!targetWindow.isDestroyed()) targetWindow.webContents.send(channel, payload);
    });
    // The renderer must learn about the event even when another process refuses to
    // yield the foreground, so send first and treat the reveal as best effort.
    const dispatch = reveal
      ? send.pipe(Effect.andThen(electronWindow.reveal(targetWindow).pipe(Effect.ignoreCause)))
      : send;
    if (targetWindow.webContents.isLoadingMainFrame()) {
      targetWindow.webContents.once("did-finish-load", () => void runPromise(dispatch));
      return;
    }
    yield* dispatch;
  });

  return DesktopWindow.of({
    createMain,
    ensureMain,
    revealOrCreateMain,
    prepareCaptureReveal: Effect.gen(function* () {
      const existingWindow = yield* currentMainWindow;
      if (Option.isSome(existingWindow)) {
        yield* electronWindow.prepareReveal(existingWindow.value);
      }
    }),
    activate: Effect.gen(function* () {
      const existingWindow = yield* currentMainWindow;
      if (Option.isSome(existingWindow)) {
        yield* electronWindow.reveal(existingWindow.value);
        return;
      }
      // No real main window yet. While the backend is still cold-booting,
      // re-reveal the connecting splash so taskbar/dock activation brings it
      // back instead of doing nothing. Once the backend is ready we fall
      // through to (re)create the real main -- including retrying a previously
      // failed open the pool swallowed -- rather than latching onto the splash.
      const backendReady = yield* Ref.get(backendReadyRef);
      if (!backendReady) {
        const splash = yield* Ref.get(splashWindowRef);
        if (Option.isSome(splash)) {
          yield* electronWindow.reveal(splash.value);
          return;
        }
      }
      yield* createMainIfBackendReady;
    }).pipe(Effect.withSpan("desktop.window.activate")),
    createMainIfBackendReady,
    showConnectingSplash,
    showExternalServerUnavailable,
    handleBackendReady: Effect.fn("desktop.window.handleBackendReady")(function* (httpBaseUrl) {
      const wasPreviouslyConnected = (yield* Ref.get(lastBackendConnectedAtRef)) !== null;
      yield* Ref.set(backendReadyRef, true);
      yield* Ref.set(lastBackendConnectedAtRef, Date.now());
      yield* logWindowInfo("backend ready", { source: "http", url: httpBaseUrl.href });
      if (DesktopExternalBackend.isExternalServerMode()) {
        const main = yield* currentMainWindow;
        if (Option.isSome(main) && (yield* Ref.get(externalStatusOnMainRef))) {
          yield* Ref.set(externalStatusOnMainRef, false);
          void main.value.loadURL(getDesktopUrl(environment.isDevelopment));
          yield* electronWindow.reveal(main.value);
          return;
        }
        if (wasPreviouslyConnected && Option.isSome(main) && !main.value.isDestroyed()) {
          main.value.webContents.send(EXTERNAL_BACKEND_AVAILABILITY_CHANNEL, true);
        }
      }
      yield* createMainIfBackendReady;
      yield* dismissConnectingSplash;
    }),
    handleBackendNotReady: Effect.gen(function* () {
      yield* Ref.set(backendReadyRef, false);
      if (!DesktopExternalBackend.isExternalServerMode()) return;
      if ((yield* Ref.get(lastBackendConnectedAtRef)) === null) {
        yield* showExternalServerUnavailable;
        return;
      }
      const main = yield* currentMainWindow;
      if (Option.isSome(main) && !main.value.isDestroyed()) {
        main.value.webContents.send(EXTERNAL_BACKEND_AVAILABILITY_CHANNEL, false);
      }
    }).pipe(Effect.withSpan("desktop.window.handleBackendNotReady")),
    flushMainWindowBounds: Effect.suspend(() => flushMainWindowBounds).pipe(
      Effect.withSpan("desktop.window.flushMainWindowBounds"),
    ),
    dispatchMenuAction: Effect.fn("desktop.window.dispatchMenuAction")(function* (action, options) {
      yield* Effect.annotateCurrentSpan({ action });
      yield* dispatchRendererEvent(MENU_ACTION_CHANNEL, action, options);
    }),
    dispatchSnapShotEvent: Effect.fn("desktop.window.dispatchSnapShotEvent")(function* (event) {
      yield* Effect.annotateCurrentSpan({
        event: event.type,
        captureId: "id" in event ? (event.id ?? null) : null,
      });
      yield* dispatchRendererEvent(SNAP_SHOT_EVENT_CHANNEL, event, {
        reveal: event.type === "started",
      });
    }),
    zoomMain: Effect.fn("desktop.window.zoomMain")(function* (direction) {
      yield* Effect.annotateCurrentSpan({ direction });
      const window = yield* focusedMainWindow;
      if (Option.isNone(window) || window.value.isDestroyed()) {
        return;
      }
      const webContents = window.value.webContents;
      // Same step size as the Electron zoomIn/zoomOut menu roles.
      webContents.setZoomLevel(
        direction === "reset" ? 0 : webContents.getZoomLevel() + (direction === "in" ? 0.5 : -0.5),
      );
      if (environment.platform === "darwin") syncMacosWindowButtons(window.value);
      // Chromium pushes the new level down to embedded guests, which would zoom
      // the previewed page along with the app UI. The preview browser keeps its
      // own zoom, so put each guest back where the preview left it.
      yield* previewManager.reapplyZoom();
    }),
    syncAppearance: Effect.gen(function* () {
      const shouldUseDarkColors = yield* electronTheme.shouldUseDarkColors;
      yield* electronWindow.syncAllAppearance((window) =>
        syncWindowAppearance(window, shouldUseDarkColors, environment.platform),
      );
    }).pipe(Effect.withSpan("desktop.window.syncAppearance")),
  });
});

export const layer = Layer.effect(DesktopWindow, make);
