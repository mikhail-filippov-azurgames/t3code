export const EXECUTOR_ONLY_INSTANCES_ENV = "T3CODE_FT3_EXECUTOR_ONLY_INSTANCES";

/** Comma-separated provider instance ids that must not act as coordinators. */
export function parseExecutorOnlyInstances(value: string | undefined): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const raw of value?.split(",") ?? []) {
    const id = raw.trim();
    if (id.length > 0) ids.add(id);
  }
  return ids;
}

export function isExecutorOnlyProviderInstance(
  instanceId: string,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return parseExecutorOnlyInstances(environment[EXECUTOR_ONLY_INSTANCES_ENV]).has(
    String(instanceId),
  );
}
