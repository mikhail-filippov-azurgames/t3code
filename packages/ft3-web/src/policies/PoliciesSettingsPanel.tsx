import type { EnvironmentId } from "@t3tools/contracts";
import { parseDocRef } from "@t3tools/ft3-docs/contracts";
import {
  FEATURE_IDS,
  resolveFeatureStates,
  type FeatureId,
  type PolicyDocumentSource,
} from "@t3tools/ft3-policies/contracts";
import type { PolicyDocumentKey } from "@t3tools/ft3-policies/contracts";
import type {
  PoliciesBrowseServerDirectoryResult,
  PoliciesGetSnapshotResult,
  PoliciesSaveDocumentResult,
  PolicyDocumentFileSchema,
  PolicyDocumentStatusSchema,
  PolicyIssueSchema,
} from "@t3tools/ft3-policies/rpc-contracts";
import { readPolicySettings, type PoliciesSettings } from "@t3tools/ft3-policies/settings";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import { useCallback, useEffect, useRef, useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
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
  type PolicyAttentionCause,
  featureOffReasonText,
  lineStartOffset,
  policyAttentionCauses,
  policyDocumentActionLabel,
  policyDocumentBadge,
  policyDocumentBadgeHint,
  policyDocumentReadOnlyNote,
  policyDocumentSourceLabel,
  policyFileLabel,
} from "./policies.logic.ts";
import { policiesEnvironment } from "./state.ts";

/** One editor is mounted at a time, so a constant panel id is enough. */
const POLICY_FILE_PANEL_ID = "policy-document-file-panel";
const policyFileTabId = (file: string) => `policy-document-file-tab:${file}`;
/** The banner's document causes scroll to and select these rows. */
const policyDocumentRowId = (key: PolicyDocumentKey) => `ft3-policy-document-row:${key}`;
const policyFeatureRowId = (feature: FeatureId) => `ft3-policy-feature-row:${feature}`;

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
  const setDocument = useAtomCommand(policiesEnvironment.setDocument, { reportFailure: false });
  const setFeature = useAtomCommand(policiesEnvironment.setFeature, { reportFailure: false });

  const [selectedKey, setSelectedKey] = useState<PolicyDocumentKey | null>(null);
  // Command results carry the freshest snapshot; a newer query result wins once its refresh lands.
  const [commandResult, setCommandResult] = useState<PoliciesGetSnapshotResult | null>(null);
  const [applyEditsEnabled, setApplyEditsEnabled] = useState(policySettings.applyExternalEdits);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [togglePending, setTogglePending] = useState(false);
  const [featureOverrides, setFeatureOverrides] = useState<Partial<Record<FeatureId, boolean>>>({});
  const [featureError, setFeatureError] = useState<string | null>(null);

  // The snapshot configVersion is monotonic, so it orders a command result against a query refresh.
  const snapshot =
    commandResult !== null &&
    (snapshotQuery.data === null || commandResult.configVersion >= snapshotQuery.data.configVersion)
      ? commandResult
      : snapshotQuery.data;
  const selected = snapshot?.documents.find((document) => document.key === selectedKey) ?? null;
  const attentionCauses = snapshot === null ? [] : policyAttentionCauses(snapshot);
  const requestedFeatures: PoliciesSettings["features"] = {
    ...policySettings.features,
    ...featureOverrides,
  };
  // The server computes effective features from the applied documents; only an
  // in-flight toggle re-resolves locally so the switch flips before the answer.
  const featureStates =
    snapshot === null
      ? null
      : Object.keys(featureOverrides).length === 0
        ? snapshot.features
        : resolveFeatureStates({
            requested: requestedFeatures,
            requirements: snapshot.requirements,
          });

  const changeFeature = async (feature: FeatureId, enabled: boolean) => {
    if (environmentId === null) return;
    const previous = requestedFeatures[feature];
    setFeatureOverrides((current) => ({ ...current, [feature]: enabled }));
    setFeatureError(null);
    const result = await setFeature({ environmentId, input: { feature, enabled } });
    if (AsyncResult.isFailure(result)) {
      setFeatureOverrides((current) => ({ ...current, [feature]: previous }));
      const cause = squashAtomCommandFailure(result);
      setFeatureError(cause instanceof Error ? cause.message : "Could not save the feature.");
      return;
    }
    setFeatureOverrides({});
    onSnapshot(result.value.snapshot);
  };

  const changeDocumentSource = async (
    key: PolicyDocumentKey,
    source: PolicyDocumentSource,
  ): Promise<string | null> => {
    if (environmentId === null) return "Connect to an environment first.";
    const result = await setDocument({ environmentId, input: { key, source } });
    if (AsyncResult.isFailure(result)) {
      const cause = squashAtomCommandFailure(result);
      return cause instanceof Error ? cause.message : "Could not change the document source.";
    }
    onSnapshot(result.value.snapshot);
    return null;
  };

  const onSnapshot = (fresh: PoliciesGetSnapshotResult) => {
    setCommandResult(fresh);
    snapshotQuery.refresh();
  };

  /** A banner cause selects its document row, or scrolls to the feature's toggle row. */
  const jumpToAttentionCause = (cause: PolicyAttentionCause) => {
    if (cause.kind === "document") setSelectedKey(cause.key);
    const rowId =
      cause.kind === "document"
        ? policyDocumentRowId(cause.key)
        : policyFeatureRowId(cause.feature);
    document.getElementById(rowId)?.scrollIntoView({ block: "nearest" });
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
          {attentionCauses.length > 0 ? (
            <div className="px-3 py-2 sm:px-4">
              <p className="text-sm font-medium text-warning">Attention:</p>
              <ul className="list-disc space-y-1 pl-5">
                {attentionCauses.map((cause) => (
                  <li
                    key={`${cause.kind}:${cause.kind === "feature" ? cause.feature : cause.key}:${cause.text}`}
                  >
                    <button
                      type="button"
                      className="text-left text-sm text-warning underline-offset-2 hover:underline"
                      onClick={() => jumpToAttentionCause(cause)}
                    >
                      {cause.text}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
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

      {selected !== null && environmentId !== null ? (
        <PolicyDocumentEditor
          key={selected.key}
          environmentId={environmentId}
          document={selected}
          onSnapshot={onSnapshot}
          onChangeSource={changeDocumentSource}
        />
      ) : null}

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

      {snapshot !== null && featureStates !== null && environmentId !== null ? (
        <SettingsSection id="ft3-policies-features" title="Feature toggles">
          <p className="px-3 text-xs text-muted-foreground sm:px-4">
            A feature runs when it is on and its dependencies and policy documents are valid.
            Changes apply without a restart. Runtime gates check board, mail, planning and documents
            today.
          </p>
          {FEATURE_IDS.map((feature) => {
            const state = featureStates[feature];
            const reason = state.requestedEnabled ? featureOffReasonText(state.offReason) : null;
            return (
              <SettingsRow
                key={feature}
                id={policyFeatureRowId(feature)}
                title={feature}
                description={reason ?? undefined}
                control={
                  <Switch
                    aria-label={`Enable ${feature}`}
                    checked={requestedFeatures[feature]}
                    onCheckedChange={(checked) => void changeFeature(feature, Boolean(checked))}
                  />
                }
              />
            );
          })}
          {featureError !== null ? (
            <p className="px-3 py-2 text-sm text-destructive sm:px-4">{featureError}</p>
          ) : null}
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
  const hint = policyDocumentBadgeHint(document);
  const label = POLICY_DOCUMENT_KEY_LABELS[document.key];
  const action = policyDocumentActionLabel(document.source);
  return (
    <div
      id={policyDocumentRowId(document.key)}
      className="flex items-center gap-2 px-3 py-2 sm:px-4"
    >
      <div className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{label}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {policyDocumentSourceLabel(document.source)}
        </span>
      </div>
      <Badge variant={POLICY_DOCUMENT_BADGE_VARIANTS[badge]} title={hint ?? undefined}>
        {POLICY_DOCUMENT_BADGE_LABELS[badge]}
      </Badge>
      <Button
        size="xs"
        variant={selected ? "default" : "outline"}
        aria-pressed={selected}
        aria-label={`${action} ${label}`}
        onClick={onSelect}
      >
        {action}
      </Button>
    </div>
  );
}

function PolicyIssueList({
  issues,
  onJumpToLine,
}: {
  issues: ReadonlyArray<PolicyIssueSchema>;
  onJumpToLine: (file: string | null, line: number) => void;
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
                aria-label={`Go to line ${line}`}
                className="shrink-0 font-mono text-xs text-info underline-offset-2 hover:underline"
                onClick={() => onJumpToLine(issue.file ?? null, line)}
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
  onChangeSource,
}: {
  environmentId: EnvironmentId;
  document: PolicyDocumentStatusSchema;
  onSnapshot: (snapshot: PoliciesGetSnapshotResult) => void;
  onChangeSource: (key: PolicyDocumentKey, source: PolicyDocumentSource) => Promise<string | null>;
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
  const pendingJumpRef = useRef<number | null>(null);

  const files = readQuery.data?.status === "ok" ? readQuery.data.files : [];
  const mainFile = readQuery.data?.status === "ok" ? readQuery.data.mainFile : null;
  const currentFileName =
    files.find((file) => file.file === activeFile)?.file ??
    files.find((file) => file.file === mainFile)?.file ??
    files[0]?.file ??
    null;
  const currentFile: PolicyDocumentFileSchema | null =
    files.find((file) => file.file === currentFileName) ?? null;

  const focusLine = (line: number) => {
    const textarea = editorContainerRef.current?.querySelector("textarea");
    if (textarea === null || textarea === undefined) return;
    textarea.focus();
    const offset = lineStartOffset(textarea.value, line);
    textarea.setSelectionRange(offset, offset);
  };

  const errors = document.errors;
  const pendingChange = pendingQuery.data?.change ?? null;
  const readOnly = document.source.kind === "builtin";

  const jumpToLine = (file: string | null, line: number) => {
    if (file !== null && file !== "" && file !== currentFileName) {
      pendingJumpRef.current = line;
      setActiveFile(file);
      return;
    }
    focusLine(line);
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the jump lands once the switched file's editor has mounted
  useEffect(() => {
    if (currentFileName === null) return;
    const pending = pendingJumpRef.current;
    if (pending === null) return;
    pendingJumpRef.current = null;
    const textarea = editorContainerRef.current?.querySelector("textarea");
    if (textarea === null || textarea === undefined) return;
    textarea.focus();
    const offset = lineStartOffset(textarea.value, pending);
    textarea.setSelectionRange(offset, offset);
  }, [currentFileName]);

  const save = async (file: string, content: string, baseSha256: string) => {
    setBusy(true);
    setNotice(null);
    setRequestError(null);
    const result = await saveDocument({
      environmentId,
      input: { key: document.key, file, baseSha256, content },
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
    } else if (readOnly) {
      setNotice({ kind: "info", text: "Built-in templates are read-only; nothing was saved." });
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

  const readOnlyNote = policyDocumentReadOnlyNote(document.source);
  const unappliedHint = policyDocumentBadgeHint(document);

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
      {readQuery.error !== null ? (
        <p className="px-3 py-2 text-sm text-destructive sm:px-4">
          Could not load this document: {readQuery.error}
        </p>
      ) : null}
      {readQuery.data?.status === "unavailable" ? (
        <p className="px-3 py-2 text-sm text-destructive sm:px-4">
          This document is unavailable.
          {readQuery.data.issues.map((issue) => (
            <span key={`${issue.code}:${issue.message}`}> {issue.message}</span>
          ))}
        </p>
      ) : null}
      {readOnlyNote !== null ? (
        <p className="px-3 pt-2 text-xs text-muted-foreground sm:px-4">{readOnlyNote}</p>
      ) : null}
      {unappliedHint !== null ? (
        <p className="px-3 pt-1 text-xs text-muted-foreground sm:px-4">{unappliedHint}</p>
      ) : null}
      <PolicyDocumentSourceControl
        key={JSON.stringify(document.source)}
        environmentId={environmentId}
        document={document}
        onChange={async (key, source) => {
          const failure = await onChangeSource(key, source);
          if (failure === null) readQuery.refresh();
          return failure;
        }}
      />
      {files.length > 1 ? (
        <div
          className="flex flex-wrap gap-1 px-3 pt-2 sm:px-4"
          role="tablist"
          aria-label="Document files"
          onKeyDown={(event) => {
            const count = files.length;
            if (count < 2) return;
            const current = files.findIndex((file) => file.file === currentFileName);
            const target =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? count - 1
                  : event.key === "ArrowRight"
                    ? current + 1
                    : event.key === "ArrowLeft"
                      ? current - 1
                      : current;
            if (target === current || target < 0 || target >= count) return;
            event.preventDefault();
            setActiveFile(files[target]!.file);
            const tabs = event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]');
            tabs[target]?.focus();
          }}
        >
          {files.map((file) => {
            const selected = file.file === currentFileName;
            return (
              <Button
                key={file.file}
                size="xs"
                variant={selected ? "default" : "outline"}
                role="tab"
                id={policyFileTabId(file.file)}
                aria-selected={selected}
                aria-controls={POLICY_FILE_PANEL_ID}
                tabIndex={selected ? 0 : -1}
                onClick={() => setActiveFile(file.file)}
              >
                {policyFileLabel(document.key, file.file)}
              </Button>
            );
          })}
        </div>
      ) : null}
      {currentFile !== null ? (
        <div
          ref={editorContainerRef}
          role="tabpanel"
          id={POLICY_FILE_PANEL_ID}
          aria-labelledby={files.length > 1 ? policyFileTabId(currentFile.file) : undefined}
        >
          <PolicyFileEditor
            key={`${currentFile.file}:${currentFile.sha256}`}
            documentKey={document.key}
            file={currentFile}
            busy={busy}
            readOnly={readOnly}
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
            {document.applied === null
              ? "Errors: no version is in effect until these are fixed:"
              : "Errors: the previous version stays active until these are fixed:"}
          </p>
          <PolicyIssueList issues={errors} onJumpToLine={jumpToLine} />
        </div>
      ) : null}
      {pendingQuery.error !== null ? (
        <p className="px-3 py-2 text-sm text-destructive sm:px-4">
          Could not load the pending change: {pendingQuery.error}
        </p>
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

function PolicyDocumentSourceControl({
  environmentId,
  document,
  onChange,
}: {
  environmentId: EnvironmentId;
  document: PolicyDocumentStatusSchema;
  onChange: (key: PolicyDocumentKey, source: PolicyDocumentSource) => Promise<string | null>;
}) {
  const initialAddress =
    document.source.kind === "doc"
      ? document.source.address.kind === "id"
        ? `oc://doc/${document.source.address.stableId}`
        : document.source.address.relPath
      : document.source.kind === "path"
        ? document.source.path
        : "";
  const [kind, setKind] = useState<PolicyDocumentSource["kind"]>(document.source.kind);
  const [address, setAddress] = useState(initialAddress);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [storePickerOpen, setStorePickerOpen] = useState(false);
  const [serverPickerOpen, setServerPickerOpen] = useState(false);
  const browseServerDirectory = useAtomCommand(policiesEnvironment.browseServerDirectory, {
    reportFailure: false,
  });
  const [serverDirectory, setServerDirectory] = useState("");
  const [serverListing, setServerListing] = useState<PoliciesBrowseServerDirectoryResult | null>(
    null,
  );
  const [serverBrowseError, setServerBrowseError] = useState<string | null>(null);
  const [serverBrowsePending, setServerBrowsePending] = useState(false);

  const loadServerDirectory = useCallback(
    async (target: string) => {
      setServerBrowsePending(true);
      setServerBrowseError(null);
      const result = await browseServerDirectory({ environmentId, input: { directory: target } });
      setServerBrowsePending(false);
      if (AsyncResult.isFailure(result)) {
        const cause = squashAtomCommandFailure(result);
        setServerBrowseError(
          cause instanceof Error ? cause.message : "Could not list the server directory.",
        );
        return;
      }
      setServerDirectory(target);
      setServerListing(result.value);
    },
    [browseServerDirectory, environmentId],
  );

  /** Opening the picker lists the current source's directory; the click is the trigger. */
  const openServerPicker = () => {
    setServerPickerOpen(true);
    const start = serverDirectoryOf(address);
    setServerDirectory(start === "" ? address : start);
    if (start !== "") void loadServerDirectory(start);
  };

  const sourceOf = (): PolicyDocumentSource | string => {
    if (kind === "builtin") return { kind: "builtin" };
    const value = address.trim();
    if (kind === "path") {
      return value === ""
        ? "Enter the absolute path of a server file."
        : { kind: "path", path: value };
    }
    if (value === "") return "Enter a store path or an oc://doc/<id> link.";
    const parsed = parseDocRef(value);
    return parsed === null
      ? `"${value}" is not a store path or an oc://doc/<id> link.`
      : { kind: "doc", address: parsed };
  };

  const submit = async () => {
    const source = sourceOf();
    if (typeof source === "string") {
      setError(source);
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    const failure = await onChange(document.key, source);
    setBusy(false);
    if (failure !== null) {
      setError(failure);
      return;
    }
    setNotice("Source updated.");
  };

  const desired = sourceOf();
  const unchanged =
    typeof desired !== "string" && JSON.stringify(desired) === JSON.stringify(document.source);

  return (
    <div className="space-y-2 px-3 py-2 sm:px-4">
      <div className="flex flex-wrap items-center gap-2">
        <label
          className="text-xs text-muted-foreground"
          htmlFor={`policy-source-kind:${document.key}`}
        >
          Source
        </label>
        <select
          id={`policy-source-kind:${document.key}`}
          className="rounded-md border border-border bg-background px-2 py-1 text-xs"
          value={kind}
          onChange={(event) => {
            setKind(event.target.value as PolicyDocumentSource["kind"]);
            setError(null);
            setNotice(null);
          }}
        >
          <option value="builtin">Built-in template</option>
          <option value="doc">Store document</option>
          <option value="path">Server file</option>
        </select>
        {kind === "builtin" ? null : (
          <>
            <Input
              aria-label={`Source ${kind === "doc" ? "store path or oc:// link" : "server path"}`}
              className="h-7 w-72 text-xs"
              placeholder={
                kind === "doc" ? "roles/roles.json or oc://doc/<id>" : "/srv/ft3/roles.json"
              }
              value={address}
              onChange={(event) => {
                setAddress(event.target.value);
                setError(null);
                setNotice(null);
              }}
            />
            <Button
              size="xs"
              variant="outline"
              aria-label={kind === "doc" ? "Browse store documents" : "Browse server files"}
              onClick={() => (kind === "doc" ? setStorePickerOpen(true) : openServerPicker())}
            >
              Browse…
            </Button>
          </>
        )}
        <Button
          size="xs"
          variant="outline"
          disabled={busy || unchanged}
          onClick={() => void submit()}
        >
          Change source
        </Button>
      </div>
      {error !== null ? <p className="text-xs text-destructive">{error}</p> : null}
      {notice !== null ? <p className="text-xs text-muted-foreground">{notice}</p> : null}
      <StoreDocumentPickerDialog
        environmentId={environmentId}
        open={storePickerOpen}
        onOpenChange={setStorePickerOpen}
        onSelect={(relPath) => {
          setAddress(relPath);
          setError(null);
          setNotice(null);
        }}
      />
      <ServerFilePickerDialog
        open={serverPickerOpen}
        onOpenChange={setServerPickerOpen}
        directory={serverDirectory}
        onDirectoryChange={setServerDirectory}
        listing={serverListing}
        pending={serverBrowsePending}
        error={serverBrowseError}
        onNavigate={(target) => void loadServerDirectory(target)}
        onSelect={(path) => {
          setAddress(path);
          setError(null);
          setNotice(null);
        }}
      />
    </div>
  );
}

/** The directory to start browsing in for a server path: its parent when the path names a file. */
function serverDirectoryOf(path: string): string {
  const trimmed = path.trim().replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (index < 0) return "";
  if (!trimmed.slice(index + 1).includes(".")) return trimmed;
  const parent = trimmed.slice(0, index);
  // Keep the root separator so a file at a drive or filesystem root lists that root.
  return parent === "" || /^[A-Za-z]:$/.test(parent) ? trimmed.slice(0, index + 1) : parent;
}

function StoreDocumentPickerDialog({
  environmentId,
  open,
  onOpenChange,
  onSelect,
}: {
  environmentId: EnvironmentId;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (relPath: string) => void;
}) {
  const [query, setQuery] = useState("");
  const trimmed = query.trim();
  const listQuery = useEnvironmentQuery(
    open
      ? policiesEnvironment.listStoreDocuments({
          environmentId,
          input: trimmed === "" ? {} : { query: trimmed },
        })
      : null,
  );
  const documents = listQuery.data?.documents ?? [];
  if (!open) return null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Choose a store document</DialogTitle>
          <DialogDescription>
            Pick a document from the Corvis document store; the source field is filled with its
            store path.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Input
            aria-label="Search documents"
            placeholder="Search by title, path or text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {listQuery.isPending ? (
            <p className="text-sm text-muted-foreground">Loading documents…</p>
          ) : null}
          {listQuery.error !== null ? (
            <p className="text-sm text-destructive">Could not load documents: {listQuery.error}</p>
          ) : null}
          {!listQuery.isPending && listQuery.error === null && documents.length === 0 ? (
            <p className="text-sm text-muted-foreground">No documents found.</p>
          ) : null}
          <ul className="max-h-72 space-y-1 overflow-auto">
            {documents.map((document) => (
              <li key={document.stableId}>
                <button
                  type="button"
                  className="block w-full rounded-md px-2 py-1 text-left hover:bg-muted"
                  onClick={() => {
                    onSelect(document.relPath);
                    onOpenChange(false);
                  }}
                >
                  <span className="block truncate text-sm">{document.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {document.relPath}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </DialogPopup>
    </Dialog>
  );
}

function ServerFilePickerDialog({
  open,
  onOpenChange,
  directory,
  onDirectoryChange,
  listing,
  pending,
  error,
  onNavigate,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  directory: string;
  onDirectoryChange: (directory: string) => void;
  listing: PoliciesBrowseServerDirectoryResult | null;
  pending: boolean;
  error: string | null;
  onNavigate: (directory: string) => void;
  onSelect: (path: string) => void;
}) {
  if (!open) return null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Choose a server file</DialogTitle>
          <DialogDescription>
            Browse the server's filesystem; only .json and .md files are listed.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <div className="flex-1">
              <Input
                aria-label="Server directory"
                size="compact"
                placeholder="/srv/ft3"
                value={directory}
                onChange={(event) => onDirectoryChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") onNavigate(directory.trim());
                }}
              />
            </div>
            <Button
              size="xs"
              variant="outline"
              disabled={pending || directory.trim() === ""}
              onClick={() => onNavigate(directory.trim())}
            >
              List
            </Button>
          </div>
          {pending ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
          {error !== null ? <p className="text-sm text-destructive">{error}</p> : null}
          {listing?.truncated ? (
            <p className="text-sm text-muted-foreground">
              This folder has more entries than can be listed; type a more specific path.
            </p>
          ) : null}
          {listing !== null && !pending ? (
            <ul className="max-h-72 space-y-1 overflow-auto">
              {listing.parent !== null ? (
                <li>
                  <button
                    type="button"
                    className="block w-full rounded-md px-2 py-1 text-left text-sm hover:bg-muted"
                    onClick={() => onNavigate(listing?.parent ?? "")}
                  >
                    ..
                  </button>
                </li>
              ) : null}
              {listing.directories.map((entry) => (
                <li key={entry.path}>
                  <button
                    type="button"
                    className="block w-full rounded-md px-2 py-1 text-left text-sm hover:bg-muted"
                    onClick={() => onNavigate(entry.path)}
                  >
                    {entry.name}/
                  </button>
                </li>
              ))}
              {listing.files.map((entry) => (
                <li key={entry.path}>
                  <button
                    type="button"
                    className="block w-full rounded-md px-2 py-1 text-left hover:bg-muted"
                    onClick={() => {
                      onSelect(entry.path);
                      onOpenChange(false);
                    }}
                  >
                    <span className="block truncate text-sm">{entry.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {entry.path}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {listing !== null &&
          !pending &&
          listing.directories.length === 0 &&
          listing.files.length === 0 ? (
            <p className="text-sm text-muted-foreground">No policy files here.</p>
          ) : null}
        </div>
      </DialogPopup>
    </Dialog>
  );
}

function PolicyFileEditor({
  documentKey,
  file,
  busy,
  readOnly,
  onSave,
}: {
  documentKey: PolicyDocumentKey;
  file: PolicyDocumentFileSchema;
  busy: boolean;
  readOnly: boolean;
  onSave: (file: string, content: string, baseSha256: string) => Promise<void>;
}) {
  const [content, setContent] = useState(file.content);
  const dirty = content !== file.content;
  const label = policyFileLabel(documentKey, file.file);
  return (
    <div className="space-y-2 px-3 py-2 sm:px-4">
      <Textarea
        aria-label={readOnly ? `View ${label}` : `Edit ${label}`}
        value={content}
        readOnly={readOnly}
        onChange={(event) => setContent(event.target.value)}
        className="max-h-[50vh]"
      />
      {readOnly ? null : (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            disabled={!dirty || busy}
            onClick={() => void onSave(file.file, content, file.sha256)}
          >
            Save and apply
          </Button>
          {dirty ? <span className="text-xs text-muted-foreground">Unsaved changes</span> : null}
        </div>
      )}
    </div>
  );
}
