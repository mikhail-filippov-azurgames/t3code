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
import { useNotificationsStore } from "../../state/notifications";
import { calendarEnvironment } from "./useCalendarBackend";
import { calendarRunNoticeToAppNotice } from "./calendar.logic";

export function useCalendarNoticesBackend(): void {
  const environmentId = usePrimaryEnvironmentId();
  const replaceNotices = useCalendarStore((state) => state.replaceNotices);
  const mergeNotices = useNotificationsStore((state) => state.mergeNotices);
  const query = useEnvironmentQuery(
    environmentId === null ? null : calendarEnvironment.notices({ environmentId, input: {} }),
  );

  useEffect(() => {
    if (environmentId === null) {
      replaceNotices([]);
      return;
    }
    const envelopes = (query.data?.notices ?? []).map((notice) => ({ environmentId, notice }));
    replaceNotices(envelopes);
    // The inbox outlives the server list; merge keeps one row per notice and
    // lets retention, not the server's 200-item cap, decide when it disappears.
    mergeNotices(
      envelopes.map(({ environmentId: env, notice }) => calendarRunNoticeToAppNotice(env, notice)),
    );
  }, [environmentId, query.data, replaceNotices, mergeNotices]);
}
