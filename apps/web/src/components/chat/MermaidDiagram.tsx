import { useEffect, useState } from "react";
import { sanitizeMermaidSvg } from "./mermaidSvgSanitize";

type MermaidRenderState =
  | { readonly kind: "pending" }
  | { readonly kind: "ready"; readonly svg: string }
  | { readonly kind: "error"; readonly message: string };

let mermaidModulePromise: Promise<typeof import("mermaid")> | undefined;
let renderSequence = 0;
let renderQueue: Promise<void> = Promise.resolve();
const MAX_CACHED_DIAGRAMS = 16;
const renderCache = new Map<string, MermaidRenderState>();

function loadMermaidModule() {
  mermaidModulePromise ??= import("mermaid").catch((error: unknown) => {
    // A transient chunk/network failure must not poison every later preview.
    mermaidModulePromise = undefined;
    throw error;
  });
  return mermaidModulePromise;
}

function cacheRender(key: string, value: MermaidRenderState) {
  renderCache.delete(key);
  renderCache.set(key, value);
  if (renderCache.size > MAX_CACHED_DIAGRAMS) {
    const oldestKey = renderCache.keys().next().value;
    if (oldestKey !== undefined) renderCache.delete(oldestKey);
  }
}

function renderMermaidDiagram(code: string, theme: "light" | "dark"): Promise<MermaidRenderState> {
  // Mermaid's initialize() changes shared configuration. Serialize render
  // calls so simultaneous light/dark previews cannot borrow each other's theme.
  const render = async (): Promise<MermaidRenderState> => {
    try {
      const { default: mermaid } = await loadMermaidModule();
      // strict encodes HTML labels and disables clicks; htmlLabels keeps labels
      // in SVG <text> so foreignObject never appears; locked keys cannot be
      // loosened by a diagram's `%%init%%` directive.
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        htmlLabels: false,
        suppressErrorRendering: true,
        secure: ["securityLevel", "startOnLoad", "htmlLabels", "suppressErrorRendering"],
        theme: theme === "dark" ? "dark" : "default",
      });
      renderSequence += 1;
      const { svg } = await mermaid.render(`t3-mermaid-${renderSequence}`, code);
      return { kind: "ready", svg: sanitizeMermaidSvg(svg) };
    } catch (error) {
      return {
        kind: "error",
        message: error instanceof Error ? error.message : "Invalid Mermaid diagram",
      };
    }
  };
  const pending = renderQueue.then(render, render);
  renderQueue = pending.then(
    () => undefined,
    () => undefined,
  );
  return pending;
}

export function MermaidDiagram({
  code,
  theme,
  isStreaming,
}: {
  readonly code: string;
  readonly theme: "light" | "dark";
  readonly isStreaming: boolean;
}) {
  const [state, setState] = useState<MermaidRenderState>({ kind: "pending" });

  useEffect(() => {
    // Rendering is expensive and the fence is incomplete mid-stream, so the
    // diagram draws once when the source settles instead of per chunk.
    if (isStreaming) {
      setState({ kind: "pending" });
      return;
    }
    const cacheKey = `${theme}\u0000${code}`;
    const cached = renderCache.get(cacheKey);
    if (cached) {
      setState(cached);
      return;
    }
    let cancelled = false;
    setState({ kind: "pending" });
    void renderMermaidDiagram(code, theme).then((next) => {
      if (next.kind === "ready") cacheRender(cacheKey, next);
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, [code, theme, isStreaming]);

  if (state.kind === "ready") {
    return (
      <div
        className="chat-markdown-mermaid flex justify-center overflow-x-auto px-2 py-2"
        data-mermaid-state="ready"
        dangerouslySetInnerHTML={{ __html: state.svg }}
      />
    );
  }

  if (state.kind === "error") {
    return (
      <div
        className="chat-markdown-mermaid-error px-3 py-2 text-xs text-muted-foreground"
        data-mermaid-state="error"
        role="alert"
      >
        <p className="font-medium">Unable to render Mermaid diagram</p>
        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap [overflow-wrap:anywhere]">
          {state.message}
        </pre>
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap [overflow-wrap:anywhere]">
          {code}
        </pre>
      </div>
    );
  }

  return (
    <div
      className="chat-markdown-mermaid flex min-h-16 items-center justify-center px-2 py-2 text-xs text-muted-foreground"
      data-mermaid-state="pending"
      aria-busy="true"
    >
      Rendering diagram…
    </div>
  );
}
