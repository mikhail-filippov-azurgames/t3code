import { useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationReadScope,
  ProviderInstanceId,
  type EnvironmentId,
} from "@t3tools/contracts";
import { PlugIcon } from "lucide-react";

import { useEnvironmentSettings } from "~/hooks/useSettings";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentScope } from "~/state/session";
import { zavodEnvironment } from "./state.ts";
import { zavodStatusDescription } from "./statusDescription.ts";
import { ZavodActions } from "./ZavodActions.tsx";

/** The Zavod line of the welcome screen's Agents list. Absent Zavod and failed checks show nothing. */
export function ZavodWelcomeRow({
  environmentId,
  onConnected,
}: {
  readonly environmentId: EnvironmentId;
  /** Runs after a successful connect, so the agent list picks up the new instances. */
  readonly onConnected: () => void;
}) {
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  return canRead ? (
    <WelcomeZavod key={environmentId} environmentId={environmentId} onConnected={onConnected} />
  ) : null;
}

function WelcomeZavod({
  environmentId,
  onConnected,
}: {
  readonly environmentId: EnvironmentId;
  readonly onConnected: () => void;
}) {
  const query = useEnvironmentQuery(zavodEnvironment.detect({ environmentId, input: {} }));
  const canConnect = useAtomValue(zavodEnvironment.connect.permissionAtom(environmentId));
  const connected = useEnvironmentSettings(environmentId, (settings) =>
    Boolean(
      settings.providerInstances?.[ProviderInstanceId.make("zavod-claude")] &&
      settings.providerInstances?.[ProviderInstanceId.make("zavod-codex")],
    ),
  );
  const status = query.data;
  if (query.error !== null || status === null || status.state === "absent") return null;
  const supported = status.state === "on" || status.state === "off" || status.state === "mixed";

  return (
    <div className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 py-1">
      <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
        <PlugIcon className="size-[18px]" />
      </span>
      <div className="min-w-0 flex-1 basis-40">
        <span className="block truncate font-medium text-foreground text-sm">Zavod</span>
        <p className="line-clamp-2 break-words text-muted-foreground text-xs leading-relaxed">
          {zavodStatusDescription(status, connected)}
        </p>
      </div>
      {canConnect ? (
        <div className="ml-8 flex shrink-0 flex-wrap items-center gap-2 sm:ml-0">
          <ZavodActions
            environmentId={environmentId}
            connected={connected}
            disabled={query.isPending || !supported}
            size="xs"
            onConnected={onConnected}
            onSettled={query.refresh}
          />
        </div>
      ) : null}
    </div>
  );
}
