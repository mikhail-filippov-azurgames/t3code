/**
 * Adds an orchestrator: mark an existing non-child chat, or create a new chat
 * through the ordinary project/model/effort/prompt flow and mark it.
 *
 * Child threads (delegation lineage) can never become orchestrators (design
 * §3.1), so they are not offered.
 *
 * @module components/board/AddOrchestratorDialog
 */
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useState } from "react";

import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { useProjects, useServerConfigs, useThreadShells } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { newMessageId, newThreadId } from "../../lib/utils";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
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
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { boardEnvironment } from "./useBoardBackend";
import { filterChatCandidates } from "./board.logic";

type AddMode = "existing" | "new";

export interface AddOrchestratorDialogProps {
  readonly environmentId: EnvironmentId;
  readonly orchestratorThreadIds: ReadonlySet<string>;
  readonly onClose: () => void;
  readonly onAdded: (threadId: ThreadId) => void;
}

export function AddOrchestratorDialog({
  environmentId,
  orchestratorThreadIds,
  onClose,
  onAdded,
}: AddOrchestratorDialogProps) {
  const [mode, setMode] = useState<AddMode>("existing");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const shells = useThreadShells();
  const candidates = shells.filter(
    (shell) =>
      shell.environmentId === environmentId &&
      shell.archivedAt === null &&
      shell.delegationParent == null &&
      !orchestratorThreadIds.has(shell.id as string),
  );

  const [chatQuery, setChatQuery] = useState("");
  const filteredCandidates = filterChatCandidates(candidates, chatQuery);

  const [selectedThreadId, setSelectedThreadId] = useState<ThreadId | null>(
    candidates[0]?.id ?? null,
  );

  const serverConfigs = useServerConfigs();
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const [projectId, setProjectId] = useState<ProjectId | null>(projects[0]?.id ?? null);
  const project = projects.find((candidate) => candidate.id === projectId) ?? null;
  const resolvedSettings =
    project === null
      ? null
      : resolveProjectSettings(
          serverConfigs.get(project.environmentId)?.settings ?? DEFAULT_SERVER_SETTINGS,
          project.id,
          project,
        ).settings;
  const pickerSettings: UnifiedSettings = {
    ...DEFAULT_UNIFIED_SETTINGS,
    ...(resolvedSettings ?? DEFAULT_SERVER_SETTINGS),
  };
  const providers = serverConfigs.get(environmentId)?.providers ?? [];
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
  const [prompt, setPrompt] = useState("");

  const addOrchestrator = useAtomCommand(boardEnvironment.orchestratorAdd, {
    reportFailure: false,
  });
  const createThread = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });

  const markExisting = async () => {
    if (selectedThreadId === null) {
      setError("Choose a chat to mark as a Coordinator.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await addOrchestrator({
        environmentId,
        input: { threadId: selectedThreadId },
      });
      if (result._tag === "Failure") {
        throw new Error("The board server could not add this Coordinator.");
      }
      onAdded(selectedThreadId);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not mark this chat.");
    } finally {
      setSubmitting(false);
    }
  };

  const createAndMark = async () => {
    if (project === null) {
      setError("Choose a project for the new Coordinator chat.");
      return;
    }
    if (modelSelection === null) {
      setError("Choose a model for the new Coordinator chat.");
      return;
    }
    if (prompt.trim().length === 0) {
      setError("Enter the Coordinator's starting prompt.");
      return;
    }
    setSubmitting(true);
    setError(null);
    const threadId = newThreadId();
    const createdAt = new Date().toISOString();
    const runtimeMode =
      resolvedSettings?.defaultRuntimeMode ?? DEFAULT_SERVER_SETTINGS.defaultRuntimeMode;
    try {
      const created = await createThread({
        environmentId,
        input: {
          threadId,
          projectId: project.id,
          title: "Coordinator",
          modelSelection,
          runtimeMode,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: null,
          worktreePath: null,
          createdAt,
        },
      });
      if (created._tag === "Failure") {
        throw new Error("The server could not create the Coordinator chat.");
      }
      const started = await startTurn({
        environmentId,
        input: {
          threadId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: prompt.trim(),
            attachments: [],
          },
          modelSelection,
          runtimeMode,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt,
        },
      });
      if (started._tag === "Failure") {
        throw new Error("The Coordinator chat was created, but its first turn did not start.");
      }
      const marked = await addOrchestrator({ environmentId, input: { threadId } });
      if (marked._tag === "Failure") {
        throw new Error("The chat was created, but marking it as a Coordinator failed.");
      }
      onAdded(threadId);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the Coordinator.");
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
        <DialogHeader>
          <DialogTitle>Add Coordinator</DialogTitle>
          <DialogDescription>
            A Coordinator is an ordinary chat you add to the board. Its cards live on the board.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-4 text-base sm:text-sm">
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              variant={mode === "existing" ? "secondary" : "ghost"}
              onClick={() => {
                setMode("existing");
                setError(null);
              }}
            >
              Existing chat
            </Button>
            <Button
              size="sm"
              variant={mode === "new" ? "secondary" : "ghost"}
              onClick={() => {
                setMode("new");
                setError(null);
              }}
            >
              New chat
            </Button>
          </div>

          {mode === "existing" ? (
            <Label
              className="flex min-w-0 flex-col items-stretch gap-1.5"
              htmlFor="board-orch-thread"
            >
              Chat
              {candidates.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No unmarked chats are available. Create a new one instead.
                </p>
              ) : (
                <>
                  <Input
                    nativeInput
                    aria-label="Search chats"
                    placeholder="Search chats"
                    value={chatQuery}
                    onChange={(event) => {
                      setChatQuery(event.target.value);
                      setError(null);
                    }}
                  />
                  {filteredCandidates.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No chats match this search.</p>
                  ) : (
                    <Select
                      value={selectedThreadId ?? ""}
                      onValueChange={(value) => {
                        setSelectedThreadId(value as ThreadId);
                        setError(null);
                      }}
                    >
                      <SelectTrigger id="board-orch-thread" aria-label="Chat">
                        <SelectValue>
                          {candidates.find((shell) => shell.id === selectedThreadId)?.title ??
                            "Choose a chat"}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectPopup alignItemWithTrigger={false}>
                        {filteredCandidates.map((shell) => (
                          <SelectItem key={shell.id} value={shell.id}>
                            {shell.title}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  )}
                </>
              )}
            </Label>
          ) : (
            <>
              <Label
                className="flex min-w-0 flex-col items-stretch gap-1.5"
                htmlFor="board-orch-project"
              >
                Project
                <Select
                  value={projectId ?? ""}
                  onValueChange={(value) => {
                    setProjectId(value as ProjectId);
                    setModelSelectionOverride(null);
                    setError(null);
                  }}
                >
                  <SelectTrigger id="board-orch-project" aria-label="Project">
                    <SelectValue>
                      {project === null ? "Choose a project" : project.title}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup alignItemWithTrigger={false}>
                    {projects.map((candidate) => (
                      <SelectItem key={candidate.id} value={candidate.id}>
                        {candidate.title}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </Label>

              <div className="flex min-w-0 flex-col items-stretch gap-1.5">
                <span className="text-sm font-medium">Model</span>
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
                    No provider is available on this environment.
                  </p>
                )}
              </div>

              <Label
                className="flex min-w-0 flex-col items-stretch gap-1.5"
                htmlFor="board-orch-prompt"
              >
                Starting prompt
                <Textarea
                  id="board-orch-prompt"
                  value={prompt}
                  placeholder="You plan and delegate tasks on this project's board."
                  onChange={(event) => {
                    setPrompt(event.target.value);
                    setError(null);
                  }}
                />
              </Label>
            </>
          )}

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
          <Button
            type="button"
            disabled={submitting || (mode === "existing" && candidates.length === 0)}
            onClick={() => {
              void (mode === "existing" ? markExisting() : createAndMark());
            }}
          >
            {mode === "existing" ? "Add" : "Create"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
