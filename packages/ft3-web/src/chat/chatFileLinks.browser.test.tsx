import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { Cause } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../../apps/web/test/render";

import { projectEnvironment } from "~/state/projects";
import { resolveMarkdownFileLinkMeta } from "~/markdown-links";
import { clearWorkspaceMatchCache } from "./chatFileLink";
import { useRightPanelStore } from "~/rightPanelStore";
import { useFt3ChatTextExtensions } from "./useFt3ChatTextExtensions";

const { searchEntries, listEntries, unusedRunner } = vi.hoisted(() => ({
  searchEntries: vi.fn(),
  listEntries: vi.fn(),
  unusedRunner: vi.fn(),
}));

vi.mock(import("~/state/use-atom-query-runner"), async (original) => ({
  ...(await original()),
  useAtomQueryRunner: ((family: unknown) => {
    if (family === projectEnvironment.searchEntries) return searchEntries;
    if (family === projectEnvironment.listEntries) return listEntries;
    return unusedRunner;
  }) as never,
}));

vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => true,
}));

vi.mock(import("~/hooks/useTheme"), async (original) => ({
  ...(await original()),
  useRenderedAppearance: () => "dark" as const,
}));

const environmentId = EnvironmentId.make("env-file-links");
const threadRef = { environmentId, threadId: ThreadId.make("thread-file-links") };

function setup() {
  searchEntries
    .mockReset()
    .mockResolvedValue(AsyncResult.success({ entries: [], truncated: false }));
  listEntries.mockReset().mockResolvedValue(AsyncResult.success({ entries: [], truncated: false }));
  unusedRunner.mockReset();
  clearWorkspaceMatchCache();
  vi.spyOn(useRightPanelStore.getState(), "openFile")
    .mockReset()
    .mockImplementation(() => {});
}

function Harness(props: {
  readonly href: string;
  readonly meta: ReturnType<typeof resolveMarkdownFileLinkMeta>;
  readonly fallback: () => void;
}) {
  const extensions = useFt3ChatTextExtensions({
    text: props.href,
    cwd: "/tmp/project",
    threadRef,
    environmentId,
    isStreaming: false,
    fileLinkBaseDir: "/tmp/project",
  });
  const meta = props.meta;
  if (meta === null) throw new Error("expected a file link");
  return (
    <>
      <button
        type="button"
        data-testid="open-file-link"
        onClick={() => {
          void extensions.openFileLink?.({
            meta,
            panelPath: meta.workspaceRelativePath ?? props.href,
            line: undefined,
            fallback: props.fallback,
          });
        }}
      >
        open
      </button>
      {extensions.renderMarkdownLink?.({ href: props.href, label: props.href })}
    </>
  );
}

function metaFor(path: string) {
  const meta = resolveMarkdownFileLinkMeta(path, "/tmp/project");
  if (meta === null) throw new Error("expected a file link");
  return meta;
}

describe("ft3 chat file links", () => {
  it("shows Not found only when the index and the parent listing confirm absence", async () => {
    setup();
    const href = "Tests/Architecture/README.md";
    const fallback = vi.fn();
    const meta = metaFor(href);
    await using screen = await render(<Harness href={href} meta={meta} fallback={fallback} />);
    await act(async () => {
      await screen.container
        .querySelector<HTMLButtonElement>('[data-testid="open-file-link"]')!
        .click();
    });

    expect(useRightPanelStore.getState().openFile).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
    expect(screen.container.querySelectorAll('[data-markdown-file-missing="true"]')).toHaveLength(
      1,
    );
  });

  it("does not claim Not found when two sibling copies make the suffix ambiguous", async () => {
    setup();
    searchEntries.mockResolvedValue(
      AsyncResult.success({
        entries: [
          { path: "t3code/apps/web/src/components/ChatMarkdown.tsx", kind: "file" },
          { path: "t3code-muse/apps/web/src/components/ChatMarkdown.tsx", kind: "file" },
        ],
        truncated: false,
      }),
    );
    const href = "apps/web/src/components/ChatMarkdown.tsx";
    const fallback = vi.fn();
    const meta = metaFor(href);
    await using screen = await render(<Harness href={href} meta={meta} fallback={fallback} />);
    await act(async () => {
      await screen.container
        .querySelector<HTMLButtonElement>('[data-testid="open-file-link"]')!
        .click();
    });

    expect(useRightPanelStore.getState().openFile).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
    expect(screen.container.querySelectorAll('[data-markdown-file-missing="true"]')).toHaveLength(
      0,
    );
  });

  it("does not claim Not found when the index query fails", async () => {
    setup();
    searchEntries.mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("offline"))));
    const href = "apps/web/src/components/ChatMarkdown.tsx";
    const fallback = vi.fn();
    const meta = metaFor(href);
    await using screen = await render(<Harness href={href} meta={meta} fallback={fallback} />);
    await act(async () => {
      await screen.container
        .querySelector<HTMLButtonElement>('[data-testid="open-file-link"]')!
        .click();
    });

    expect(useRightPanelStore.getState().openFile).not.toHaveBeenCalled();
    expect(screen.container.querySelectorAll('[data-markdown-file-missing="true"]')).toHaveLength(
      0,
    );
  });

  it("opens the one indexed file a nested link resolves to", async () => {
    setup();
    searchEntries.mockResolvedValue(
      AsyncResult.success({
        entries: [{ path: "t3code/apps/web/src/components/ChatMarkdown.tsx", kind: "file" }],
        truncated: false,
      }),
    );
    const href = "apps/web/src/components/ChatMarkdown.tsx";
    const fallback = vi.fn();
    const meta = metaFor(href);
    await using screen = await render(<Harness href={href} meta={meta} fallback={fallback} />);
    await act(async () => {
      await screen.container
        .querySelector<HTMLButtonElement>('[data-testid="open-file-link"]')!
        .click();
    });

    expect(useRightPanelStore.getState().openFile).toHaveBeenCalledWith(
      threadRef,
      "t3code/apps/web/src/components/ChatMarkdown.tsx",
      undefined,
    );
    expect(fallback).not.toHaveBeenCalled();
    expect(screen.container.querySelectorAll('[data-markdown-file-missing="true"]')).toHaveLength(
      0,
    );
  });
});
