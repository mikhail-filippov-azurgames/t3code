import type { EnvironmentId, PiBonsaiPreset } from "@t3tools/contracts";
import { FolderOpenIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { isElectron } from "../../env";
import { ensureLocalApi } from "../../localApi";
import { serverEnvironment } from "../../state/server";
import { formatEnvironmentQueryError } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { SettingsRow } from "./settingsLayout";

export function PiBonsaiPresetSection(props: {
  readonly environmentId: EnvironmentId;
  readonly readOnly: boolean;
  readonly onUsePreset: (preset: PiBonsaiPreset) => void;
}) {
  const detect = useAtomCommand(serverEnvironment.detectPiBonsaiPreset, {
    reportFailure: false,
  });
  const [preset, setPreset] = useState<PiBonsaiPreset | null>(null);
  const [checked, setChecked] = useState(false);
  const [configuredFromFolder, setConfiguredFromFolder] = useState(false);
  const [isChoosingFolder, setIsChoosingFolder] = useState(false);
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
  }, [detect, props.environmentId]);

  const chooseFolder = async () => {
    let sequence = detectionSequence.current;
    setIsChoosingFolder(true);
    setFolderError(null);
    try {
      const rootPath = await ensureLocalApi().dialogs.pickFolder({
        targetEnvironmentId: props.environmentId,
      });
      if (sequence !== detectionSequence.current) return;
      if (!rootPath) return;

      sequence = ++detectionSequence.current;
      const result = await detect({
        environmentId: props.environmentId,
        input: { rootPath },
      });
      if (sequence !== detectionSequence.current) return;
      if (result._tag === "Failure") {
        setFolderError(formatEnvironmentQueryError(result.cause));
        setChecked(true);
        return;
      }
      if (!result.value) {
        setFolderError(
          "That folder must contain the llama-server executable and the Bonsai 2 27B GGUF model.",
        );
        setChecked(true);
        return;
      }

      setPreset(result.value);
      setChecked(true);
      setConfiguredFromFolder(true);
      props.onUsePreset(result.value);
    } catch (cause) {
      if (sequence !== detectionSequence.current) return;
      setFolderError(
        cause instanceof Error ? cause.message : "Could not read the selected folder.",
      );
      setChecked(true);
    } finally {
      if (sequence === detectionSequence.current) setIsChoosingFolder(false);
    }
  };

  const usePreset = () => {
    if (!preset) return;
    props.onUsePreset(preset);
    setConfiguredFromFolder(false);
    setFolderError(null);
  };

  return (
    <SettingsRow
      title="Bonsai 2 27B preset"
      description={
        folderError
          ? "FT3 could not verify the Bonsai preset. Choose a valid Bonsai-demo folder or check Pi settings."
          : configuredFromFolder
            ? "Bonsai executable, model, and local endpoint were added to this Pi provider configuration."
            : preset
              ? "FT3 found the local llama-server executable and GGUF file. The preset assigns a stable Bonsai model ID so Pi can be selected before the server starts."
              : checked
                ? "No Bonsai preset was detected. Choose the Bonsai-demo folder or configure the executable, model file, and local endpoint in Pi settings."
                : "Checking this FT3 host for the Bonsai executable and model file…"
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        {isElectron ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={props.readOnly || isChoosingFolder}
            onClick={() => void chooseFolder()}
          >
            <FolderOpenIcon aria-hidden="true" />
            {isChoosingFolder ? "Checking folder…" : "Choose Bonsai folder"}
          </Button>
        ) : null}
        {preset && !configuredFromFolder ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={props.readOnly}
            onClick={usePreset}
          >
            Use detected Bonsai preset
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
