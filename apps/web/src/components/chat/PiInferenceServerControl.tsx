import type {
  EnvironmentId,
  PiInferenceServerStatus,
  PiSettings as PiSettingsType,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { PiSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { CircleIcon, FolderOpenIcon, PowerIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import { isElectron } from "../../env";
import { ensureLocalApi } from "../../localApi";
import { useEnvironment } from "../../state/environments";
import { ComposerControl, ComposerControlIcon } from "./ComposerControl";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { formatEnvironmentQueryError } from "../../state/query";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import {
  piInferenceServerCanStop,
  piInferenceServerControlVisible,
  diffPiSettings,
  piInferenceServerPendingRestart,
  piInferenceServerReadyRefreshKey,
  piInferenceServerStatusLabel,
  piInferenceServerTone,
  applyPiBonsaiPresetToSettings,
  hasUsablePiInferenceProfile,
  isPiBonsai27BModel,
  piInferenceProfileForModel,
  resolvePiBonsaiFolderPickerTarget,
} from "./PiInferenceServerControl.logic";

const decodePiSettings = Schema.decodeSync(PiSettings);

export function PiInferenceServerControl(props: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly threadId: ThreadId | null;
  readonly model: string;
  readonly size?: "sm" | "xs";
}) {
  const environment = useEnvironment(props.environmentId);
  const folderPickerTargetEnvironmentId = resolvePiBonsaiFolderPickerTarget(
    isElectron,
    environment?.entry.target ?? null,
  );
  const getStatus = useAtomCommand(serverEnvironment.piInferenceServerStatus, {
    reportFailure: false,
  });
  const startServer = useAtomCommand(serverEnvironment.startPiInferenceServer, {
    reportFailure: false,
  });
  const stopServer = useAtomCommand(serverEnvironment.stopPiInferenceServer, {
    reportFailure: false,
  });
  const detectBonsaiPreset = useAtomCommand(serverEnvironment.detectPiBonsaiPreset, {
    reportFailure: false,
  });
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const providerInstances = useEnvironmentSettings(
    props.environmentId,
    (settings) => settings.providerInstances,
  );
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [status, setStatus] = useState<PiInferenceServerStatus | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<"start" | "stop" | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState<PiSettingsType | null>(null);
  const [settingsBase, setSettingsBase] = useState<PiSettingsType | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [bonsaiPresetState, setBonsaiPresetState] = useState<
    "idle" | "checking" | "saved" | "detected" | "missing" | "error"
  >("idle");
  const [bonsaiPresetError, setBonsaiPresetError] = useState<string | null>(null);
  const [choosingBonsaiFolder, setChoosingBonsaiFolder] = useState(false);
  const bonsaiPresetRequestRef = useRef(0);
  const settingsModelRef = useRef<string | null>(null);
  const pendingActionRef = useRef<"start" | "stop" | null>(null);
  const queryPendingRef = useRef(false);
  const refreshedReadyKeyRef = useRef<string | null>(null);
  const size = props.size ?? "sm";
  const input = useMemo(
    () =>
      props.threadId
        ? { instanceId: props.instanceId, threadId: props.threadId, model: props.model }
        : { instanceId: props.instanceId, model: props.model },
    [props.instanceId, props.model, props.threadId],
  );
  const hintId = useId();
  const savedPiSettings = useMemo(() => {
    const raw = providerInstances[props.instanceId]?.config;
    try {
      return decodePiSettings(raw ?? {});
    } catch {
      return decodePiSettings({});
    }
  }, [providerInstances, props.instanceId]);
  const readyRefreshKey = piInferenceServerReadyRefreshKey(
    status,
    props.environmentId,
    props.instanceId,
  );

  const refreshStatus = useCallback(async () => {
    if (queryPendingRef.current) return;
    queryPendingRef.current = true;
    try {
      const result = await getStatus({ environmentId: props.environmentId, input });
      if (result._tag === "Success") {
        setStatus(result.value);
        setRequestError(null);
      } else {
        setRequestError(formatEnvironmentQueryError(result.cause));
      }
    } catch (cause) {
      setRequestError(
        cause instanceof Error ? cause.message : "Could not read inference server status.",
      );
    } finally {
      queryPendingRef.current = false;
    }
  }, [getStatus, input, props.environmentId]);

  useEffect(() => {
    let active = true;
    const poll = async () => {
      if (!active || queryPendingRef.current) return;
      queryPendingRef.current = true;
      try {
        const result = await getStatus({ environmentId: props.environmentId, input });
        if (!active) return;
        if (result._tag === "Success") {
          setStatus((previous) =>
            previous && JSON.stringify(previous) === JSON.stringify(result.value)
              ? previous
              : result.value,
          );
          setRequestError(null);
        } else {
          setRequestError(formatEnvironmentQueryError(result.cause));
        }
      } catch (cause) {
        if (active) {
          setRequestError(
            cause instanceof Error ? cause.message : "Could not read inference server status.",
          );
        }
      } finally {
        queryPendingRef.current = false;
      }
    };
    void poll();
    const interval = window.setInterval(() => void poll(), 2_500);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [getStatus, input, props.environmentId]);

  useEffect(() => {
    if (readyRefreshKey === null) {
      refreshedReadyKeyRef.current = null;
      return;
    }
    const key = readyRefreshKey;
    if (refreshedReadyKeyRef.current === key) return;
    refreshedReadyKeyRef.current = key;
    void refreshProviders({
      environmentId: props.environmentId,
      input: { instanceId: props.instanceId, refreshModels: true },
    }).then((result) => {
      if (result._tag === "Failure" && refreshedReadyKeyRef.current === key) {
        refreshedReadyKeyRef.current = null;
      }
    });
  }, [props.environmentId, props.instanceId, readyRefreshKey, refreshProviders]);

  const runAction = useCallback(
    async (action: "start" | "stop") => {
      if (pendingActionRef.current !== null) return;
      pendingActionRef.current = action;
      setPendingAction(action);
      setRequestError(null);
      try {
        const command = action === "stop" ? stopServer : startServer;
        const result = await command({ environmentId: props.environmentId, input });
        if (result._tag === "Success") {
          setStatus(result.value);
          if (result.value.error) setRequestError(result.value.error);
        } else {
          setRequestError(formatEnvironmentQueryError(result.cause));
        }
      } catch (cause) {
        setRequestError(
          cause instanceof Error ? cause.message : "Could not control the inference server.",
        );
      } finally {
        pendingActionRef.current = null;
        setPendingAction(null);
        void refreshStatus();
      }
    },
    [input, props.environmentId, refreshStatus, startServer, stopServer],
  );

  if (!piInferenceServerControlVisible(status)) return null;

  const tone = piInferenceServerTone(status);
  const statusLabel = piInferenceServerStatusLabel(status, requestError);
  const isExternal = status?.ready === true && status.owner === "external";
  const processStarting = status?.phase === "starting" && status.owner === "none";
  const canStop = status?.canStop === true;
  const sharedManagedEndpoint = status?.usedByOtherInstances === true;
  const canStopOrphaned =
    Boolean(status?.orphanedManagedEndpoint) && !canStop && !sharedManagedEndpoint;
  const canStopManaged = piInferenceServerCanStop(status);
  const canRetry = status?.phase === "failed" && status.canStart;
  const actionDisabled =
    pendingAction !== null ||
    processStarting ||
    sharedManagedEndpoint ||
    (isExternal && !canStopOrphaned) ||
    (!canStopManaged && status?.canStart !== true);
  const buttonText =
    pendingAction === "start"
      ? "Starting…"
      : pendingAction === "stop"
        ? "Stopping…"
        : isExternal && !canStopOrphaned
          ? "External"
          : processStarting
            ? "Starting…"
            : sharedManagedEndpoint
              ? "In use"
              : canStop
                ? "Stop"
                : canStopOrphaned
                  ? "Stop old"
                  : canRetry
                    ? "Retry"
                    : "Start";
  const failureHint = status?.error ?? requestError;
  const dotClass =
    tone === "ready"
      ? "text-success"
      : tone === "starting"
        ? "text-destructive"
        : "text-muted-foreground";
  const buttonLabel = sharedManagedEndpoint
    ? "This FT3-managed Pi inference server is shared with another Pi instance and cannot be stopped here"
    : canStopOrphaned && !canStop
      ? `Stop the previous FT3-owned Pi inference server at ${status?.orphanedManagedEndpoint}`
      : isExternal
        ? "External Pi inference server is ready; FT3 cannot stop it"
        : canStop
          ? "Stop the FT3-owned Pi inference server"
          : canRetry
            ? "Retry Pi inference server startup"
            : processStarting
              ? "Pi inference server startup is in progress"
              : "Start the Pi inference server";
  const visibleHint =
    failureHint ??
    (sharedManagedEndpoint
      ? "This managed endpoint is also in use by another Pi instance. Stop is disabled until that instance switches endpoints."
      : status?.ready
        ? null
        : status?.progress);
  const visibleHintIsError = failureHint !== null;

  const closeSettings = () => {
    bonsaiPresetRequestRef.current++;
    settingsModelRef.current = null;
    setSettingsOpen(false);
  };

  const saveSettings = async () => {
    if (!settingsDraft) return;
    try {
      decodePiSettings(settingsDraft);
      const current = providerInstances[props.instanceId];
      if (!current || current.driver !== "pi")
        throw new Error("Pi provider settings are unavailable.");
      const changedFields = diffPiSettings(settingsBase ?? savedPiSettings, settingsDraft);
      if (Object.keys(changedFields).length === 0) {
        closeSettings();
        return;
      }
      const result = await updateSettings({
        environmentId: props.environmentId,
        input: {
          patch: {
            piProviderInstanceConfigPatches: {
              [props.instanceId]: changedFields,
            },
          },
        },
      });
      if (result._tag === "Failure") throw new Error(formatEnvironmentQueryError(result.cause));
      closeSettings();
      setSettingsBase(null);
    } catch (cause) {
      setSettingsError(
        cause instanceof Error ? cause.message : "Could not save Pi server settings.",
      );
    }
  };

  const editSettings = () => {
    const model = props.model;
    const base = { ...savedPiSettings };
    settingsModelRef.current = model;
    setSettingsBase(base);
    setSettingsDraft({ ...base });
    setSettingsError(null);
    setBonsaiPresetError(null);
    setSettingsOpen(true);

    if (!isPiBonsai27BModel(model)) {
      setBonsaiPresetState("idle");
      return;
    }
    if (hasUsablePiInferenceProfile(piInferenceProfileForModel(base, model))) {
      setBonsaiPresetState("saved");
      return;
    }

    const requestId = ++bonsaiPresetRequestRef.current;
    setBonsaiPresetState("checking");
    void detectBonsaiPreset({ environmentId: props.environmentId, input: {} })
      .then((result) => {
        if (requestId !== bonsaiPresetRequestRef.current || settingsModelRef.current !== model) {
          return;
        }
        if (result._tag === "Failure") {
          setBonsaiPresetState("error");
          setBonsaiPresetError(formatEnvironmentQueryError(result.cause));
          return;
        }
        if (!result.value) {
          setBonsaiPresetState("missing");
          return;
        }
        if (result.value.model !== "bonsai-2-27b") {
          setBonsaiPresetState("error");
          setBonsaiPresetError("Обнаруженный preset относится к другой модели Bonsai.");
          return;
        }
        const preset = result.value;
        setSettingsDraft((current) =>
          current ? applyPiBonsaiPresetToSettings(current, model, preset) : current,
        );
        setBonsaiPresetState("detected");
      })
      .catch((cause: unknown) => {
        if (requestId !== bonsaiPresetRequestRef.current || settingsModelRef.current !== model) {
          return;
        }
        setBonsaiPresetState("error");
        setBonsaiPresetError(
          cause instanceof Error
            ? cause.message
            : "Не удалось проверить Bonsai-demo на этом компьютере.",
        );
      });
  };

  const chooseBonsaiFolder = async () => {
    const model = settingsModelRef.current;
    if (folderPickerTargetEnvironmentId === null || !model || !isPiBonsai27BModel(model)) {
      return;
    }
    setChoosingBonsaiFolder(true);
    setBonsaiPresetError(null);
    let requestId: number | null = null;
    try {
      const rootPath = await ensureLocalApi().dialogs.pickFolder({
        targetEnvironmentId: folderPickerTargetEnvironmentId,
      });
      if (!rootPath || settingsModelRef.current !== model) return;

      requestId = ++bonsaiPresetRequestRef.current;
      setBonsaiPresetState("checking");
      const result = await detectBonsaiPreset({
        environmentId: props.environmentId,
        input: { rootPath },
      });
      if (requestId !== bonsaiPresetRequestRef.current || settingsModelRef.current !== model) {
        return;
      }
      if (result._tag === "Failure") {
        throw new Error(formatEnvironmentQueryError(result.cause));
      }
      if (!result.value) {
        setBonsaiPresetState("missing");
        setBonsaiPresetError(
          "В этой папке не найдены llama-server и GGUF именно для Bonsai 2 27B. Выберите корень Bonsai-demo с файлами модели 27B.",
        );
        return;
      }
      const verifiedPreset = result.value;
      if (verifiedPreset.model !== "bonsai-2-27b") {
        setBonsaiPresetState("error");
        setBonsaiPresetError("Обнаруженный preset относится к другой модели Bonsai.");
        return;
      }
      setSettingsDraft((current) =>
        current ? applyPiBonsaiPresetToSettings(current, model, verifiedPreset) : current,
      );
      setBonsaiPresetState("detected");
    } catch (cause) {
      if (
        settingsModelRef.current !== model ||
        (requestId !== null && requestId !== bonsaiPresetRequestRef.current)
      ) {
        return;
      }
      setBonsaiPresetState("error");
      setBonsaiPresetError(
        cause instanceof Error
          ? cause.message
          : "Не удалось проверить выбранную папку Bonsai-demo.",
      );
    } finally {
      setChoosingBonsaiFolder(false);
    }
  };

  useEffect(() => {
    if (!settingsOpen || settingsModelRef.current === props.model) return;
    bonsaiPresetRequestRef.current++;
    settingsModelRef.current = null;
    setSettingsOpen(false);
  }, [props.model, settingsOpen]);

  return (
    <div className="flex min-w-0 shrink-0 items-center gap-1" data-pi-inference-server-control>
      <span
        role="img"
        aria-label={`Pi inference server: ${tone}. ${statusLabel}`}
        className="inline-flex shrink-0"
      >
        <CircleIcon
          aria-hidden="true"
          className={`size-3 fill-current ${dotClass}`}
          data-pi-inference-server-tone={tone}
        />
      </span>
      <ComposerControl
        size={size}
        type="button"
        disabled={actionDisabled}
        aria-label={buttonLabel}
        aria-busy={pendingAction !== null || processStarting}
        aria-describedby={visibleHint ? hintId : undefined}
        onClick={() => void runAction(canStopManaged ? "stop" : "start")}
        className="gap-1"
      >
        <ComposerControlIcon icon={PowerIcon} size={size} />
        <span className="sr-only sm:not-sr-only">{buttonText}</span>
      </ComposerControl>
      <ComposerControl
        size={size}
        type="button"
        aria-label="Параметры сервера"
        onClick={editSettings}
      >
        <span className="sr-only sm:not-sr-only">Параметры сервера</span>
      </ComposerControl>
      {piInferenceServerPendingRestart(status) ? (
        <span role="status" className="text-[11px] text-amber-600">
          Нужен перезапуск
        </span>
      ) : null}
      {canStopOrphaned ? (
        <span role="status" className="max-w-48 truncate text-[11px] text-amber-600">
          FT3 ещё управляет сервером: {status?.orphanedManagedEndpoint}
        </span>
      ) : null}
      <Dialog
        open={settingsOpen}
        onOpenChange={(open) => {
          if (open) setSettingsOpen(true);
          else closeSettings();
        }}
      >
        <DialogPopup className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Параметры сервера</DialogTitle>
            <DialogDescription>
              Изменения сохраняются для следующего запуска и не меняют работающий llama-server.
              Нажмите Stop, затем Start, чтобы применить их.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="grid grid-cols-2 gap-3">
            {settingsDraft ? (
              <>
                <p className="col-span-2 text-sm text-muted-foreground">
                  Профиль для выбранной модели: {props.model}
                </p>
                {isPiBonsai27BModel(settingsModelRef.current ?? props.model) ? (
                  <div className="col-span-2 grid gap-2 rounded-md border p-3 text-sm">
                    <p>
                      {folderPickerTargetEnvironmentId !== null
                        ? "FT3 найдёт Bonsai-demo автоматически. Если не найдёт, выберите корневую папку: FT3 проверит llama-server и GGUF именно для 27B."
                        : "FT3 проверит Bonsai-demo на целевом хосте и подберёт llama-server и GGUF именно для 27B."}
                    </p>
                    <p className="text-muted-foreground">
                      Для 27B будет сохранён отдельный профиль с локальным адресом 127.0.0.1:8080.
                      Путь к файлу вводить вручную не нужно.
                    </p>
                    {folderPickerTargetEnvironmentId !== null ? (
                      <div>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={choosingBonsaiFolder || bonsaiPresetState === "checking"}
                          onClick={() => void chooseBonsaiFolder()}
                        >
                          <FolderOpenIcon aria-hidden="true" />
                          {choosingBonsaiFolder ? "Проверяем папку…" : "Выбрать папку Bonsai…"}
                        </Button>
                      </div>
                    ) : null}
                    <p role="status" aria-live="polite" className="text-muted-foreground">
                      {bonsaiPresetState === "checking"
                        ? "Проверяем Bonsai 2 27B…"
                        : bonsaiPresetState === "saved"
                          ? "Профиль 27B уже сохранён для этого Pi instance; он будет использован при Start."
                          : bonsaiPresetState === "detected"
                            ? "Папка проверена. Нажмите «Применить», чтобы сохранить профиль 27B для этого Pi instance."
                            : bonsaiPresetState === "missing"
                              ? folderPickerTargetEnvironmentId !== null
                                ? "Автообнаружение не нашло preset. Выберите корневую папку Bonsai-demo выше."
                                : "Автообнаружение не нашло preset на целевом FT3-хосте. Следуйте инструкции ниже."
                              : bonsaiPresetState === "error"
                                ? "Не удалось проверить Bonsai-demo."
                                : folderPickerTargetEnvironmentId !== null
                                  ? "При отсутствии автообнаружения выберите папку Bonsai-demo выше."
                                  : "Автообнаружение выполняется на целевом FT3-хосте."}
                    </p>
                    {folderPickerTargetEnvironmentId === null ? (
                      <p className="text-muted-foreground">
                        Локальный выбор папки для этого окружения недоступен: найденный путь должен
                        быть виден целевому FT3-хосту. Если автопоиск не нашёл Bonsai-demo, задайте{" "}
                        <code>BONSAI_DEMO_HOME</code> на этом хосте, указав корень Bonsai-demo, и
                        перезапустите FT3.
                      </p>
                    ) : null}
                    {bonsaiPresetError ? (
                      <p role="alert" className="text-destructive">
                        {bonsaiPresetError}
                      </p>
                    ) : null}
                  </div>
                ) : (
                  (["executablePath", "modelPath", "baseUrl"] as const).map((field) => {
                    const profiles = settingsDraft.inferenceServerProfiles;
                    const selectedModel = settingsModelRef.current ?? props.model;
                    const existing = piInferenceProfileForModel(settingsDraft, selectedModel);
                    const legacyApplies = settingsDraft.model === selectedModel;
                    const value =
                      existing?.[field] ??
                      (legacyApplies
                        ? field === "executablePath"
                          ? settingsDraft.inferenceServerExecutablePath
                          : field === "modelPath"
                            ? settingsDraft.inferenceServerModelPath
                            : settingsDraft.baseUrl
                        : "");
                    const label =
                      field === "executablePath"
                        ? "llama-server executable"
                        : field === "modelPath"
                          ? "GGUF model file"
                          : "Loopback endpoint";
                    return (
                      <label key={field} className="col-span-2 grid gap-1 text-sm">
                        {label}
                        <Input
                          value={value}
                          placeholder={
                            field === "baseUrl" ? "http://127.0.0.1:8081/v1" : "Absolute file path"
                          }
                          onChange={(event) => {
                            const next = existing ?? {
                              model: selectedModel,
                              executablePath: "",
                              modelPath: "",
                              baseUrl: "",
                            };
                            const updated = { ...next, [field]: event.target.value };
                            setSettingsDraft({
                              ...settingsDraft,
                              inferenceServerProfiles: [
                                ...profiles.filter((profile) => profile.model !== selectedModel),
                                updated,
                              ],
                            });
                          }}
                        />
                      </label>
                    );
                  })
                )}
                {(
                  [
                    ["inferenceServerContextSize", "Контекст (токены)", 512, 1048576],
                    ["inferenceServerGpuLayers", "GPU layers", 0, 999],
                    ["inferenceServerParallel", "Parallel slots", 1, 64],
                    ["inferenceServerTemperature", "Temperature", 0, 2],
                    ["inferenceServerTopP", "Top-p", 0, 1],
                    ["inferenceServerTopK", "Top-k (0 выключает)", 0, 1000],
                    ["inferenceServerMinP", "Min-p", 0, 1],
                  ] as const
                ).map(([key, label, min, max]) => (
                  <label key={key} className="grid gap-1 text-sm">
                    {label}
                    <Input
                      type="number"
                      min={min}
                      max={max}
                      step={
                        key.includes("Temperature") || key.endsWith("TopP") || key.endsWith("MinP")
                          ? "0.01"
                          : "1"
                      }
                      value={settingsDraft[key] as number}
                      onChange={(event) =>
                        setSettingsDraft({ ...settingsDraft, [key]: Number(event.target.value) })
                      }
                    />
                  </label>
                ))}
                {(
                  [
                    ["inferenceServerFlashAttention", "Flash attention"],
                    ["inferenceServerJinja", "Jinja templates"],
                    ["inferenceServerReasoning", "Reasoning"],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={settingsDraft[key] as boolean}
                      onChange={(event) =>
                        setSettingsDraft({ ...settingsDraft, [key]: event.target.checked })
                      }
                    />
                    {label}
                  </label>
                ))}
                {(["inferenceServerCacheTypeK", "inferenceServerCacheTypeV"] as const).map(
                  (key) => (
                    <label key={key} className="grid gap-1 text-sm">
                      KV cache {key.endsWith("K") ? "K" : "V"}
                      <select
                        className="h-8 rounded border bg-background px-2"
                        value={settingsDraft[key]}
                        onChange={(event) =>
                          setSettingsDraft({
                            ...settingsDraft,
                            [key]: event.target.value as (typeof settingsDraft)[typeof key],
                          })
                        }
                      >
                        {["q4_0", "q8_0", "f16", "bf16", "f32"].map((item) => (
                          <option key={item}>{item}</option>
                        ))}
                      </select>
                    </label>
                  ),
                )}
                <label className="grid gap-1 text-sm">
                  Reasoning effort
                  <select
                    className="h-8 rounded border bg-background px-2"
                    value={settingsDraft.inferenceServerReasoningEffort}
                    onChange={(event) =>
                      setSettingsDraft({
                        ...settingsDraft,
                        inferenceServerReasoningEffort: event.target
                          .value as typeof settingsDraft.inferenceServerReasoningEffort,
                      })
                    }
                  >
                    {["low", "medium", "high"].map((item) => (
                      <option key={item}>{item}</option>
                    ))}
                  </select>
                </label>
              </>
            ) : null}
            {settingsError ? (
              <p className="col-span-2 text-sm text-destructive" role="alert">
                {settingsError}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={closeSettings}>
              Отмена
            </Button>
            <Button onClick={() => void saveSettings()}>Применить</Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      {canRetry && canStop ? (
        <ComposerControl
          size={size}
          type="button"
          disabled={pendingAction !== null}
          aria-label="Retry Pi inference server readiness checks"
          onClick={() => void runAction("start")}
          className="px-1.5"
        >
          <ComposerControlIcon icon={RefreshCwIcon} size={size} />
        </ComposerControl>
      ) : null}
      {visibleHint ? (
        <span
          id={hintId}
          className={`max-w-40 truncate text-[11px] ${visibleHintIsError ? "text-destructive" : "text-muted-foreground"}`}
          data-pi-inference-server-error={visibleHintIsError || undefined}
        >
          {visibleHint}
        </span>
      ) : null}
    </div>
  );
}
