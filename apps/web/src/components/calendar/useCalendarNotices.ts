/**
 * Binds the run-notice stream to the calendar store.
 *
 * The primary environment's server streams the whole notice list; each change
 * replaces the store so the badges and the notices page read one source. The
 * hook is mounted in the sidebar chrome so notices arrive on any route, not
 * only while the calendar page is open.
 *
 * @module components/calendar/useCalendarNotices
 */
import { useEffect } from "react";

import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useCalendarStore } from "../../state/calendar";
import { calendarEnvironment } from "./useCalendarBackend";

export function useCalendarNoticesBackend(): void {
  const environmentId = usePrimaryEnvironmentId();
  const replaceNotices = useCalendarStore((state) => state.replaceNotices);
  const query = useEnvironmentQuery(
    environmentId === null ? null : calendarEnvironment.notices({ environmentId, input: {} }),
  );

  useEffect(() => {
    if (environmentId === null) {
      replaceNotices([]);
      return;
    }
    replaceNotices((query.data?.notices ?? []).map((notice) => ({ environmentId, notice })));
  }, [environmentId, query.data, replaceNotices]);
}
