import type {
  EnvironmentId,
  OrchestrationV2ProviderFailureClass,
  ProviderInstanceId,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { useZavodFailureKind, ZavodFailureNotice } from "@t3tools/ft3-web/zavod";
import type { Dispatch, SetStateAction } from "react";
import {
  dismissProviderStatusBannerForSession,
  ProviderStatusBanner,
} from "./ProviderStatusBanner";
import { dismissThreadErrorBannerForSession, ThreadErrorBanner } from "./ThreadErrorBanner";

/**
 * The banners pinned above the timeline. The dismiss handlers are built here from plain
 * values, so a ChatView render that changes neither banner leaves both cached.
 */
export function ChatBannerLane(props: {
  environmentId: EnvironmentId;
  providerStatus: ServerProvider | null;
  providerStatusDismissalKey: string | null;
  onOpenProviderSetup: (instanceId: ProviderInstanceId) => void;
  threadId: ThreadId;
  threadError: string | null;
  threadErrorClass: OrchestrationV2ProviderFailureClass | null;
  threadErrorCode: string | null;
  threadErrorBannerKey: string | null;
  setThreadError: (threadId: ThreadId | null, error: string | null) => void;
  setThreadErrorBannerDismissTick: Dispatch<SetStateAction<number>>;
}) {
  const {
    providerStatus,
    providerStatusDismissalKey,
    onOpenProviderSetup,
    threadId,
    threadError,
    threadErrorClass,
    threadErrorCode,
    threadErrorBannerKey,
    setThreadError,
    setThreadErrorBannerDismissTick,
  } = props;
  const threadRef = { environmentId: props.environmentId, threadId };
  const zavodFailureKind = useZavodFailureKind({
    threadRef,
    error: threadError,
    errorClass: threadErrorClass,
    errorCode: threadErrorCode,
  });
  const dismissThreadError = () => {
    setThreadError(threadId, null);
    dismissThreadErrorBannerForSession(threadErrorBannerKey);
    setThreadErrorBannerDismissTick((tick) => tick + 1);
  };
  return (
    <div className="chat-banner-lane pointer-events-none absolute top-0 z-30 flex flex-col">
      <ProviderStatusBanner
        environmentId={props.environmentId}
        status={providerStatus}
        onDismiss={() => dismissProviderStatusBannerForSession(providerStatusDismissalKey)}
        onOpenProviderSetup={onOpenProviderSetup}
      />
      {zavodFailureKind !== null && threadError !== null ? (
        <ZavodFailureNotice
          threadRef={threadRef}
          kind={zavodFailureKind}
          error={threadError}
          onDismiss={dismissThreadError}
        />
      ) : (
        <ThreadErrorBanner
          error={threadError}
          errorClass={threadErrorClass}
          errorCode={threadErrorCode}
          onDismiss={dismissThreadError}
        />
      )}
    </div>
  );
}
