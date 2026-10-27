import type { ProviderDriverKind } from "@t3tools/contracts";
import type { FC, SVGProps } from "react";

import { cn } from "~/lib/utils";

export const KimiIcon: FC<SVGProps<SVGSVGElement>> = ({ className, ...props }) => (
  <svg
    {...props}
    viewBox="0 0 24 24"
    fill="none"
    className={cn("fill-[#111111] dark:fill-[#F5F5F5]", className)}
  >
    <path d="M4 3h4v7.2L15.4 3h5.1l-8.3 8.1L21 21h-5.2l-6.1-7.4L8 15.2V21H4V3Z" />
  </svg>
);

/** The ACP driver kind is generic, so the agent id or name identifies Kimi. */
export function isKimiProviderInstance(input: {
  readonly driverKind: ProviderDriverKind;
  readonly agentId?: string | undefined;
  readonly displayName?: string | undefined;
}): boolean {
  if (input.driverKind !== "acpRegistry") return false;
  return (
    input.agentId?.trim().toLowerCase() === "kimi" ||
    input.displayName?.trim().toLowerCase() === "kimi"
  );
}
