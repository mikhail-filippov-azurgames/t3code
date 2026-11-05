import { describe, expect, it, vi } from "vite-plus/test";

import { fakeTimers, render } from "../../../../apps/web/test/render";
import { useMailTabPolling } from "./useMailTabPolling.ts";

function Probe(props: { readonly onPoll: () => void }) {
  useMailTabPolling(props.onPoll);
  return null;
}

const setVisibility = (value: string) => {
  Object.defineProperty(document, "visibilityState", { value, configurable: true });
};

describe("useMailTabPolling", () => {
  it("polls on the interval only while the page is visible", async () => {
    using _timers = fakeTimers();
    setVisibility("visible");
    const onPoll = vi.fn();
    await using _screen = await render(<Probe onPoll={onPoll} />);

    await vi.advanceTimersByTimeAsync(45_000);
    expect(onPoll).toHaveBeenCalledTimes(3);

    // Hidden page: ticks are skipped, so the request count stops growing.
    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onPoll).toHaveBeenCalledTimes(3);

    // Visible again: the same interval resumes without a remount.
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(onPoll).toHaveBeenCalledTimes(4);
    setVisibility("visible");
  });

  it("stops polling when the tab unmounts", async () => {
    using _timers = fakeTimers();
    setVisibility("visible");
    const onPoll = vi.fn();
    await using screen = await render(<Probe onPoll={onPoll} />);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(onPoll).toHaveBeenCalledTimes(1);

    // Collapsing the panel or selecting another tab unmounts the tab.
    await screen.unmount();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onPoll).toHaveBeenCalledTimes(1);
  });
});
