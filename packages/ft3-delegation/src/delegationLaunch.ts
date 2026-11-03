import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** How a delegated child starts: as an ordinary child, or only as a mail task participant. */
export type DelegationLaunch =
  | { readonly _tag: "direct" }
  | { readonly _tag: "mail_required"; readonly role: string };

/** The seam where delegation decides how a child is launched; mail decides which roles need it. */
export class DelegationLaunchPolicy extends Context.Service<
  DelegationLaunchPolicy,
  {
    readonly launchFor: (role: string | undefined) => Effect.Effect<DelegationLaunch>;
  }
>()("@t3tools/ft3-delegation/delegationLaunch/DelegationLaunchPolicy") {}

/** No role needs mail yet, so every child launches directly. */
export const neverMailRequiredLayer: Layer.Layer<DelegationLaunchPolicy> = Layer.succeed(
  DelegationLaunchPolicy,
  DelegationLaunchPolicy.of({
    launchFor: Effect.fn("DelegationLaunchPolicy.launchFor")(() =>
      Effect.succeed({ _tag: "direct" } as const),
    ),
  }),
);
