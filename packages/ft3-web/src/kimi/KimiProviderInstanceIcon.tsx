import type { CSSProperties } from "react";

import { providerInstanceInitials } from "@t3tools/client-runtime/state/provider-instance-display";

import { cn } from "~/lib/utils";
import { KimiIcon } from "./KimiIcon.tsx";

/** The upstream provider icon shell with the Kimi glyph in place of the ACP mark. */
export function KimiProviderInstanceIcon(props: {
  readonly displayName: string;
  readonly className?: string | undefined;
  readonly iconClassName?: string | undefined;
  readonly badgeClassName?: string | undefined;
  readonly statusDotClassName?: string | undefined;
  readonly indicatorBackground: string;
  readonly size?: "default" | "compact" | undefined;
  readonly showBadge?: boolean | undefined;
  readonly badgeContent: "initials" | "none";
  readonly accentColor: string | null | undefined;
  readonly accentStyle: CSSProperties | undefined;
}) {
  return (
    <span
      className={cn(
        "relative isolate z-30 inline-flex shrink-0 items-center justify-center overflow-visible",
        props.className,
      )}
      style={props.accentStyle}
      data-provider-accent-color={props.accentColor}
    >
      <KimiIcon className={cn("size-5 shrink-0", props.iconClassName)} aria-hidden />
      {props.statusDotClassName ? (
        <span
          className={cn(
            "pointer-events-none absolute -left-0.5 -top-0.5 z-10 size-2 rounded-full",
            props.statusDotClassName,
          )}
          style={{ boxShadow: `0 0 0 2px ${props.indicatorBackground}` }}
          aria-hidden
        />
      ) : null}
      {props.showBadge ? (
        <span
          className={cn(
            "pointer-events-none absolute right-0 bottom-0 z-10 flex h-3.5 min-w-3.5 items-center justify-center rounded-full border px-0.5 text-4xs font-semibold leading-none shadow-sm",
            props.accentColor
              ? "bg-(--provider-accent) text-(--provider-accent-foreground)"
              : "bg-card text-muted-foreground",
            props.size === "compact" &&
              "right-[-0.1875rem] bottom-[-0.1875rem] h-3 min-w-3 px-0.5 text-5xs",
            props.badgeClassName,
          )}
          style={{ borderColor: props.indicatorBackground }}
          aria-hidden
        >
          {props.badgeContent === "initials" ? providerInstanceInitials(props.displayName) : null}
        </span>
      ) : null}
    </span>
  );
}
