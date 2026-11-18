import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import type { ZavodCopyPersonalResult } from "@t3tools/ft3-host/rpc-contracts";
import { useRef, useState } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { useAtomCommand } from "~/state/use-atom-command";
import { zavodEnvironment } from "./state.ts";

const FAMILY_LABEL = { claude: "Claude", codex: "Codex" } as const;
const ACTION_GROUPS = [
  { action: "create", title: "Will be created" },
  { action: "overwrite", title: "Will be overwritten" },
  { action: "merge", title: "Will be merged into the existing settings" },
] as const;
const SKIP_REASON = {
  secret: "contains a secret",
  invalid: "could not be read",
  link: "broken or circular link",
} as const;

function failureStage(result: { readonly cause: unknown }): string | undefined {
  try {
    const error = squashAtomCommandFailure(
      result as Parameters<typeof squashAtomCommandFailure>[0],
    );
    if (typeof error === "object" && error !== null && "stage" in error) {
      return typeof error.stage === "string" ? error.stage : undefined;
    }
  } catch {
    // A cause that cannot be inspected falls back to the generic text.
  }
  return undefined;
}

function copyFailureText(stage: string | undefined, applying: boolean): string {
  if (stage === "state")
    return "Zavod is not ready. Connect Zavod, then copy personal settings again.";
  if (stage === "limit") {
    return "Your personal settings are too large to copy (over 5,000 files or 64 MB). Remove unused skills and try again.";
  }
  if (stage === "copy") {
    return applying
      ? "Could not finish copying personal settings. Copying is safe to repeat, so try again."
      : "Could not check personal settings. Try again.";
  }
  return "Could not copy personal settings. Try again.";
}

function PlanList({
  title,
  entries,
}: {
  readonly title: string;
  readonly entries: ReadonlyArray<{ readonly key: string; readonly label: string }>;
}) {
  if (entries.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <p className="font-medium text-foreground text-sm">
        {title} ({entries.length})
      </p>
      <ul className="flex flex-col gap-0.5 text-muted-foreground text-xs">
        {entries.map((entry) => (
          <li key={entry.key} className="break-all">
            {entry.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

function CopyPlanDialog({
  plan,
  applying,
  onConfirm,
  onClose,
}: {
  readonly plan: ZavodCopyPersonalResult | null;
  readonly applying: boolean;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}) {
  return (
    <AlertDialog open={plan !== null} onOpenChange={(open) => !open && !applying && onClose()}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Copy personal settings</AlertDialogTitle>
          <AlertDialogDescription>
            Copies your Claude and Codex instructions, skills and MCP servers into the Zavod
            instances. Credentials, history and sessions are not copied, and the route to Zavod is
            kept.
          </AlertDialogDescription>
          {plan === null ? null : (
            <div className="flex max-h-[min(20rem,45dvh)] min-h-0 flex-col gap-3 overflow-y-auto overscroll-contain text-left">
              {plan.items.length === 0 ? (
                <p className="text-muted-foreground text-sm">Nothing to copy.</p>
              ) : null}
              {ACTION_GROUPS.map(({ action, title }) => (
                <PlanList
                  key={action}
                  title={title}
                  entries={plan.items
                    .filter((item) => item.action === action)
                    .map((item) => ({
                      key: `${item.family}:${item.path}`,
                      label: `${FAMILY_LABEL[item.family]} · ${item.path}`,
                    }))}
                />
              ))}
              <PlanList
                title="Skipped"
                entries={plan.skipped.map((item) => ({
                  key: `${item.family}:${item.path}`,
                  label: `${FAMILY_LABEL[item.family]} · ${item.path} (${SKIP_REASON[item.reason]})`,
                }))}
              />
              {plan.items.some((item) => item.action === "overwrite") ? (
                <p className="text-muted-foreground text-xs">
                  Files with the same name are overwritten; nothing in the Zavod instance is
                  deleted.
                </p>
              ) : null}
            </div>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" disabled={applying} />}>
            Cancel
          </AlertDialogClose>
          <Button
            type="button"
            disabled={applying || plan === null || plan.items.length === 0}
            aria-busy={applying}
            onClick={onConfirm}
          >
            {applying ? "Copying…" : "Copy"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

/** Connect/Reconnect and "Copy personal settings", shared by Settings and the welcome screen. */
export function ZavodActions({
  environmentId,
  connected,
  disabled,
  size = "sm",
  onConnected,
  onSettled,
}: {
  readonly environmentId: EnvironmentId;
  /** Both Zavod instances exist, so there is something to copy into. */
  readonly connected: boolean;
  readonly disabled: boolean;
  /** Button size; the welcome list uses the smaller one like its other rows. */
  readonly size?: "xs" | "sm";
  /** Runs after a connect that succeeded. */
  readonly onConnected?: () => void;
  /** Runs after every connect attempt, successful or not. */
  readonly onSettled?: () => void;
}) {
  const canConnect = useAtomValue(zavodEnvironment.connect.permissionAtom(environmentId));
  const canCopy = useAtomValue(zavodEnvironment.copyPersonal.permissionAtom(environmentId));
  const connect = useAtomCommand(zavodEnvironment.connect, { reportFailure: false });
  const copy = useAtomCommand(zavodEnvironment.copyPersonal, { reportFailure: false });
  const [connecting, setConnecting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [plan, setPlan] = useState<ZavodCopyPersonalResult | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [copyNotice, setCopyNotice] = useState<string | null>(null);
  const [copyHint, setCopyHint] = useState(false);
  const inFlight = useRef(false);

  const runConnect = async () => {
    if (!canConnect || disabled || inFlight.current) return;
    inFlight.current = true;
    setConnecting(true);
    setConnectError(null);
    setCopyError(null);
    setCopyNotice(null);
    setCopyHint(false);
    const result = await connect({ environmentId, input: {} });
    inFlight.current = false;
    setConnecting(false);
    if (result._tag === "Failure") {
      setConnectError("Could not connect Zavod. Check the provider configuration and try again.");
    } else {
      setCopyHint(result.value.personalCopy === "failed");
      onConnected?.();
    }
    onSettled?.();
  };

  const runCheck = async () => {
    if (!canCopy || disabled || inFlight.current) return;
    inFlight.current = true;
    setChecking(true);
    setCopyError(null);
    setCopyNotice(null);
    setCopyHint(false);
    const result = await copy({ environmentId, input: { dryRun: true } });
    inFlight.current = false;
    setChecking(false);
    if (result._tag === "Success") setPlan(result.value);
    else if (!isAtomCommandInterrupted(result)) {
      setCopyError(copyFailureText(failureStage(result), false));
    }
  };

  const runApply = async () => {
    if (!canCopy || inFlight.current) return;
    inFlight.current = true;
    setApplying(true);
    const result = await copy({ environmentId, input: { dryRun: false } });
    inFlight.current = false;
    setApplying(false);
    setPlan(null);
    if (result._tag === "Success") {
      const skipped = result.value.skipped.length;
      setCopyNotice(
        skipped === 0
          ? "Personal settings copied."
          : `Personal settings copied. ${skipped} skipped.`,
      );
    } else if (!isAtomCommandInterrupted(result)) {
      setCopyError(copyFailureText(failureStage(result), true));
    }
  };

  return (
    <>
      {canConnect ? (
        <Button
          type="button"
          size={size}
          variant="outline"
          disabled={connecting || disabled}
          aria-busy={connecting}
          onClick={() => void runConnect()}
        >
          {connecting ? "Connecting…" : connected ? "Reconnect" : "Connect Zavod"}
        </Button>
      ) : null}
      {canCopy && connected ? (
        <Button
          type="button"
          size={size}
          variant="outline"
          disabled={connecting || checking || applying || disabled}
          aria-busy={checking}
          onClick={() => void runCheck()}
        >
          {checking ? "Checking…" : "Copy personal settings"}
        </Button>
      ) : null}
      {connectError ? (
        <span role="alert" className="text-xs text-destructive">
          {connectError}
        </span>
      ) : null}
      {copyError ? (
        <span role="alert" className="text-xs text-destructive">
          {copyError}
        </span>
      ) : null}
      {copyHint ? (
        <span role="status" className="text-xs text-muted-foreground">
          Zavod is connected, but personal settings were not copied. Use “Copy personal settings” to
          try again.
        </span>
      ) : null}
      {copyNotice ? (
        <span role="status" className="text-xs text-muted-foreground">
          {copyNotice}
        </span>
      ) : null}
      <CopyPlanDialog
        plan={plan}
        applying={applying}
        onConfirm={() => void runApply()}
        onClose={() => setPlan(null)}
      />
    </>
  );
}
