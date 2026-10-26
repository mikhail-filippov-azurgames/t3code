import { AsyncResult } from "effect/reactivity";
import { CircleIcon, PowerIcon } from "lucide-react";
import { useState } from "react";

import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { cn } from "~/lib/utils";
import { ComposerControl, ComposerControlIcon } from "~/components/chat/ComposerControl";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  piInferenceAction,
  piInferenceActionDisabled,
  piInferenceActionLabel,
  piInferenceStatusLabel,
  piInferenceTone,
  type PiInferenceAction,
  type PiInferenceTone,
} from "./piInferenceControl.logic.ts";
import { piEnvironment } from "./state.ts";

export interface PiInferenceServerControlProps {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
}

const toneClass: Readonly<Record<PiInferenceTone, string>> = {
  ready: "text-success",
  starting: "text-amber-600",
  failed: "text-destructive",
  off: "text-muted-foreground",
};

export function PiInferenceServerControl(props: PiInferenceServerControlProps) {
  const query = useEnvironmentQuery(
    piEnvironment.status({
      environmentId: props.environmentId,
      input: { instanceId: props.instanceId, model: props.model },
    }),
  );
  const start = useAtomCommand(piEnvironment.start, { reportFailure: false });
  const stop = useAtomCommand(piEnvironment.stop, { reportFailure: false });
  const [pending, setPending] = useState<PiInferenceAction | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);

  const status = query.data;
  const action = piInferenceAction(status);
  const tone = piInferenceTone(status);
  const label = piInferenceActionLabel(status, pending);
  const hint = piInferenceStatusLabel(status, requestError ?? query.error);
  const disabled = piInferenceActionDisabled(status, pending);

  const run = async () => {
    if (action === null || pending !== null) return;
    setPending(action);
    setRequestError(null);
    const command = action === "stop" ? stop : start;
    const result = await command({
      environmentId: props.environmentId,
      input: { instanceId: props.instanceId, model: props.model },
    });
    setPending(null);
    if (AsyncResult.isFailure(result)) {
      const cause = squashAtomCommandFailure(result);
      setRequestError(cause instanceof Error ? cause.message : "Inference server request failed.");
    } else if (result.value.error !== null) {
      setRequestError(result.value.error);
    }
    query.refresh();
  };

  return (
    <div className="flex min-w-0 shrink-0 items-center gap-1" data-pi-inference-server-control>
      <span role="img" aria-label={`Pi inference server: ${tone}. ${hint}`} className="inline-flex">
        <CircleIcon
          aria-hidden="true"
          className={cn("size-2.5 fill-current", toneClass[tone])}
          data-pi-inference-server-tone={tone}
        />
      </span>
      <Tooltip>
        <TooltipTrigger
          render={
            <ComposerControl
              size="xs"
              type="button"
              disabled={disabled}
              aria-busy={pending !== null}
              aria-label={hint}
              onClick={() => void run()}
            />
          }
        >
          <ComposerControlIcon icon={PowerIcon} size="xs" />
          <span className="sr-only sm:not-sr-only">{label}</span>
        </TooltipTrigger>
        <TooltipPopup>{hint}</TooltipPopup>
      </Tooltip>
    </div>
  );
}
