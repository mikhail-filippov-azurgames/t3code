import { ProjectId, ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type {
  ArchitectCoordinatorArchitectSidebarSnapshot,
  ArchitectPublishableRecord,
  CoordinatorArchitectBinding,
} from "@t3tools/ft3-architect/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  architectPublicationIdempotencyKey,
  architectRouteLabel,
  buildArchitectReplacePrompt,
  canShowArchitectPublishButton,
  resolveArchitectReviewAttention,
  selectArchitectSidebarSnapshot,
  visibleArchitectPublications,
} from "./architect.logic.ts";

const activeBinding = (
  overrides: Partial<CoordinatorArchitectBinding> = {},
): CoordinatorArchitectBinding => ({
  bindingId: "binding-1",
  coordinatorThreadId: ThreadId.make("coordinator-1"),
  architectThreadId: ThreadId.make("arch:coordinator-1"),
  projectId: ProjectId.make("project-1"),
  architectTaskEffort: "high",
  routingEvidence: {
    policyRef: "policy",
    policyRevision: 10,
    role: "architecture",
    taskEffort: "high",
    consideredCandidates: [
      {
        alias: "L",
        providerInstanceId: ProviderInstanceId.make("codex"),
        driverKind: ProviderDriverKind.make("codex"),
        model: "gpt-6-luna",
        options: [],
        disposition: "selected",
        reason: "Policy selected this eligible route.",
      },
    ],
  },
  status: "active",
  createdAt: "2026-10-07T12:00:00.000Z",
  createdBy: ThreadId.make("coordinator-1"),
  replacedByBindingId: null,
  detachReason: null,
  createIdempotencyKey: "create-1",
  ...overrides,
});

const publication = (
  overrides: Partial<ArchitectPublishableRecord> = {},
): ArchitectPublishableRecord => ({
  reviewId: "review-1",
  origin: "coordinator-request",
  summary: "The retry is safe to run twice.",
  disposition: "recommendation",
  refs: {},
  question: "Is the retry safe to run twice?",
  ...overrides,
});

const snapshotWith = (
  publishable: ReadonlyArray<ArchitectPublishableRecord>,
  binding: CoordinatorArchitectBinding | null = activeBinding(),
): ArchitectCoordinatorArchitectSidebarSnapshot => ({ binding, reviews: [], publishable });

describe("Architect sidebar snapshot selection", () => {
  it("falls back to the architect-keyed first load before the pin reports", () => {
    const byArchitect = snapshotWith([publication()]);
    expect(
      selectArchitectSidebarSnapshot({ byCoordinator: null, byArchitect })?.publishable.map(
        (record) => record.reviewId,
      ),
    ).toEqual(["review-1"]);
  });

  it("prefers the coordinator-keyed snapshot once the pin reports", () => {
    const byCoordinator = snapshotWith([publication()]);
    const byArchitect = snapshotWith([]);
    expect(selectArchitectSidebarSnapshot({ byCoordinator, byArchitect })).toBe(byCoordinator);
  });

  it("returns null when neither source has loaded", () => {
    expect(selectArchitectSidebarSnapshot({ byCoordinator: null, byArchitect: null })).toBeNull();
  });
});

describe("Architect publish button visibility", () => {
  it("shows for the bound Architect thread with an unpublished record", () => {
    expect(
      canShowArchitectPublishButton({
        isArchitectThread: true,
        binding: activeBinding(),
        publishableCount: 1,
      }),
    ).toBe(true);
  });

  it("hides outside the bound Architect thread", () => {
    expect(
      canShowArchitectPublishButton({
        isArchitectThread: false,
        binding: activeBinding(),
        publishableCount: 1,
      }),
    ).toBe(false);
  });

  it("hides on a terminal binding or an empty publishable list", () => {
    for (const status of ["detached", "replaced"] as const) {
      expect(
        canShowArchitectPublishButton({
          isArchitectThread: true,
          binding: activeBinding({ status }),
          publishableCount: 1,
        }),
      ).toBe(false);
    }
    expect(
      canShowArchitectPublishButton({
        isArchitectThread: true,
        binding: null,
        publishableCount: 1,
      }),
    ).toBe(false);
    expect(
      canShowArchitectPublishButton({
        isArchitectThread: true,
        binding: activeBinding(),
        publishableCount: 0,
      }),
    ).toBe(false);
  });

  it("counts only records not yet published in this session", () => {
    const publishable = [
      publication({ reviewId: "review-1" }),
      publication({ reviewId: "review-2" }),
    ];
    expect(visibleArchitectPublications(publishable, new Set(["review-1"]))).toEqual([
      publishable[1],
    ]);
  });
});

describe("Architect sidebar attention and route", () => {
  it("reports open, ready and published counts without cancelled records", () => {
    const reviews = [
      { status: "open" },
      { status: "open" },
      { status: "answered" },
      { status: "published" },
      { status: "cancelled" },
    ] as const;
    expect(resolveArchitectReviewAttention(reviews)).toEqual([
      { status: "open", count: 2 },
      { status: "answered", count: 1 },
      { status: "published", count: 1 },
    ]);
  });

  it("labels the selected route and falls back for an unproven binding", () => {
    const binding = activeBinding();
    expect(architectRouteLabel(binding)).toBe("codex \u00b7 gpt-6-luna");
    expect(architectRouteLabel({ ...binding, routingEvidence: null })).toBe("Bound");
    expect(architectRouteLabel(null)).toBe("Bound");
  });
});

describe("Architect replace prompt", () => {
  it("generates distinct v4 idempotency keys for publication requests", () => {
    const first = architectPublicationIdempotencyKey();
    const second = architectPublicationIdempotencyKey();
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(second).not.toBe(first);
  });

  it("carries the reason and the policy check for role=architecture", () => {
    const prompt = buildArchitectReplacePrompt({
      architectThreadId: "arch:binding-1",
      taskEffort: "very-high",
      reason: "The current provider is unavailable.",
    });
    expect(prompt).toContain("architect_replace");
    expect(prompt).toContain("arch:binding-1");
    expect(prompt).toContain("very-high");
    expect(prompt).toContain("The current provider is unavailable.");
    expect(prompt).toContain("role=architecture");
    expect(prompt).toContain("OpenContext");
  });
});
