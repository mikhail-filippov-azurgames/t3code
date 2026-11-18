import { useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationReadScope,
  ProviderInstanceId,
  type EnvironmentId,
} from "@t3tools/contracts";

import { SettingsRow, SettingsSection } from "~/components/settings/settingsLayout";
import { SettingsGroup } from "~/components/settings/SettingsGroup";
import { Button } from "~/components/ui/button";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentScope } from "~/state/session";
import { zavodEnvironment } from "./state.ts";
import { ZavodActions } from "./ZavodActions.tsx";

export function ZavodSettingsSection({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  return canRead ? <ZavodSettings key={environmentId} environmentId={environmentId} /> : null;
}

function ZavodSettings({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const query = useEnvironmentQuery(zavodEnvironment.detect({ environmentId, input: {} }));
  const canConnect = useAtomValue(zavodEnvironment.connect.permissionAtom(environmentId));
  const connected = useEnvironmentSettings(environmentId, (settings) =>
    Boolean(
      settings.providerInstances?.[ProviderInstanceId.make("zavod-claude")] &&
      settings.providerInstances?.[ProviderInstanceId.make("zavod-codex")],
    ),
  );
  const status = query.data;
  const supported = status?.state === "on" || status?.state === "off" || status?.state === "mixed";

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
                <ZavodActions
                  environmentId={environmentId}
                  connected={connected}
                  disabled={query.isPending || query.error !== null || !supported}
                  onSettled={query.refresh}
                />
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
            </div>
          }
        />
      </SettingsGroup>
    </SettingsSection>
  );
}
