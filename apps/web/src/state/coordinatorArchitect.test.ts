import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));

import {
  architectParentKeysFromActiveChildren,
  readActiveArchitectChildren,
  reportActiveArchitectChild,
  subscribeActiveArchitectChildren,
} from "./coordinatorArchitect";

const environmentId = EnvironmentId.make("environment-1");
const keyOf = (threadId: string) =>
  scopedThreadKey(scopeThreadRef(environmentId, ThreadId.make(threadId)));

describe("active Architect children index", () => {
  it("indexes an active binding and inverts it for the sidebar forest", () => {
    const coordinatorKey = keyOf("coordinator-active");
    const architectKey = keyOf("arch:active");
    reportActiveArchitectChild({ coordinatorKey, architectKey });
    try {
      expect(readActiveArchitectChildren().get(coordinatorKey)).toBe(architectKey);
      expect(
        architectParentKeysFromActiveChildren(readActiveArchitectChildren()).get(architectKey),
      ).toBe(coordinatorKey);
    } finally {
      reportActiveArchitectChild({ coordinatorKey, architectKey: null });
    }
  });

  it("clears the entry when the binding goes terminal", () => {
    const coordinatorKey = keyOf("coordinator-terminal");
    const architectKey = keyOf("arch:terminal");
    reportActiveArchitectChild({ coordinatorKey, architectKey });
    reportActiveArchitectChild({ coordinatorKey, architectKey: null });
    expect(readActiveArchitectChildren().has(coordinatorKey)).toBe(false);
    expect(
      architectParentKeysFromActiveChildren(readActiveArchitectChildren()).has(architectKey),
    ).toBe(false);
  });

  it("drops the replaced architect once the replacement binds", () => {
    const coordinatorKey = keyOf("coordinator-replace");
    const replacedKey = keyOf("arch:replaced");
    const replacementKey = keyOf("arch:replacement");
    reportActiveArchitectChild({ coordinatorKey, architectKey: replacedKey });
    try {
      reportActiveArchitectChild({ coordinatorKey, architectKey: replacementKey });
      const parents = architectParentKeysFromActiveChildren(readActiveArchitectChildren());
      expect(parents.get(replacementKey)).toBe(coordinatorKey);
      expect(parents.has(replacedKey)).toBe(false);
    } finally {
      reportActiveArchitectChild({ coordinatorKey, architectKey: null });
    }
  });

  it("keeps other coordinators when one clears", () => {
    const firstKey = keyOf("coordinator-first");
    const secondKey = keyOf("coordinator-second");
    reportActiveArchitectChild({ coordinatorKey: firstKey, architectKey: keyOf("arch:first") });
    reportActiveArchitectChild({ coordinatorKey: secondKey, architectKey: keyOf("arch:second") });
    try {
      reportActiveArchitectChild({ coordinatorKey: firstKey, architectKey: null });
      expect(readActiveArchitectChildren().has(firstKey)).toBe(false);
      expect(readActiveArchitectChildren().get(secondKey)).toBe(keyOf("arch:second"));
    } finally {
      reportActiveArchitectChild({ coordinatorKey: secondKey, architectKey: null });
    }
  });

  it("notifies subscribers only when the index actually changes", () => {
    const coordinatorKey = keyOf("coordinator-notify");
    const architectKey = keyOf("arch:notify");
    let notifications = 0;
    const unsubscribe = subscribeActiveArchitectChildren(() => {
      notifications += 1;
    });
    try {
      reportActiveArchitectChild({ coordinatorKey, architectKey });
      expect(notifications).toBe(1);
      reportActiveArchitectChild({ coordinatorKey, architectKey });
      expect(notifications).toBe(1);
      reportActiveArchitectChild({ coordinatorKey, architectKey: null });
      expect(notifications).toBe(2);
      reportActiveArchitectChild({ coordinatorKey, architectKey: null });
      expect(notifications).toBe(2);
    } finally {
      unsubscribe();
      reportActiveArchitectChild({ coordinatorKey, architectKey: null });
    }
  });
});
