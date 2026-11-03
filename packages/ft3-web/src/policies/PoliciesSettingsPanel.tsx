import type { EnvironmentId } from "@t3tools/contracts";
import { FEATURE_IDS } from "@t3tools/ft3-policies/contracts";
import type { PolicyDocumentKey } from "@t3tools/ft3-policies/contracts";
import type {
  PoliciesGetSnapshotResult,
  PoliciesSaveDocumentResult,
  PolicyDocumentFileSchema,
  PolicyDocumentStatusSchema,
  PolicyIssueSchema,
} from "@t3tools/ft3-policies/rpc-contracts";
import { readPolicySettings } from "@t3tools/ft3-policies/settings";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";
import { Textarea } from "~/components/ui/textarea";
import { useOptionalSettingsScope } from "~/components/settings/SettingsScopeContext";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  SettingsUnavailableGroup,
} from "~/components/settings/settingsLayout";
import { useScopedSettings } from "~/components/settings/useScopedSettings";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  POLICY_DOCUMENT_BADGE_LABELS,
  POLICY_DOCUMENT_BADGE_VARIANTS,
  POLICY_DOCUMENT_KEY_LABELS,
  lineStartOffset,
  policyDocumentBadge,
  policyDocumentSourceLabel,
} from "./policies.logic.ts";
import { policiesEnvironment } from "./state.ts";

export function PoliciesSettingsPanel() {
  const scope = useOptionalSettingsScope();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environmentId = scope?.environment?.environmentId ?? primaryEnvironmentId;
  const settings = useScopedSettings();
  const policySettings = readPolicySettings(settings.ft3);

  const snapshotQuery = useEnvironmentQuery(
    environmentId === null ? null : policiesEnvironment.snapshot({ environmentId, input: {} }),
  );
  const setApplyExternalEdits = useAtomCommand(policiesEnvironment.setApplyExternalEdits, {
    reportFailure: false,
  });

  const [selectedKey, setSelectedKey] = useState<PolicyDocumentKey | null>(null);
  // Command results carry the freshest snapshot; a newer query result wins once its refresh lands.
  const [commandResult, setCommandResult] = useState<{
    snapshot: PoliciesGetSnapshotResult;
    at: number;
  } | null>(null);
  const [applyEditsEnabled, setApplyEditsEnabled] = useState(policySettings.applyExternalEdits);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [togglePending, setTogglePending] = useState(false);

  const snapshot =
    commandResult !== null && commandResult.at >= snapshotQuery.dataUpdatedAt
      ? commandResult.snapshot
      : snapshotQuery.data;
  const selected = snapshot?.documents.find((document) => document.key === selectedKey) ?? null;

  const onSnapshot = (fresh: PoliciesGetSnapshotResult) => {
    setCommandResult({ snapshot: fresh, at: Date.now() });
    snapshotQuery.refresh();
  };

  const toggleApplyExternalEdits = async (enabled: boolean) => {
    if (environmentId === null || togglePending) return;
    setTogglePending(true);
    setToggleError(null);
    const result = await setApplyExternalEdits({ environmentId, input: { enabled } });
    setTogglePending(false);
    if (AsyncResult.isFailure(result)) {
      const cause = squashAtomCommandFailure(result);
      setToggleError(cause instanceof Error ? cause.message : "Could not save the setting.");
      return;
    }
    setApplyEditsEnabled(result.value.enabled);
    onSnapshot(result.value.snapshot);
  };

  return (
    <SettingsPageContainer>
      <SettingsSection id="ft3-policies" title="Policy documents" hideTitle>
        <div className="sr-only">
          <h2>Policy documents</h2>
        </div>
        <SettingsUnavailableGroup
          message={
            environmentId === null
              ? "Connect to an environment to view and edit its policy documents."
              : undefined
          }
        >
          {snapshotQuery.isPending ? (
            <p className="px-3 py-2 text-sm text-muted-foreground sm:px-4">Loading policies…</p>
          ) : null}
          {snapshotQuery.error !== null && snapshot === null ? (
            <p className="px-3 py-2 text-sm text-destructive sm:px-4">
              Could not load policies: {snapshotQuery.error}
            </p>
          ) : null}
          {snapshot?.documents.map((document) => (
            <PolicyDocumentRow
              key={document.key}
              document={document}
              selected={document.key === selectedKey}
              onSelect={() => setSelectedKey(document.key)}
            />
          ))}
        </SettingsUnavailableGroup>
      </SettingsSection>

      {snapshot !== null && environmentId !== null ? (
        <SettingsSection id="ft3-policies-external-edits" title="External edits">
          <SettingsRow
            title="Apply external edits immediately"
            description="When a policy file changes outside the app, apply it right away. Off (the default) keeps the running version and lists the change under its document for a one-click apply. An invalid version is never applied: the previous one stays active."
            control={
              <Switch
                aria-label="Apply external edits immediately"
                checked={applyEditsEnabled}
                disabled={togglePending}
                onCheckedChange={(checked) => void toggleApplyExternalEdits(checked)}
              />
            }
          />
          {toggleError !== null ? (
            <p className="px-3 py-2 text-sm text-destructive sm:px-4">{toggleError}</p>
          ) : null}
        </SettingsSection>
      ) : null}

      {selected !== null && environmentId !== null ? (
        <PolicyDocumentEditor
          key={selected.key}
          environmentId={environmentId}
          document={selected}
          onSnapshot={onSnapshot}
        />
      ) : null}

      {snapshot !== null ? (
        <SettingsSection id="ft3-policies-features" title="Feature toggles">
          <p className="px-3 text-xs text-muted-foreground sm:px-4">
            Requested feature states, environment-wide. A feature only runs when its policy
            documents are valid; an enabled feature with an invalid requirement stays off.
          </p>
          {FEATURE_IDS.map((feature) => (
            <SettingsRow
              key={feature}
              title={feature}
              control={
                <Badge variant={policySettings.features[feature] ? "success" : "secondary"}>
                  {policySettings.features[feature] ? "On" : "Off"}
                </Badge>
              }
            />
          ))}
        </SettingsSection>
      ) : null}
    </SettingsPageContainer>
  );
}

function PolicyDocumentRow({
  document,
  selected,
  onSelect,
}: {
  document: PolicyDocumentStatusSchema;
  selected: boolean;
  onSelect: () => void;
}) {
  const badge = policyDocumentBadge(document);
  return (
    <div className="flex items-center gap-2 px-3 py-2 sm:px-4">
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className="min-w-0 flex-1 text-left"
      >
        <span className="block truncate text-sm font-medium">
          {POLICY_DOCUMENT_KEY_LABELS[document.key]}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {policyDocumentSourceLabel(document.source)}
        </span>
      </button>
      <Badge variant={POLICY_DOCUMENT_BADGE_VARIANTS[badge]}>
        {POLICY_DOCUMENT_BADGE_LABELS[badge]}
      </Badge>
    </div>
  );
}

function PolicyIssueList({
  issues,
  onJumpToLine,
}: {
  issues: ReadonlyArray<PolicyIssueSchema>;
  onJumpToLine: (line: number) => void;
}) {
  return (
    <ul className="space-y-1 px-3 py-2 sm:px-4">
      {issues.map((issue) => {
        const line = typeof issue.line === "number" && issue.line >= 1 ? issue.line : null;
        const key = `${issue.code}:${line ?? ""}:${issue.file ?? ""}:${issue.subject ?? ""}:${issue.message}`;
        return (
          <li key={key} className="flex items-start gap-2 text-sm">
            {line !== null ? (
              <button
                type="button"
                className="shrink-0 font-mono text-xs text-info underline-offset-2 hover:underline"
                onClick={() => onJumpToLine(line)}
              >
                L{line}
              </button>
            ) : null}
            <span className="min-w-0">
              <span className="text-destructive-foreground">{issue.message}</span>
              {issue.hint !== undefined ? (
                <span className="text-muted-foreground"> {issue.hint}</span>
              ) : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function PolicyDocumentEditor({
  environmentId,
  document,
  onSnapshot,
}: {
  environmentId: EnvironmentId;
  document: PolicyDocumentStatusSchema;
  onSnapshot: (snapshot: PoliciesGetSnapshotResult) => void;
}) {
  const readQuery = useEnvironmentQuery(
    policiesEnvironment.readDocument({ environmentId, input: { key: document.key } }),
  );
  const pendingQuery = useEnvironmentQuery(
    document.pending
      ? policiesEnvironment.pendingChange({ environmentId, input: { key: document.key } })
      : null,
  );
  const saveDocument = useAtomCommand(policiesEnvironment.saveDocument, { reportFailure: false });
  const applyPending = useAtomCommand(policiesEnvironment.applyPending, { reportFailure: false });

  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "applied" | "info" | "error"; text: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const editorContainerRef = useRef<HTMLDivElement | null>(null);

  const files = readQuery.data?.status === "ok" ? readQuery.data.files : [];
  const mainFile = readQuery.data?.status === "ok" ? readQuery.data.mainFile : null;
  const currentFileName =
    files.find((file) => file.file === activeFile)?.file ??
    files.find((file) => file.file === mainFile)?.file ??
    files[0]?.file ??
    null;
  const currentFile: PolicyDocumentFileSchema | null =
    files.find((file) => file.file === currentFileName) ?? null;

  const jumpToLine = (line: number) => {
    const textarea = editorContainerRef.current?.querySelector("textarea");
    if (textarea === null || textarea === undefined) return;
    textarea.focus();
    const offset = lineStartOffset(textarea.value, line);
    textarea.setSelectionRange(offset, offset);
  };

  const save = async (content: string, baseSha256: string) => {
    setBusy(true);
    setNotice(null);
    setRequestError(null);
    const result = await saveDocument({
      environmentId,
      input: { key: document.key, baseSha256, content },
    });
    setBusy(false);
    if (AsyncResult.isFailure(result)) {
      const cause = squashAtomCommandFailure(result);
      setRequestError(cause instanceof Error ? cause.message : "Could not save the document.");
      return;
    }
    const saveResult: PoliciesSaveDocumentResult = result.value;
    onSnapshot(saveResult.snapshot);
    if (saveResult.status === "saved") {
      setNotice({ kind: "applied", text: "Applied. The new version is in effect." });
      readQuery.refresh();
    } else if (saveResult.status === "invalid") {
      setNotice({
        kind: "error",
        text: "Not applied: the document has errors, so the previous version stays active.",
      });
    } else if (saveResult.status === "changed_externally") {
      setNotice({
        kind: "info",
        text: "The file changed on disk or in the store since it was loaded. Reloading the latest version.",
      });
      readQuery.refresh();
    } else {
      setNotice({ kind: "error", text: "This document source is not writable from here." });
    }
  };

  const apply = async () => {
    const change = pendingQuery.data?.change ?? null;
    if (change?.liveSha256 == null) return;
    setBusy(true);
    setNotice(null);
    setRequestError(null);
    const result = await applyPending({
      environmentId,
      input: { key: document.key, liveSha256: change.liveSha256 },
    });
    setBusy(false);
    if (AsyncResult.isFailure(result)) {
      const cause = squashAtomCommandFailure(result);
      setRequestError(cause instanceof Error ? cause.message : "Could not apply the change.");
      return;
    }
    onSnapshot(result.value.snapshot);
    if (result.value.status === "applied") {
      setNotice({ kind: "applied", text: "Applied. The external change is in effect." });
    } else if (result.value.status === "invalid") {
      setNotice({
        kind: "error",
        text: "Not applied: the external version has errors, so the previous one stays active.",
      });
    } else if (result.value.status === "changed_externally") {
      setNotice({ kind: "info", text: "A newer external change arrived. Refreshing the diff." });
      pendingQuery.refresh();
    }
  };

  const errors = document.errors;
  const pendingChange = pendingQuery.data?.change ?? null;

  return (
    <SettingsSection
      id="ft3-policies-editor"
      title={`${POLICY_DOCUMENT_KEY_LABELS[document.key]} editor`}
      hideTitle
    >
      <div className="sr-only">
        <h2>{POLICY_DOCUMENT_KEY_LABELS[document.key]} editor</h2>
      </div>
      {readQuery.isPending ? (
        <p className="px-3 py-2 text-sm text-muted-foreground sm:px-4">Loading document…</p>
      ) : null}
      {readQuery.data?.status === "unavailable" ? (
        <p className="px-3 py-2 text-sm text-destructive sm:px-4">
          This document is unavailable:
          {readQuery.data.issues.map((issue) => (
            <span key={`${issue.code}:${issue.message}`}> {issue.message}</span>
          ))}
        </p>
      ) : null}
      {files.length > 1 ? (
        <div
          className="flex flex-wrap gap-1 px-3 pt-2 sm:px-4"
          role="tablist"
          aria-label="Document files"
        >
          {files.map((file) => (
            <Button
              key={file.file}
              size="xs"
              variant={file.file === currentFileName ? "default" : "outline"}
              onClick={() => setActiveFile(file.file)}
            >
              {file.file}
            </Button>
          ))}
        </div>
      ) : null}
      {currentFile !== null ? (
        <div ref={editorContainerRef}>
          <PolicyFileEditor
            key={`${currentFile.file}:${currentFile.sha256}`}
            file={currentFile}
            busy={busy}
            onSave={save}
          />
        </div>
      ) : null}
      {requestError !== null ? (
        <p className="px-3 py-2 text-sm text-destructive sm:px-4">{requestError}</p>
      ) : null}
      {notice !== null ? (
        <p
          className={
            notice.kind === "error"
              ? "px-3 py-2 text-sm text-destructive sm:px-4"
              : "px-3 py-2 text-sm text-muted-foreground sm:px-4"
          }
        >
          {notice.text}
        </p>
      ) : null}
      {errors.length > 0 ? (
        <div>
          <p className="px-3 pt-2 text-xs font-medium text-muted-foreground sm:px-4">
            Errors: the previous version stays active until these are fixed:
          </p>
          <PolicyIssueList issues={errors} onJumpToLine={jumpToLine} />
        </div>
      ) : null}
      {pendingChange !== null ? (
        <div className="space-y-2 px-3 py-2 sm:px-4">
          <p className="text-xs font-medium text-muted-foreground">
            Pending external change{pendingChange.valid ? "" : " (invalid)"}:
          </p>
          {pendingChange.files.map((file) => (
            <pre
              key={file.file}
              className="max-h-64 overflow-auto rounded-md border border-border bg-muted/30 p-2 text-xs"
            >
              {file.file}
              {"\n"}
              {file.diff}
            </pre>
          ))}
          {pendingChange.issues.length > 0 ? (
            <PolicyIssueList issues={pendingChange.issues} onJumpToLine={jumpToLine} />
          ) : null}
          <Button
            size="sm"
            disabled={busy || !pendingChange.valid || pendingChange.liveSha256 == null}
            onClick={() => void apply()}
          >
            Apply external change
          </Button>
          {!pendingChange.valid ? (
            <p className="text-xs text-muted-foreground">
              The external version has errors and cannot be applied.
            </p>
          ) : null}
        </div>
      ) : null}
    </SettingsSection>
  );
}

function PolicyFileEditor({
  file,
  busy,
  onSave,
}: {
  file: PolicyDocumentFileSchema;
  busy: boolean;
  onSave: (content: string, baseSha256: string) => Promise<void>;
}) {
  const [content, setContent] = useState(file.content);
  const dirty = content !== file.content;
  return (
    <div className="space-y-2 px-3 py-2 sm:px-4">
      <Textarea
        aria-label={`Edit ${file.file}`}
        value={content}
        onChange={(event) => setContent(event.target.value)}
        className="max-h-[50vh]"
      />
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          disabled={!dirty || busy}
          onClick={() => void onSave(content, file.sha256)}
        >
          Save and apply
        </Button>
        {dirty ? <span className="text-xs text-muted-foreground">Unsaved changes</span> : null}
      </div>
    </div>
  );
}
