import { createFileRoute } from "@tanstack/react-router";
import { PoliciesSettingsPanel } from "@t3tools/ft3-web/policies";

export const Route = createFileRoute("/_chat/settings/policies")({
  component: PoliciesSettingsPanel,
});
