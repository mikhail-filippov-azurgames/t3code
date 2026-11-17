/**
 * A readable name for the computer being set up: a missing label or one that
 * only repeats the environment id falls back to the host name.
 */
export function readableEnvironmentLabel(input: {
  readonly label: string | undefined;
  readonly environmentId: string;
  readonly hostname: string | undefined;
}): string {
  const label = input.label?.trim() ?? "";
  if (label.length > 0 && label !== input.environmentId) return label;
  return input.hostname?.trim() || "this computer";
}
