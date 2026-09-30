import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { MermaidDiagram } from "./MermaidDiagram";

const mermaidApi = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
}));

vi.mock("mermaid", () => ({ default: mermaidApi }));

async function mountDiagram(props: {
  readonly code: string;
  readonly theme?: "light" | "dark";
  readonly isStreaming?: boolean;
}) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(
      <MermaidDiagram
        code={props.code}
        theme={props.theme ?? "light"}
        isStreaming={props.isStreaming ?? false}
      />,
    );
  });
  return {
    renderer: renderer!,
    async update(next: {
      readonly code?: string;
      readonly theme?: "light" | "dark";
      readonly isStreaming?: boolean;
    }) {
      await act(async () => {
        renderer!.update(
          <MermaidDiagram
            code={next.code ?? props.code}
            theme={next.theme ?? props.theme ?? "light"}
            isStreaming={next.isStreaming ?? props.isStreaming ?? false}
          />,
        );
      });
    },
    async unmount() {
      await act(async () => renderer?.unmount());
      vi.unstubAllGlobals();
    },
  };
}

describe("MermaidDiagram", () => {
  beforeEach(() => {
    mermaidApi.initialize.mockReset();
    mermaidApi.render.mockReset();
  });

  it("injects only sanitized SVG after the lazy mermaid render", async () => {
    mermaidApi.render.mockResolvedValue({
      svg: '<svg><script>alert(1)</script><g onclick="x"><text>A</text></g></svg>',
    });
    const mounted = await mountDiagram({ code: "graph-inject-1\nA-->B" });
    try {
      expect(mermaidApi.render).toHaveBeenCalledTimes(1);
      const ready = mounted.renderer.root.findByProps({ "data-mermaid-state": "ready" });
      const html = (ready.props as { dangerouslySetInnerHTML: { __html: string } })
        .dangerouslySetInnerHTML.__html;
      expect(html).toContain("<text>A</text>");
      expect(html).not.toContain("<script");
      expect(html).not.toContain("onclick");
    } finally {
      await mounted.unmount();
    }
  });

  it("initializes mermaid with strict security and SVG text labels", async () => {
    mermaidApi.render.mockResolvedValue({ svg: "<svg/>" });
    const mounted = await mountDiagram({ code: "graph-strict-1\nA-->B" });
    try {
      expect(mermaidApi.initialize).toHaveBeenCalledWith(
        expect.objectContaining({
          startOnLoad: false,
          securityLevel: "strict",
          htmlLabels: false,
          suppressErrorRendering: true,
        }),
      );
    } finally {
      await mounted.unmount();
    }
  });

  it("shows a fallback for invalid diagrams without crashing", async () => {
    mermaidApi.render.mockRejectedValue(new Error("Parse error on line 2"));
    const mounted = await mountDiagram({ code: "graph-invalid-1\nA-->" });
    try {
      expect(mounted.renderer.root.findByProps({ "data-mermaid-state": "error" })).toBeTruthy();
      const tree = JSON.stringify(mounted.renderer.toJSON());
      expect(tree).toContain("Unable to render Mermaid diagram");
      expect(tree).toContain("Parse error on line 2");
      expect(tree).toContain("graph-invalid-1");
    } finally {
      await mounted.unmount();
    }
  });

  it("waits for the fence to settle and renders once instead of per stream chunk", async () => {
    mermaidApi.render.mockResolvedValue({ svg: "<svg><g/></svg>" });
    const code = "graph-stream-1\nA-->B";
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(async () => {
        renderer = create(<MermaidDiagram code={code} theme="light" isStreaming />);
      });
      expect(mermaidApi.render).not.toHaveBeenCalled();
      expect(renderer!.root.findByProps({ "data-mermaid-state": "pending" })).toBeTruthy();

      await act(async () => {
        renderer!.update(<MermaidDiagram code={code} theme="light" isStreaming />);
      });
      expect(mermaidApi.render).not.toHaveBeenCalled();

      await act(async () => {
        renderer!.update(<MermaidDiagram code={code} theme="light" isStreaming={false} />);
      });
      expect(mermaidApi.render).toHaveBeenCalledTimes(1);
      expect(renderer!.root.findByProps({ "data-mermaid-state": "ready" })).toBeTruthy();
    } finally {
      await act(async () => renderer?.unmount());
      vi.unstubAllGlobals();
    }
  });

  it("reuses a cached render for an unchanged diagram", async () => {
    mermaidApi.render.mockResolvedValue({ svg: "<svg><rect/></svg>" });
    const code = "graph-cache-1\nA-->B";
    const first = await mountDiagram({ code });
    await first.unmount();
    expect(mermaidApi.render).toHaveBeenCalledTimes(1);

    const second = await mountDiagram({ code });
    try {
      expect(mermaidApi.render).toHaveBeenCalledTimes(1);
      expect(second.renderer.root.findByProps({ "data-mermaid-state": "ready" })).toBeTruthy();
    } finally {
      await second.unmount();
    }
  });

  it("re-renders with the dark theme", async () => {
    mermaidApi.render.mockResolvedValue({ svg: "<svg/>" });
    const mounted = await mountDiagram({ code: "graph-theme-1\nA-->B", theme: "light" });
    try {
      expect(mermaidApi.initialize).toHaveBeenLastCalledWith(
        expect.objectContaining({ theme: "default" }),
      );
      await mounted.update({ code: "graph-theme-2\nA-->B", theme: "dark" });
      expect(mermaidApi.initialize).toHaveBeenLastCalledWith(
        expect.objectContaining({ theme: "dark" }),
      );
    } finally {
      await mounted.unmount();
    }
  });

  it("keeps a concurrent dark render from changing an unfinished light render", async () => {
    let finishLight!: (value: { svg: string }) => void;
    mermaidApi.render
      .mockImplementationOnce(
        () =>
          new Promise<{ svg: string }>((resolve) => {
            finishLight = resolve;
          }),
      )
      .mockResolvedValueOnce({ svg: "<svg/>" });
    const light = await mountDiagram({ code: "graph-concurrent-light\nA-->B", theme: "light" });
    const dark = await mountDiagram({ code: "graph-concurrent-dark\nA-->B", theme: "dark" });
    try {
      expect(mermaidApi.initialize).toHaveBeenCalledTimes(1);
      expect(mermaidApi.initialize).toHaveBeenLastCalledWith(
        expect.objectContaining({ theme: "default" }),
      );
      await act(async () => finishLight({ svg: "<svg/>" }));
      expect(mermaidApi.initialize).toHaveBeenCalledTimes(2);
      expect(mermaidApi.initialize).toHaveBeenLastCalledWith(
        expect.objectContaining({ theme: "dark" }),
      );
      expect(dark.renderer.root.findByProps({ "data-mermaid-state": "ready" })).toBeTruthy();
    } finally {
      await light.unmount();
      await dark.unmount();
    }
  });
});
