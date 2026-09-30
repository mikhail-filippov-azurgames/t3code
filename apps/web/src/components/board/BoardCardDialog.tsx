/**
 * Create form for a board card.
 *
 * A human card lands in `todo` with `createdBy: human` (stamped by the server).
 * The executor model and effort are chosen here the same way the calendar picks
 * an executor, and the card carries an executor role for the orchestrator.
 *
 * @module components/board/BoardCardDialog
 */
import {
  DEFAULT_SERVER_SETTINGS,
  type BoardCreateInput,
  type BoardExecutorRole,
  type EnvironmentId,
  type ModelSelection,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";
import { useState } from "react";

import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { useServerConfigs } from "../../state/entities";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { BOARD_EXECUTOR_ROLES, boardExecutorRoleLabel } from "./board.logic";

/** The owning orchestrator is added by the page, not the form. */
export type BoardCardDraft = Omit<BoardCreateInput, "orchestratorThreadId">;

export interface BoardCardDialogProps {
  readonly environmentId: EnvironmentId;
  readonly onClose: () => void;
  readonly onCreate: (input: BoardCardDraft) => Promise<void>;
}

export function BoardCardDialog({ environmentId, onClose, onCreate }: BoardCardDialogProps) {
  const serverConfigs = useServerConfigs();
  const serverConfig = serverConfigs.get(environmentId);
  const providers = serverConfig?.providers ?? [];
  const pickerSettings: UnifiedSettings = {
    ...DEFAULT_UNIFIED_SETTINGS,
    ...(serverConfig?.settings ?? DEFAULT_SERVER_SETTINGS),
  };
  const instanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), pickerSettings),
  );
  const defaultModelSelection = resolveDefaultProviderModelSelection(
    providers,
    pickerSettings.defaultModelSelection,
  );
  const [modelSelectionOverride, setModelSelectionOverride] = useState<ModelSelection | null>(null);
  const modelSelection = modelSelectionOverride ?? defaultModelSelection;
  const activeEntry =
    instanceEntries.find((entry) => entry.instanceId === modelSelection?.instanceId) ?? null;
  const modelOptions = getCustomModelOptionsByInstance(
    pickerSettings,
    providers,
    modelSelection?.instanceId,
    modelSelection?.model,
  );

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [executorRole, setExecutorRole] = useState<BoardExecutorRole>("implementation");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (title.trim().length === 0) {
      setError("Enter a title.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onCreate({
        title: title.trim(),
        body,
        executorRole,
        ...(modelSelection === null ? {} : { assignee: modelSelection }),
      });
      onClose();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "The board server could not save this card.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="sm:max-w-md">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>New task</DialogTitle>
            <DialogDescription>
              A task starts in To do. Starting it hands it to the Coordinator.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-4 text-base sm:text-sm">
            <Label
              className="flex min-w-0 flex-col items-stretch gap-1.5"
              htmlFor="board-card-title"
            >
              Title
              <Input
                nativeInput
                id="board-card-title"
                maxLength={160}
                value={title}
                placeholder="Wire the board page"
                onChange={(event) => {
                  setTitle(event.target.value);
                  setError(null);
                }}
              />
            </Label>

            <Label
              className="flex min-w-0 flex-col items-stretch gap-1.5"
              htmlFor="board-card-role"
            >
              Executor role
              <Select
                value={executorRole}
                onValueChange={(value) => {
                  setExecutorRole(value as BoardExecutorRole);
                  setError(null);
                }}
              >
                <SelectTrigger id="board-card-role" aria-label="Executor role">
                  <SelectValue>{boardExecutorRoleLabel(executorRole)}</SelectValue>
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  {BOARD_EXECUTOR_ROLES.map((role) => (
                    <SelectItem key={role} value={role}>
                      {boardExecutorRoleLabel(role)}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Label>

            <div className="flex min-w-0 flex-col items-stretch gap-1.5">
              <span className="text-sm font-medium">Executor</span>
              {modelSelection !== null && activeEntry !== null ? (
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <ProviderModelPicker
                    activeInstanceId={modelSelection.instanceId}
                    model={modelSelection.model}
                    lockedProvider={null}
                    instanceEntries={instanceEntries}
                    modelOptionsByInstance={modelOptions}
                    triggerVariant="outline"
                    onInstanceModelChange={(instanceId, model) => {
                      setModelSelectionOverride(createModelSelection(instanceId, model));
                      setError(null);
                    }}
                  />
                  <TraitsPicker
                    provider={activeEntry.driverKind}
                    models={activeEntry.models}
                    model={modelSelection.model}
                    prompt=""
                    onPromptChange={() => {}}
                    modelOptions={modelSelection.options ?? []}
                    allowPromptInjectedEffort={false}
                    planModeEnabled={pickerSettings.planModeEnabled}
                    triggerVariant="outline"
                    onModelOptionsChange={(options) => {
                      setModelSelectionOverride(
                        createModelSelection(
                          modelSelection.instanceId,
                          modelSelection.model,
                          options,
                        ),
                      );
                      setError(null);
                    }}
                  />
                </div>
              ) : (
                <p className="text-xs text-warning-foreground">
                  No provider is available on this environment. Set one up in settings.
                </p>
              )}
            </div>

            <Label
              className="flex min-w-0 flex-col items-stretch gap-1.5"
              htmlFor="board-card-body"
            >
              Body
              <Textarea
                id="board-card-body"
                value={body}
                placeholder="Context and acceptance for the executor."
                onChange={(event) => {
                  setBody(event.target.value);
                  setError(null);
                }}
              />
            </Label>

            {error !== null ? (
              <p role="alert" className="text-destructive">
                {error}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
