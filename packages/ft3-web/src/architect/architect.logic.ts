import type {
  ArchitectCoordinatorArchitectSidebarSnapshot,
  ArchitectPublishableRecord,
  ArchitectureReviewRecord,
  CoordinatorArchitectBinding,
} from "@t3tools/ft3-architect/contracts";

export function selectArchitectSidebarSnapshot(input: {
  readonly byCoordinator: ArchitectCoordinatorArchitectSidebarSnapshot | null;
  readonly byArchitect: ArchitectCoordinatorArchitectSidebarSnapshot | null;
}): ArchitectCoordinatorArchitectSidebarSnapshot | null {
  return input.byCoordinator ?? input.byArchitect;
}

export function canShowArchitectPublishButton(input: {
  readonly isArchitectThread: boolean;
  readonly binding: CoordinatorArchitectBinding | null;
  readonly publishableCount: number;
}): boolean {
  return (
    input.isArchitectThread &&
    input.binding !== null &&
    input.binding.status === "active" &&
    input.publishableCount > 0
  );
}

export function resolveArchitectReviewAttention(
  reviews: ReadonlyArray<Pick<ArchitectureReviewRecord, "status">>,
): ReadonlyArray<{ readonly status: "open" | "answered" | "published"; readonly count: number }> {
  const counts = new Map<"open" | "answered" | "published", number>();
  for (const review of reviews) {
    if (review.status === "open" || review.status === "answered" || review.status === "published") {
      counts.set(review.status, (counts.get(review.status) ?? 0) + 1);
    }
  }
  return (["open", "answered", "published"] as const).flatMap((status) => {
    const count = counts.get(status) ?? 0;
    return count > 0 ? [{ status, count }] : [];
  });
}

export function visibleArchitectPublications(
  publishable: ReadonlyArray<ArchitectPublishableRecord>,
  publishedReviewIds: ReadonlySet<string>,
): ReadonlyArray<ArchitectPublishableRecord> {
  return publishable.filter((record) => !publishedReviewIds.has(record.reviewId));
}

export function architectRouteLabel(binding: CoordinatorArchitectBinding | null): string {
  const selected = binding?.routingEvidence?.consideredCandidates.at(-1) ?? null;
  return selected === null || selected === undefined
    ? "Bound"
    : `${selected.providerInstanceId} \u00b7 ${selected.model}`;
}

export function architectPublicationIdempotencyKey(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

export function buildArchitectReplacePrompt(input: {
  readonly architectThreadId: string;
  readonly taskEffort: string;
  readonly reason: string;
  readonly preferredTarget?: {
    readonly instanceId: string;
    readonly driverKind: string;
    readonly model: string;
  };
}): string {
  return [
    "Replace the bound Architect using architect_replace after checking the accepted architecture routing policy and saving the selection rationale to OpenContext.",
    `Current Architect thread: ${input.architectThreadId}`,
    `Task effort: ${input.taskEffort}`,
    `Human preferred target: ${input.preferredTarget?.instanceId ?? "unspecified"} (${input.preferredTarget?.driverKind ?? "unknown"}) / ${input.preferredTarget?.model ?? "unspecified"}`,
    `Reason: ${input.reason}`,
    "Verify that the preference is eligible for role=architecture and the live provider's read-only permission envelope. Replacement soft-deletes the prior binding and revokes its credential after the durable transition.",
    "Read the accepted architecture routing policy from OpenContext; its current accepted revision is authoritative.",
  ].join("\n\n");
}
