import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import type { PiInferenceProfileSettings } from "@t3tools/ft3-pi/rpc-contracts";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { validatePiInferenceProfile } from "./piInferenceProfile.logic.ts";
import { piEnvironment } from "./state.ts";

const CACHE_TYPE_OPTIONS = ["q4_0", "q8_0", "f16", "bf16", "f32"] as const;
const REASONING_EFFORT_OPTIONS = ["low", "medium", "high"] as const;

export interface PiInferenceProfileDialogProps {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSaved?: (() => void) | undefined;
}

function NumberField(props: {
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly onChange: (value: number) => void;
}) {
  return (
    <label className="grid gap-1 text-sm">
      {props.label}
      <Input
        type="number"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(event) => props.onChange(Number(event.target.value))}
      />
    </label>
  );
}

export function PiInferenceProfileDialog(props: PiInferenceProfileDialogProps) {
  const query = useEnvironmentQuery(
    props.open
      ? piEnvironment.profile({
          environmentId: props.environmentId,
          input: { instanceId: props.instanceId, model: props.model },
        })
      : null,
  );
  const save = useAtomCommand(piEnvironment.saveProfile, { reportFailure: false });
  const [edited, setEdited] = useState<PiInferenceProfileSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const draft = edited ?? query.data ?? null;

  const update = <K extends keyof PiInferenceProfileSettings>(
    key: K,
    value: PiInferenceProfileSettings[K],
  ) => {
    setEdited((current) => {
      const base = current ?? query.data;
      return base ? { ...base, [key]: value } : current;
    });
    setError(null);
  };

  const submit = async () => {
    if (!draft || saving) return;
    const problem = validatePiInferenceProfile(draft);
    if (problem !== null) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError(null);
    const result = await save({
      environmentId: props.environmentId,
      input: { instanceId: props.instanceId, profile: draft },
    });
    setSaving(false);
    if (AsyncResult.isFailure(result)) {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : "Could not save the server parameters.");
      return;
    }
    props.onOpenChange(false);
    props.onSaved?.();
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Server parameters</DialogTitle>
          <DialogDescription>
            Saved for the next launch and not applied to a running llama-server. Stop, then start
            the server to use the new values.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="grid grid-cols-2 gap-3">
          {draft ? (
            <>
              <p className="col-span-2 text-sm text-muted-foreground">Profile: {props.model}</p>
              <label className="col-span-2 grid gap-1 text-sm">
                llama-server executable
                <Input
                  value={draft.executablePath}
                  placeholder="Absolute path to llama-server.exe"
                  onChange={(event) => update("executablePath", event.target.value)}
                />
              </label>
              <label className="col-span-2 grid gap-1 text-sm">
                GGUF model file
                <Input
                  value={draft.modelPath}
                  placeholder="Absolute path to the .gguf file"
                  onChange={(event) => update("modelPath", event.target.value)}
                />
              </label>
              <label className="col-span-2 grid gap-1 text-sm">
                Loopback endpoint
                <Input
                  value={draft.baseUrl}
                  placeholder="http://127.0.0.1:8081/v1"
                  onChange={(event) => update("baseUrl", event.target.value)}
                />
              </label>
              <NumberField
                label="Context (tokens)"
                min={512}
                max={1_048_576}
                step={1}
                value={draft.contextSize}
                onChange={(value) => update("contextSize", value)}
              />
              <NumberField
                label="GPU layers"
                min={0}
                max={999}
                step={1}
                value={draft.gpuLayers}
                onChange={(value) => update("gpuLayers", value)}
              />
              <NumberField
                label="Parallel slots"
                min={1}
                max={64}
                step={1}
                value={draft.parallel}
                onChange={(value) => update("parallel", value)}
              />
              <NumberField
                label="Temperature"
                min={0}
                max={2}
                step={0.01}
                value={draft.temperature}
                onChange={(value) => update("temperature", value)}
              />
              <NumberField
                label="Top-p"
                min={0}
                max={1}
                step={0.01}
                value={draft.topP}
                onChange={(value) => update("topP", value)}
              />
              <NumberField
                label="Top-k (0 disables)"
                min={0}
                max={1000}
                step={1}
                value={draft.topK}
                onChange={(value) => update("topK", value)}
              />
              <NumberField
                label="Min-p"
                min={0}
                max={1}
                step={0.01}
                value={draft.minP}
                onChange={(value) => update("minP", value)}
              />
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draft.flashAttention}
                  onChange={(event) => update("flashAttention", event.target.checked)}
                />
                Flash attention
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draft.jinja}
                  onChange={(event) => update("jinja", event.target.checked)}
                />
                Jinja templates
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draft.reasoning}
                  onChange={(event) => update("reasoning", event.target.checked)}
                />
                Reasoning
              </label>
              <label className="grid gap-1 text-sm">
                KV cache K
                <Select
                  value={draft.cacheTypeK}
                  onValueChange={(value) =>
                    update("cacheTypeK", value as PiInferenceProfileSettings["cacheTypeK"])
                  }
                >
                  <SelectTrigger aria-label="KV cache K">
                    <SelectValue>{draft.cacheTypeK}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup alignItemWithTrigger={false}>
                    {CACHE_TYPE_OPTIONS.map((option) => (
                      <SelectItem key={option} value={option}>
                        {option}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </label>
              <label className="grid gap-1 text-sm">
                KV cache V
                <Select
                  value={draft.cacheTypeV}
                  onValueChange={(value) =>
                    update("cacheTypeV", value as PiInferenceProfileSettings["cacheTypeV"])
                  }
                >
                  <SelectTrigger aria-label="KV cache V">
                    <SelectValue>{draft.cacheTypeV}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup alignItemWithTrigger={false}>
                    {CACHE_TYPE_OPTIONS.map((option) => (
                      <SelectItem key={option} value={option}>
                        {option}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </label>
              <label className="grid gap-1 text-sm">
                Reasoning effort
                <Select
                  value={draft.reasoningEffort}
                  onValueChange={(value) =>
                    update(
                      "reasoningEffort",
                      value as PiInferenceProfileSettings["reasoningEffort"],
                    )
                  }
                >
                  <SelectTrigger aria-label="Reasoning effort">
                    <SelectValue>{draft.reasoningEffort}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup alignItemWithTrigger={false}>
                    {REASONING_EFFORT_OPTIONS.map((option) => (
                      <SelectItem key={option} value={option}>
                        {option}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </label>
            </>
          ) : (
            <p className="col-span-2 text-sm text-muted-foreground">
              {query.error ?? "Loading server parameters…"}
            </p>
          )}
          {error !== null ? (
            <p role="alert" className="col-span-2 text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={draft === null || saving} onClick={() => void submit()}>
            {saving ? "Saving…" : "Apply"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
