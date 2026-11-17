import type { OrchestrationV2ProviderFailureClass, ScopedThreadRef } from "@t3tools/contracts";
import { CircleAlertIcon, XIcon } from "lucide-react";
import { memo, useMemo } from "react";

import { Alert, AlertAction, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { useQuietThreadShell } from "~/state/entities";
import { useEnvironmentProviders } from "~/state/environments";
import type { SwitchProviderTransport } from "../delegation/switchProviderDialog.logic.ts";
import { useSwitchThreadProvider } from "../delegation/useSwitchThreadProvider.ts";
import { resolvePersonalFallback } from "./fallback.ts";
import { classifyZavodFailure, type ZavodFailureKind } from "./failure.ts";

const NOTICE_TEXT: Record<ZavodFailureKind, { readonly title: string; readonly detail: string }> = {
  unavailable: {
    title: "Zavod is unreachable",
    detail: "The Zavod gateway did not respond. Check your network or VPN and retry.",
  },
  model_access_denied: {
    title: "No access to this model on Zavod",
    detail: "Your Zavod team is not allowed to use this model. Pick another model.",
  },
  transient: {
    title: "Zavod is temporarily failing",
    detail: "The gateway could not serve this model right now. Retry in a moment.",
  },
  rate_limited: {
    title: "Zavod is overloaded or a limit was reached",
    detail: "The gateway rejected the request with a rate limit. Wait and retry.",
  },
};

export function zavodFailureNoticeText(kind: ZavodFailureKind) {
  return NOTICE_TEXT[kind];
}

/** Zavod failure kind for the thread's current instance, or null to keep the generic banner. */
export function useZavodFailureKind(input: {
  readonly threadRef: ScopedThreadRef;
  readonly error: string | null;
  readonly errorClass: OrchestrationV2ProviderFailureClass | null;
  readonly errorCode: string | null;
}): ZavodFailureKind | null {
  const shell = useQuietThreadShell(input.threadRef);
  if (!input.error) return null;
  return classifyZavodFailure({
    instanceId: shell?.modelSelection.instanceId,
    errorClass: input.errorClass,
    errorCode: input.errorCode,
    message: input.error,
  });
}

export const ZavodFailureNotice = memo(function ZavodFailureNotice(props: {
  readonly threadRef: ScopedThreadRef;
  readonly kind: ZavodFailureKind;
  readonly error: string;
  readonly onDismiss?: (() => void) | undefined;
  readonly transport?: SwitchProviderTransport | undefined;
}) {
  const { threadRef, kind, error, onDismiss } = props;
  const shell = useQuietThreadShell(threadRef);
  const providers = useEnvironmentProviders().get(threadRef.environmentId);
  const fallback = useMemo(
    () => (shell && providers ? resolvePersonalFallback(shell.modelSelection, providers) : null),
    [shell, providers],
  );
  const { attemptSwitchProvider, isSwitchingProvider } = useSwitchThreadProvider({
    transport: props.transport,
  });
  const switching = isSwitchingProvider(threadRef);
  const text = NOTICE_TEXT[kind];
  return (
    <div className="pointer-events-auto mx-auto w-fit max-w-[min(48rem,calc(100%-2rem))] pt-3">
      <Alert variant="error" surface="glass" controlAlignment="first-line" data-zavod-kind={kind}>
        <CircleAlertIcon />
        <AlertDescription>
          <div className="space-y-1">
            <p className="font-medium">{text.title}</p>
            <p>{text.detail}</p>
            <details>
              <summary className="cursor-pointer select-none">Show error details</summary>
              <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-xs">{error}</pre>
            </details>
          </div>
        </AlertDescription>
        {fallback || onDismiss ? (
          <AlertAction>
            {fallback ? (
              <Button
                variant="default"
                size="sm"
                disabled={switching}
                title={`${fallback.displayName} · ${fallback.target.model}`}
                onClick={() => {
                  void attemptSwitchProvider(threadRef, fallback.target, "Zavod failure fallback.");
                }}
              >
                {switching ? "Switching…" : `Switch to ${fallback.displayName}`}
              </Button>
            ) : null}
            {onDismiss ? (
              <Button variant="ghost" size="icon-xs" aria-label="Dismiss error" onClick={onDismiss}>
                <XIcon />
              </Button>
            ) : null}
          </AlertAction>
        ) : null}
      </Alert>
    </div>
  );
});
