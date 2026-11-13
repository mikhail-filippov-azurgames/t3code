import { useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationReadScope,
  ProviderInstanceId,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useRef, useState } from "react";

import { SettingsRow, SettingsSection } from "~/components/settings/settingsLayout";
import { SettingsGroup } from "~/components/settings/SettingsGroup";
import { Button } from "~/components/ui/button";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { zavodEnvironment } from "./state.ts";

export function ZavodSettingsSection({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  return canRead ? <ZavodSettings key={environmentId} environmentId={environmentId} /> : null;
}

function ZavodSettings({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const query = useEnvironmentQuery(zavodEnvironment.detect({ environmentId, input: {} }));
  const canConnect = useAtomValue(zavodEnvironment.connect.permissionAtom(environmentId));
  const connect = useAtomCommand(zavodEnvironment.connect, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const connected = useEnvironmentSettings(environmentId, (settings) =>
    Boolean(
      settings.providerInstances?.[ProviderInstanceId.make("zavod-claude")] &&
      settings.providerInstances?.[ProviderInstanceId.make("zavod-codex")],
    ),
  );
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const status = query.data;
  const supported = status?.state === "on" || status?.state === "off" || status?.state === "mixed";

  const runConnect = async () => {
    if (!canConnect || !supported || query.error || inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    const result = await connect({ environmentId, input: {} });
    inFlight.current = false;
    setPending(false);
    if (result._tag === "Failure") {
      setError("Could not connect Zavod. Check the provider configuration and try again.");
    }
    query.refresh();
  };

  if (status?.state === "absent") return null;

  let description = "Checking Zavod configuration…";
  if (query.error) {
    description = "Could not check Zavod status. Refresh to try again.";
  } else if (status?.state === "on") {
    description = "Claude and Codex already use Zavod.";
  } else if (status?.state === "off") {
    description = connected
      ? "Claude and Codex go through Zavod instances."
      : "Connect Claude and Codex through Zavod.";
  } else if (status) {
    description =
      status.reason ?? "Check the Claude and Codex configuration before connecting Zavod.";
  }

  return (
    <SettingsSection title="Zavod">
      <SettingsGroup>
        <SettingsRow
          title="Claude and Codex"
          description={description}
          control={
            <div className="flex flex-wrap items-center gap-2">
              {canConnect && status ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={pending || query.isPending || query.error !== null || !supported}
                  aria-busy={pending}
                  onClick={() => void runConnect()}
                >
                  {pending ? "Connecting…" : connected ? "Reconnect" : "Connect Zavod"}
                </Button>
              ) : null}
              {query.error ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={query.isPending}
                  onClick={query.refresh}
                >
                  Refresh Zavod status
                </Button>
              ) : null}
              {error ? (
                <span role="alert" className="text-xs text-destructive">
                  {error}
                </span>
              ) : null}
            </div>
          }
        />
      </SettingsGroup>
    </SettingsSection>
  );
}
