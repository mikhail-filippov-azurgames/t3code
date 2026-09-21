/**
 * Binds the calendar store to the server RPCs.
 *
 * The primary environment is the calendar's home: its `calendar.list` fills the
 * store, and its create/delete commands mutate it. A missing or failed read
 * leaves the store offline with the server's own message instead of falling
 * back to events that only exist in this browser.
 *
 * @module components/calendar/useCalendarBackend
 */
import { createCalendarEnvironmentAtoms } from "@t3tools/client-runtime/state/calendar";
import { useEffect } from "react";

import { connectionAtomRuntime } from "../../connection/runtime";
import { useCalendarStore } from "../../state/calendar";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";

export const calendarEnvironment = createCalendarEnvironmentAtoms(connectionAtomRuntime);

export function useCalendarBackend(): void {
  const environmentId = usePrimaryEnvironmentId();
  const replaceEvents = useCalendarStore((state) => state.replaceEvents);
  const setTransport = useCalendarStore((state) => state.setTransport);
  const setError = useCalendarStore((state) => state.setError);
  const query = useEnvironmentQuery(
    environmentId === null ? null : calendarEnvironment.list({ environmentId, input: {} }),
  );

  useEffect(() => {
    if (environmentId === null) {
      replaceEvents([]);
      setTransport("offline");
      setError(null);
      return;
    }
    if (query.data !== null) {
      replaceEvents(query.data.events);
      setTransport("live");
      setError(null);
      return;
    }
    // A failed read keeps the last known events; the banner reports the cause.
    if (query.error !== null) {
      setTransport("offline");
      setError(query.error);
    }
  }, [environmentId, query.data, query.error, replaceEvents, setError, setTransport]);
}
