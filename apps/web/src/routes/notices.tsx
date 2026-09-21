import { createFileRoute, redirect } from "@tanstack/react-router";

import { CalendarNoticesPage } from "../components/calendar/CalendarNoticesPage";

/**
 * The notices page is a root-level route like `/calendar`, so it carries the
 * same app-shell gate rather than relying on `__root.tsx`.
 */
export const Route = createFileRoute("/notices")({
  beforeLoad: ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: CalendarNoticesPage,
});
