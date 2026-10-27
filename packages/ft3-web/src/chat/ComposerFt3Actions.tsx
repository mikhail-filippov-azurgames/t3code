import type {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ScopedThreadRef,
} from "@t3tools/contracts";

import { ArchitectPublishButton } from "../architect/ArchitectPublishButton.tsx";
import { PiInferenceServerControl } from "../pi/PiInferenceServerControl.tsx";

export interface ChatComposerFt3ActionsProps {
  readonly threadRef: ScopedThreadRef | null;
  readonly compact: boolean;
  readonly environmentId: EnvironmentId;
  readonly provider: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
}

/** Fork additions to the composer action row: Architect publish and Pi inference. */
export function ChatComposerFt3Actions(props: ChatComposerFt3ActionsProps) {
  return (
    <>
      <ArchitectPublishButton threadRef={props.threadRef} compact={props.compact} />
      {props.provider === "pi" ? (
        <PiInferenceServerControl
          environmentId={props.environmentId}
          instanceId={props.instanceId}
          model={props.model}
        />
      ) : null}
    </>
  );
}
