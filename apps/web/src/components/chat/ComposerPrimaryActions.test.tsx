import { createElement, useState, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act as rendererAct, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { OrchestratorMcpPublishableRecord } from "@t3tools/contracts";

const stageArtworkState = vi.hoisted(() => ({
  mode: "none" as "artwork" | "none",
  variant: null as "nightly" | "dev" | null,
}));

vi.mock("~/hooks/useSettings", () => ({
  useEnvironmentIdentificationMode: () => stageArtworkState.mode,
}));
vi.mock("../SidebarStageBackdrop", () => ({
  StageBackdropButtonArt: ({ variant }: { variant: string }) => `stage-${variant}`,
  useSidebarStageBackdropVariant: (enabled = true) => (enabled ? stageArtworkState.variant : null),
}));
vi.mock("../ui/menu", async () => {
  const React = await import("react");
  return {
    Menu: ({ children }: { children: ReactNode }) => React.createElement("div", null, children),
    MenuTrigger: ({ render, children }: { render: ReactElement; children: ReactNode }) =>
      React.cloneElement(render, undefined, children),
    MenuPopup: ({ children }: { children: ReactNode }) =>
      React.createElement("div", { role: "menu" }, children),
    MenuItem: ({ children }: { children: ReactNode }) =>
      React.createElement("div", { role: "menuitem" }, children),
  };
});

import { ComposerPrimaryActions } from "./ComposerPrimaryActions";

const preparedAdvice: OrchestratorMcpPublishableRecord = {
  reviewId: "review-advice-1",
  origin: "architect-advice",
  summary: "Keep the fallback path enabled.",
  disposition: "recommendation",
  refs: {},
};

const answeredRequest: OrchestratorMcpPublishableRecord = {
  reviewId: "review-request-1",
  origin: "coordinator-request",
  summary: "Capture one failing retry log.",
  disposition: "needs-more-evidence",
  refs: {},
  question: "Can the retry happen twice?",
};

const emptyPublishHandler = () => {};

function renderComposerWithPublications(
  publishable: ReadonlyArray<OrchestratorMcpPublishableRecord>,
  props: {
    publishingReviewId?: string | null;
    publishError?: string | null;
    onPublish?: (record: OrchestratorMcpPublishableRecord) => void | Promise<void>;
  } = {},
) {
  return renderToStaticMarkup(
    createElement(ComposerPrimaryActions, {
      compact: false,
      pendingAction: null,
      isRunning: false,
      showPlanFollowUpPrompt: false,
      promptHasText: true,
      isSendBusy: false,
      sendDisabledReason: null,
      isConnecting: false,
      isEnvironmentUnavailable: false,
      isPreparingWorktree: false,
      hasSendableContent: true,
      publishable,
      onPublish: props.onPublish ?? emptyPublishHandler,
      publishingReviewId: props.publishingReviewId ?? null,
      publishError: props.publishError ?? null,
      onPreviousPendingQuestion: () => {},
      onInterrupt: () => {},
      onImplementPlanInNewThread: () => {},
    }),
  );
}

function renderPendingActions(isRunning: boolean) {
  return renderToStaticMarkup(
    createElement(ComposerPrimaryActions, {
      compact: true,
      pendingAction: {
        questionIndex: 0,
        isLastQuestion: true,
        canAdvance: true,
        isResponding: false,
        isComplete: true,
      },
      isRunning,
      showPlanFollowUpPrompt: false,
      promptHasText: false,
      isSendBusy: false,
      sendDisabledReason: null,
      isConnecting: false,
      isEnvironmentUnavailable: false,
      isPreparingWorktree: false,
      hasSendableContent: false,
      onPreviousPendingQuestion: () => {},
      onInterrupt: () => {},
      onImplementPlanInNewThread: () => {},
    }),
  );
}

function renderRunningActions(hasSendableContent: boolean) {
  return renderToStaticMarkup(
    createElement(ComposerPrimaryActions, {
      compact: true,
      pendingAction: null,
      isRunning: true,
      showPlanFollowUpPrompt: false,
      promptHasText: hasSendableContent,
      isSendBusy: false,
      sendDisabledReason: null,
      isConnecting: false,
      isEnvironmentUnavailable: false,
      isPreparingWorktree: false,
      hasSendableContent,
      onPreviousPendingQuestion: () => {},
      onInterrupt: () => {},
      onImplementPlanInNewThread: () => {},
    }),
  );
}

function renderSendButton(sendDisabledReason: string | null = null) {
  return renderToStaticMarkup(
    createElement(ComposerPrimaryActions, {
      compact: true,
      pendingAction: null,
      isRunning: false,
      showPlanFollowUpPrompt: false,
      promptHasText: true,
      isSendBusy: false,
      sendDisabledReason,
      isConnecting: false,
      isEnvironmentUnavailable: false,
      isPreparingWorktree: false,
      hasSendableContent: true,
      onPreviousPendingQuestion: () => {},
      onInterrupt: () => {},
      onImplementPlanInNewThread: () => {},
    }),
  );
}

afterEach(() => {
  stageArtworkState.mode = "none";
  stageArtworkState.variant = null;
});

describe("ComposerPrimaryActions", () => {
  it("disables and labels the send button while feedback is uploading", () => {
    const markup = renderSendButton("Sending feedback");

    expect(markup).toContain("disabled");
    expect(markup).toContain('aria-label="Sending feedback"');
  });

  it("offers Stop generation while a running turn is waiting for user input", () => {
    expect(renderPendingActions(true)).toContain('aria-label="Stop generation"');
  });

  it("does not offer Stop generation for a pending request without a running turn", () => {
    expect(renderPendingActions(false)).not.toContain('aria-label="Stop generation"');
  });

  it("renders stage artwork inside the send button when artwork identification is active", () => {
    stageArtworkState.mode = "artwork";
    stageArtworkState.variant = "nightly";

    const markup = renderSendButton();

    expect(markup).toContain("stage-nightly");
  });

  it("hides stage artwork when artwork identification is inactive", () => {
    stageArtworkState.variant = "nightly";

    const markup = renderSendButton();

    expect(markup).not.toContain("stage-nightly");
  });

  it("renders a queue action alongside stop while running with a sendable draft", () => {
    const markup = renderRunningActions(true);

    expect(markup).toContain('aria-label="Stop generation"');
    expect(markup).toContain('aria-label="Queue message"');
    expect(markup).toContain('type="submit"');
  });

  it("keeps stop as the only action while running with an empty composer", () => {
    const markup = renderRunningActions(false);

    expect(markup).toContain('aria-label="Stop generation"');
    expect(markup).not.toContain('aria-label="Queue message"');
  });

  it("hides the publication button when the Architect snapshot has no publishable records", () => {
    expect(renderComposerWithPublications([])).not.toContain("Опубликовать координатору");
  });

  it("previews prepared advice and unanswered-by-human coordinator replies", () => {
    const adviceMarkup = renderComposerWithPublications([preparedAdvice]);
    expect(adviceMarkup).toContain("Опубликовать координатору");
    expect(adviceMarkup).toContain(preparedAdvice.summary);
    expect(adviceMarkup).toContain("Опубликовать");

    const requestMarkup = renderComposerWithPublications([answeredRequest]);
    expect(requestMarkup).toContain(answeredRequest.question!);
    expect(requestMarkup).toContain(answeredRequest.summary);
  });

  it("calls publish once and removes the item after success", async () => {
    let renderer: ReactTestRenderer | undefined;
    const publishSpy = vi.fn();
    function PublishHarness() {
      const [publishable, setPublishable] = useState([preparedAdvice]);
      const onPublish = async () => {
        publishSpy();
        setPublishable([]);
      };
      return createElement(ComposerPrimaryActions, {
        compact: false,
        pendingAction: null,
        isRunning: false,
        showPlanFollowUpPrompt: false,
        promptHasText: true,
        isSendBusy: false,
        sendDisabledReason: null,
        isConnecting: false,
        isEnvironmentUnavailable: false,
        isPreparingWorktree: false,
        hasSendableContent: true,
        publishable,
        onPublish,
        onPreviousPendingQuestion: () => {},
        onInterrupt: () => {},
        onImplementPlanInNewThread: () => {},
      });
    }

    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    try {
      await rendererAct(() => {
        renderer = create(createElement(PublishHarness));
      });
      const publishButton = renderer!.root.findByProps({
        "aria-label": `Опубликовать ${preparedAdvice.summary}`,
      });
      await rendererAct(async () => {
        publishButton.props.onClick();
        await Promise.resolve();
      });

      expect(publishSpy).toHaveBeenCalledTimes(1);
      expect(
        renderer!.root.findAllByProps({
          "aria-label": `Опубликовать ${preparedAdvice.summary}`,
        }),
      ).toHaveLength(0);
      expect(
        renderer!.root.findAllByProps({ "aria-label": "Опубликовать координатору" }),
      ).toHaveLength(0);
    } finally {
      if (renderer) await rendererAct(() => renderer!.unmount());
      vi.unstubAllGlobals();
    }
  });

  it("disables publication while sending and shows the server error", () => {
    const markup = renderComposerWithPublications([preparedAdvice], {
      publishingReviewId: preparedAdvice.reviewId,
      publishError: "The review no longer belongs to the active Architect binding.",
    });
    expect(markup).toContain("disabled");
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("The review no longer belongs to the active Architect binding.");
  });
});
