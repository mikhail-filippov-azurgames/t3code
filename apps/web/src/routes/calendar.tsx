import { createFileRoute, redirect } from "@tanstack/react-router";

import { CalendarPage } from "../components/calendar/CalendarPage";

/**
 * The schedule page needs the same app-shell gate the chat routes use, but it
 * is a root-level route like `/usage`, so the guard lives here rather than in
 * `__root.tsx`.
 */
export const Route = createFileRoute("/calendar")({
  beforeLoad: ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: CalendarPage,
});
