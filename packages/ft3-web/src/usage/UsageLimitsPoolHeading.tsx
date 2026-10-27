import type { LimitPool } from "@t3tools/shared/usageLimits";

import { ProviderInstanceIcon } from "~/components/chat/ProviderInstanceIcon";

/** Pooled limits heading named by the instance while the native heading stays mounted. */
export function UsageLimitsPoolHeading(props: {
  readonly pool: LimitPool;
  readonly label: string;
}) {
  return (
    <h2
      data-ft3-pool-heading=""
      className="flex items-center gap-2 text-sm font-medium text-foreground"
    >
      <ProviderInstanceIcon
        driverKind={props.pool.driver}
        displayName={props.label}
        indicatorBackground="var(--background)"
        className="size-5"
        iconClassName="size-4 text-foreground/80"
      />
      {props.label}
    </h2>
  );
}
