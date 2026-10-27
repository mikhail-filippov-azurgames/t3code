import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import type { PiBonsaiPreset } from "@t3tools/ft3-pi/rpc-contracts";
import { FolderOpenIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { SettingsRow } from "~/components/settings/settingsLayout";
import { Button } from "~/components/ui/button";
import { isElectron } from "~/env";
import { ensureLocalApi } from "~/localApi";
import { formatEnvironmentQueryError } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { piEnvironment } from "./state.ts";

export interface PiBonsaiPresetSectionProps {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly readOnly: boolean;
}

export function PiBonsaiPresetSection(props: PiBonsaiPresetSectionProps) {
  const detect = useAtomCommand(piEnvironment.detectBonsaiPreset, { reportFailure: false });
  const apply = useAtomCommand(piEnvironment.applyBonsaiPreset, { reportFailure: false });
  const [preset, setPreset] = useState<PiBonsaiPreset | null>(null);
  const [checked, setChecked] = useState(false);
  const [configuredFromFolder, setConfiguredFromFolder] = useState(false);
  const [pending, setPending] = useState<"detect" | "folder" | "apply" | null>(null);
  const [folderError, setFolderError] = useState<string | null>(null);
  const detectionSequence = useRef(0);

  useEffect(() => {
    let active = true;
    const sequence = ++detectionSequence.current;
    void detect({ environmentId: props.environmentId, input: {} })
      .then((result) => {
        if (!active || sequence !== detectionSequence.current) return;
        if (result._tag === "Success") {
          setPreset(result.value);
        } else {
          setPreset(null);
          setConfiguredFromFolder(false);
          setFolderError(formatEnvironmentQueryError(result.cause));
        }
        setChecked(true);
      })
      .catch((cause: unknown) => {
        if (!active || sequence !== detectionSequence.current) return;
        setPreset(null);
        setConfiguredFromFolder(false);
        setFolderError(
          cause instanceof Error ? cause.message : "Could not check for a Bonsai preset.",
        );
        setChecked(true);
      });
    return () => {
      active = false;
      detectionSequence.current++;
    };
  }, [detect, props.environmentId, props.instanceId]);

  const runApply = async (input: { readonly rootPath?: string }, sequence: number) => {
    const result = await apply({
      environmentId: props.environmentId,
      input: { instanceId: props.instanceId, ...input },
    });
    if (sequence !== detectionSequence.current) return undefined;
    if (result._tag === "Failure") {
      throw new Error(formatEnvironmentQueryError(result.cause));
    }
    return result.value;
  };

  const chooseFolder = async () => {
    let sequence = detectionSequence.current;
    setPending("folder");
    setFolderError(null);
    try {
      const rootPath = await ensureLocalApi().dialogs.pickFolder({
        targetEnvironmentId: props.environmentId,
      });
      if (sequence !== detectionSequence.current) return;
      if (!rootPath) return;

      sequence = ++detectionSequence.current;
      const applied = await runApply({ rootPath }, sequence);
      if (sequence !== detectionSequence.current) return;
      if (!applied) {
        setFolderError(
          "That folder must contain the llama-server executable and the Bonsai 2 27B GGUF model.",
        );
        setChecked(true);
        return;
      }

      setPreset(applied);
      setChecked(true);
      setConfiguredFromFolder(true);
    } catch (cause) {
      if (sequence !== detectionSequence.current) return;
      setFolderError(
        cause instanceof Error ? cause.message : "Could not read the selected folder.",
      );
      setChecked(true);
    } finally {
      if (sequence === detectionSequence.current) setPending(null);
    }
  };

  const usePreset = async () => {
    if (!preset) return;
    const sequence = ++detectionSequence.current;
    setPending("apply");
    setFolderError(null);
    try {
      const applied = await runApply({}, sequence);
      if (sequence !== detectionSequence.current) return;
      if (!applied) {
        setFolderError("The detected Bonsai preset is no longer available.");
        return;
      }
      setPreset(applied);
      setConfiguredFromFolder(false);
    } catch (cause) {
      if (sequence !== detectionSequence.current) return;
      setFolderError(cause instanceof Error ? cause.message : "Could not apply the Bonsai preset.");
    } finally {
      if (sequence === detectionSequence.current) setPending(null);
    }
  };

  const description = folderError
    ? "FT3 could not verify the Bonsai preset. Choose a valid Bonsai-demo folder or check Pi settings."
    : configuredFromFolder
      ? "Bonsai executable, model, and local endpoint were saved to this Pi instance's managed inference profiles."
      : preset
        ? "FT3 found the local llama-server executable and GGUF file. The preset assigns a stable Bonsai model ID so Pi can use it before the server starts."
        : checked
          ? "No Bonsai preset was detected. Choose the Bonsai-demo folder or configure the executable, model file, and local endpoint for this Pi instance."
          : "Checking this FT3 host for the Bonsai executable and model file…";

  return (
    <SettingsRow title="Bonsai 2 27B preset" description={description}>
      <div className="flex flex-wrap items-center gap-2">
        {isElectron ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={props.readOnly || pending === "folder"}
            onClick={() => void chooseFolder()}
          >
            <FolderOpenIcon aria-hidden="true" />
            {pending === "folder" ? "Checking folder…" : "Choose Bonsai folder"}
          </Button>
        ) : null}
        {preset && !configuredFromFolder ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={props.readOnly || pending !== null}
            onClick={() => void usePreset()}
          >
            {pending === "apply" ? "Applying preset…" : "Use detected Bonsai preset"}
          </Button>
        ) : null}
        {folderError ? (
          <span role="alert" className="text-xs text-destructive">
            {folderError}
          </span>
        ) : null}
      </div>
    </SettingsRow>
  );
}
