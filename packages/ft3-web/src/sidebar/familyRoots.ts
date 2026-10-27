import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

export type ThreadFamilyRoot = {
  readonly environmentId: EnvironmentId;
  readonly rootThreadId: ThreadId;
};

export function sidebarThreadFamilyRoots(
  threads: readonly {
    readonly environmentId: EnvironmentId;
    readonly lineage: { readonly rootThreadId: ThreadId };
  }[],
): ThreadFamilyRoot[] {
  const roots = new Map<string, ThreadFamilyRoot>();
  for (const thread of threads) {
    const root = {
      environmentId: thread.environmentId,
      rootThreadId: thread.lineage.rootThreadId,
    };
    roots.set(JSON.stringify([root.environmentId, root.rootThreadId]), root);
  }
  return [...roots.values()];
}
