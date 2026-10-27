import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { sidebarThreadFamilyRoots } from "./familyRoots.ts";

const LOCAL = EnvironmentId.make("local");
const REMOTE = EnvironmentId.make("remote");

describe("sidebarThreadFamilyRoots", () => {
  it("deduplicates families by environment and root thread", () => {
    const root = ThreadId.make("root");
    const row = (environmentId: EnvironmentId, rootThreadId: ThreadId) => ({
      environmentId,
      lineage: { rootThreadId },
    });

    expect(
      sidebarThreadFamilyRoots([row(LOCAL, root), row(LOCAL, root), row(REMOTE, root)]),
    ).toEqual([
      { environmentId: LOCAL, rootThreadId: root },
      { environmentId: REMOTE, rootThreadId: root },
    ]);
  });
});
