import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import type { UnifiedSettings } from "@t3tools/contracts/settings";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useId, useMemo, useState } from "react";
import { create } from "zustand";

import { useEnvironmentSettings } from "../hooks/useSettings";
import { getAppModelOptionsForInstance } from "../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  isProviderInstancePickerSelectable,
  sortProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../providerInstances";
import { serverEnvironment } from "../state/server";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { SWITCH_PROVIDER_REASON_MAX_LENGTH } from "./switchProviderDialog.logic";

export interface SwitchProviderChoice {
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly model: string;
  /** Null when the optional reason field is left blank. */
  readonly reason: string | null;
}

export interface SwitchProviderDialogPurpose {
  readonly title: string;
  readonly description: string;
  readonly reasonLabel: string;
  readonly reasonPlaceholder: string;
  readonly submitLabel: string;
  readonly requireReason?: boolean;
}

interface SwitchProviderRequest {
  readonly environmentId: EnvironmentId;
  readonly currentInstanceId: ProviderInstanceId | null;
  readonly currentModel: string | null;
  readonly purpose?: SwitchProviderDialogPurpose;
  readonly resolve: (choice: SwitchProviderChoice | null) => void;
}

const useRequest = create<{ request: SwitchProviderRequest | null }>(() => ({ request: null }));

export function requestSwitchProviderTarget(input: {
  readonly environmentId: EnvironmentId;
  readonly currentInstanceId?: ProviderInstanceId | null;
  readonly currentModel?: string | null;
  readonly purpose?: SwitchProviderDialogPurpose;
}): Promise<SwitchProviderChoice | null> {
  useRequest.getState().request?.resolve(null);
  return new Promise((resolve) =>
    useRequest.setState({
      request: {
        environmentId: input.environmentId,
        currentInstanceId: input.currentInstanceId ?? null,
        currentModel: input.currentModel ?? null,
        ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
        resolve,
      },
    }),
  );
}

function finish(choice: SwitchProviderChoice | null) {
  const request = useRequest.getState().request;
  useRequest.setState({ request: null });
  request?.resolve(choice);
}

export function SwitchProviderDialogHost() {
  const request = useRequest((state) => state.request);
  useEffect(() => () => finish(null), []);
  return request ? <SwitchProviderDialog request={request} /> : null;
}

function modelsForEntry(settings: UnifiedSettings, entry: ProviderInstanceEntry) {
  // Same option list the composer picker shows for this instance, minus
  // rows flagged unavailable — a switch target must have a configured model.
  return getAppModelOptionsForInstance(settings, entry, null).filter(
    (option) => !option.isUnavailable,
  );
}

function SwitchProviderDialog({ request }: { request: SwitchProviderRequest }) {
  const id = useId();
  // Same provider catalog the composer picker reads: the environment's
  // server config projection (cached across reconnects).
  const projection = Option.getOrNull(
    AsyncResult.value(
      useAtomValue(
        serverEnvironment.configProjection({
          environmentId: request.environmentId,
          input: {},
        }),
      ),
    ),
  );
  const settings = useEnvironmentSettings(request.environmentId);
  const providers = projection?.config.providers ?? [];

  const entries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
      ).filter(isProviderInstancePickerSelectable),
    [providers, settings],
  );

  const [instanceId, setInstanceId] = useState<string | null>(() => {
    if (
      request.currentInstanceId &&
      entries.some((entry) => entry.instanceId === request.currentInstanceId)
    ) {
      return request.currentInstanceId;
    }
    return entries[0]?.instanceId ?? null;
  });
  const entry = entries.find((candidate) => candidate.instanceId === instanceId) ?? null;
  const models = useMemo(() => (entry ? modelsForEntry(settings, entry) : []), [entry, settings]);
  const [model, setModel] = useState<string | null>(() => {
    if (!entry) return null;
    const initial = modelsForEntry(settings, entry);
    if (request.currentModel && initial.some((option) => option.slug === request.currentModel)) {
      return request.currentModel;
    }
    return initial[0]?.slug ?? null;
  });
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  // The instance list arrives asynchronously; adopt the first selectable entry
  // (or the current instance when it is present), together with a valid model
  // instead of stranding the selects or silently changing the user's current
  // provider while the catalog is loading.
  useEffect(() => {
    if (instanceId !== null) return;
    const preferred = request.currentInstanceId
      ? entries.find((candidate) => candidate.instanceId === request.currentInstanceId)
      : undefined;
    const next = preferred ?? entries[0];
    if (!next) return;
    setInstanceId(next.instanceId);
    const nextModels = modelsForEntry(settings, next);
    setModel(
      request.currentModel && nextModels.some((option) => option.slug === request.currentModel)
        ? request.currentModel
        : (nextModels[0]?.slug ?? null),
    );
  }, [entries, instanceId, request.currentInstanceId, request.currentModel, settings]);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) finish(null);
      }}
    >
      <DialogPopup className="sm:max-w-md">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (!entry || !model) {
              setError(
                entries.length === 0
                  ? "No ready provider instances are available in this environment."
                  : "Choose a provider instance and model.",
              );
              return;
            }
            if (request.purpose?.requireReason === true && reason.trim().length === 0) {
              setError("Enter a reason before continuing.");
              return;
            }
            finish({
              instanceId: entry.instanceId,
              driverKind: entry.driverKind,
              model,
              reason: reason.trim().length > 0 ? reason.trim() : null,
            });
          }}
        >
          <DialogHeader>
            <DialogTitle>{request.purpose?.title ?? "Switch provider"}</DialogTitle>
            <DialogDescription>
              {request.purpose?.description ??
                "Move this thread to another provider and model without losing its work."}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-4 text-base sm:text-sm">
            <Label
              className="flex min-w-0 flex-col items-stretch gap-1.5"
              htmlFor={`${id}-instance`}
            >
              Provider
              <Select
                value={instanceId ?? ""}
                items={Object.fromEntries(
                  entries.map((candidate) => [candidate.instanceId, candidate.displayName]),
                )}
                onValueChange={(value) => {
                  const next = entries.find((candidate) => candidate.instanceId === value) ?? null;
                  setInstanceId(next?.instanceId ?? null);
                  setModel(next ? (modelsForEntry(settings, next)[0]?.slug ?? null) : null);
                  setError(null);
                }}
              >
                <SelectTrigger id={`${id}-instance`} className="min-w-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {entries.map((candidate) => (
                    <SelectItem key={candidate.instanceId} value={candidate.instanceId}>
                      {candidate.displayName}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Label>
            <Label className="flex min-w-0 flex-col items-stretch gap-1.5" htmlFor={`${id}-model`}>
              Model
              <Select
                value={model ?? ""}
                items={Object.fromEntries(models.map((option) => [option.slug, option.name]))}
                onValueChange={(value) => {
                  setModel(value);
                  setError(null);
                }}
              >
                <SelectTrigger id={`${id}-model`} className="min-w-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {models.map((option) => (
                    <SelectItem key={option.slug} value={option.slug}>
                      {option.name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Label>
            <Label className="flex min-w-0 flex-col items-stretch gap-1.5" htmlFor={`${id}-reason`}>
              {request.purpose?.reasonLabel ?? "Reason (optional)"}
              <Input
                nativeInput
                id={`${id}-reason`}
                className="h-9 sm:h-8"
                type="text"
                value={reason}
                maxLength={SWITCH_PROVIDER_REASON_MAX_LENGTH}
                placeholder={request.purpose?.reasonPlaceholder ?? "Why is this thread moving?"}
                required={request.purpose?.requireReason === true}
                onChange={(event) => {
                  setReason(event.target.value);
                  setError(null);
                }}
              />
            </Label>
            {error && (
              <p role="alert" className="text-destructive">
                {error}
              </p>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => finish(null)}>
              Cancel
            </Button>
            <Button type="submit">{request.purpose?.submitLabel ?? "Switch"}</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
