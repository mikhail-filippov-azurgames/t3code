import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { setMarkdownTaskChecked } from "./filePreviewMode";
import { FileMarkdownPreview, splitMarkdownFrontmatter } from "./FileMarkdownPreview";

const chatMarkdown = vi.hoisted(() => ({
  text: "",
  onTaskListChange: undefined as
    | ((input: { markerOffset: number; checked: boolean }) => void)
    | undefined,
}));

vi.mock("~/components/ChatMarkdown", () => ({
  default: (props: {
    text: string;
    onTaskListChange?: (input: { markerOffset: number; checked: boolean }) => void;
  }) => {
    chatMarkdown.text = props.text;
    chatMarkdown.onTaskListChange = props.onTaskListChange;
    return null;
  },
}));

const threadRef = scopeThreadRef(EnvironmentId.make("env-1"), ThreadId.make("thread-1"));

describe("splitMarkdownFrontmatter", () => {
  it("keeps indentation of nested YAML keys and lists", () => {
    const split = splitMarkdownFrontmatter(
      "---\nstatus: draft\ntargets:\n  - oc://doc/a\ntarget_revisions:\n  oc://doc/a: 1\n---\n\n# Body\n",
    );
    expect(split.frontmatter).toBe(
      "status: draft\ntargets:\n  - oc://doc/a\ntarget_revisions:\n  oc://doc/a: 1",
    );
    expect(split.body).toBe("\n# Body\n");
  });

  it("accepts CRLF fences and normalizes the displayed YAML", () => {
    const split = splitMarkdownFrontmatter("---\r\nstatus: draft\r\n---\r\n\r\n# Body\r\n");
    expect(split.frontmatter).toBe("status: draft");
    expect(split.body).toBe("\r\n# Body\r\n");
    expect(split.bodyStart).toBe("---\r\nstatus: draft\r\n---\r\n".length);
  });

  it("treats a missing closing fence as ordinary markdown", () => {
    const text = "---\nstatus: draft\n\n# Body\n";
    const split = splitMarkdownFrontmatter(text);
    expect(split.frontmatter).toBeNull();
    expect(split.body).toBe(text);
    expect(split.bodyStart).toBe(0);
  });

  it("leaves text without a leading fence untouched", () => {
    const text = "# Body\n\n- [ ] Task\n";
    const split = splitMarkdownFrontmatter(text);
    expect(split.frontmatter).toBeNull();
    expect(split.body).toBe(text);
    expect(split.bodyStart).toBe(0);
  });

  it("splits an empty frontmatter block", () => {
    const split = splitMarkdownFrontmatter("---\n---\n# Body\n");
    expect(split.frontmatter).toBe("");
    expect(split.body).toBe("# Body\n");
    expect(split.bodyStart).toBe("---\n---\n".length);
  });
});

describe("FileMarkdownPreview", () => {
  let renderer: ReactTestRenderer | undefined;

  afterEach(async () => {
    const mounted = renderer;
    if (mounted) await act(() => mounted.unmount());
    renderer = undefined;
    chatMarkdown.text = "";
    chatMarkdown.onTaskListChange = undefined;
    vi.restoreAllMocks();
  });

  const render = async (
    text: string,
    onTaskListChange?: (input: { markerOffset: number; checked: boolean }) => void,
  ) => {
    await act(async () => {
      renderer = create(
        <FileMarkdownPreview
          cwd="/tmp/project"
          relativePath="docs/decision.md"
          text={text}
          threadRef={threadRef}
          onTaskListChange={onTaskListChange}
        />,
      );
    });
    return renderer!;
  };

  const frontmatterText = () => {
    const pre = renderer!.root.findByType("pre");
    return pre.children.map((child) => (typeof child === "string" ? child : "")).join("");
  };

  it("shows YAML as a monospaced block without fence separators", async () => {
    await render("---\nstatus: draft\ntargets:\n  - oc://doc/a\n---\n\n# Body\n");

    const content = frontmatterText();
    expect(content).toBe("status: draft\ntargets:\n  - oc://doc/a");
    expect(content).not.toContain("---");
    expect(chatMarkdown.text).toBe("\n# Body\n");
  });

  it("reports task marker offsets against the full file when frontmatter is present", async () => {
    const text = "---\nstatus: draft\n---\n\n- [ ] Task\n";
    let edited: string | undefined;
    await render(text, ({ markerOffset, checked }) => {
      edited = setMarkdownTaskChecked(text, markerOffset, checked);
    });

    const bodyBracket = chatMarkdown.text.indexOf("[");
    expect(bodyBracket).toBeGreaterThan(0);
    await act(async () => {
      chatMarkdown.onTaskListChange!({ markerOffset: bodyBracket, checked: true });
    });

    expect(edited).toBe("---\nstatus: draft\n---\n\n- [x] Task\n");
  });

  it("keeps task marker offsets unchanged when there is no frontmatter", async () => {
    const text = "- [ ] Task\n";
    let edited: string | undefined;
    await render(text, ({ markerOffset, checked }) => {
      edited = setMarkdownTaskChecked(text, markerOffset, checked);
    });

    const bracket = chatMarkdown.text.indexOf("[");
    await act(async () => {
      chatMarkdown.onTaskListChange!({ markerOffset: bracket, checked: true });
    });

    expect(edited).toBe("- [x] Task\n");
  });

  it("renders a missing closing fence as ordinary markdown", async () => {
    const text = "---\nstatus: draft\n\n# Body\n";
    await render(text);

    expect(renderer!.root.findAllByType("pre")).toHaveLength(0);
    expect(chatMarkdown.text).toBe(text);
  });
});
