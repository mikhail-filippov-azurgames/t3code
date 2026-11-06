import type { ScopedThreadRef } from "@t3tools/contracts";
import { GitBranch, LayoutDashboard, MessagesSquare, PanelsTopLeft } from "lucide-react";
import { lazy, Suspense, useMemo, type ComponentType } from "react";
import { useEnvironmentQuery } from "~/state/query";
import { boardEnvironment } from "./board/state.ts";

export interface Ft3Surface {
  readonly id: `ft3:${string}`;
  readonly kind: "ft3";
  readonly surfaceType: string;
}

export interface Ft3PanelProps {
  readonly threadRef: ScopedThreadRef;
  readonly visible: boolean;
}

export interface Ft3SurfaceDefinition {
  readonly component: ComponentType<Ft3PanelProps>;
  readonly icon: typeof LayoutDashboard;
  readonly title: string;
  readonly shortcut: string;
  readonly disabledReason: string;
  readonly availableWhenLead?: boolean;
  readonly available: (threadRef: ScopedThreadRef | null) => boolean;
  readonly open: (threadRef: ScopedThreadRef, openSurface: Ft3SurfaceOpener) => void;
}

export type Ft3SurfaceOpener = (ref: ScopedThreadRef, surface: Ft3Surface) => void;
const NO_LEAD_THREADS: ReadonlySet<string> = new Set();

export const ft3Surface = (surfaceType: string): Ft3Surface => ({
  id: `ft3:${surfaceType}`,
  kind: "ft3",
  surfaceType,
});

const BoardPanel = lazy(() => import("./board/BoardPanel.tsx"));
const LeadBoardSurface = lazy(() => import("./board/LeadBoardSurface.tsx"));
const CommitsPanel = lazy(() => import("./commits/CommitsPanel.tsx"));

export const ft3SurfaceRegistry: Readonly<Record<string, Ft3SurfaceDefinition>> = {
  board: {
    component: BoardPanel,
    icon: LayoutDashboard,
    title: "Board",
    shortcut: "K",
    disabledReason: "Available from a server thread.",
    available: (ref) => ref !== null,
    open: (ref, openSurface) => openSurface(ref, ft3Surface("board")),
  },
  "lead-board": {
    component: LeadBoardSurface,
    icon: MessagesSquare,
    title: "Board chat",
    shortcut: "C",
    disabledReason: "Available in a lead thread.",
    availableWhenLead: true,
    available: (ref) => ref !== null,
    open: (ref, openSurface) => openSurface(ref, ft3Surface("lead-board")),
  },
  commits: {
    component: CommitsPanel,
    icon: GitBranch,
    title: "Commit graph",
    shortcut: "G",
    disabledReason: "Available from a server thread.",
    available: (ref) => ref !== null,
    open: (ref, openSurface) => openSurface(ref, ft3Surface("commits")),
  },
};

export function normalizeFt3Surface(value: Ft3Surface): Ft3Surface[] {
  return typeof value.surfaceType === "string" &&
    Object.hasOwn(ft3SurfaceRegistry, value.surfaceType)
    ? [ft3Surface(value.surfaceType)]
    : [];
}

export function ft3SurfaceTitle(surfaceType: string): string {
  return Object.hasOwn(ft3SurfaceRegistry, surfaceType)
    ? ft3SurfaceRegistry[surfaceType]!.title
    : "Unavailable panel";
}

export function Ft3SurfaceIcon({ surfaceType }: { readonly surfaceType: string }) {
  const Icon = Object.hasOwn(ft3SurfaceRegistry, surfaceType)
    ? ft3SurfaceRegistry[surfaceType]!.icon
    : PanelsTopLeft;
  return <Icon className="size-3 shrink-0" />;
}

export function ft3SurfaceActions(
  ref: ScopedThreadRef | null,
  openSurface: Ft3SurfaceOpener,
  leadThreadIds: ReadonlySet<string> = NO_LEAD_THREADS,
) {
  return Object.values(ft3SurfaceRegistry).map((entry) => {
    const available =
      entry.available(ref) &&
      (!entry.availableWhenLead || (ref !== null && leadThreadIds.has(String(ref.threadId))));
    return {
      label: entry.title,
      icon: entry.icon,
      shortcut: entry.shortcut,
      available,
      disabledReason: entry.disabledReason,
      onClick: () => {
        if (ref !== null && available) entry.open(ref, openSurface);
      },
    };
  });
}

export function useFt3SurfaceActions(ref: ScopedThreadRef | null, openSurface: Ft3SurfaceOpener) {
  const leads = useEnvironmentQuery(
    ref === null
      ? null
      : boardEnvironment.orchestratorsList({ environmentId: ref.environmentId, input: {} }),
  );
  const leadThreadIds = useMemo(
    () => new Set((leads.data?.orchestrators ?? []).map((entry) => String(entry.threadId))),
    [leads.data],
  );
  return ft3SurfaceActions(ref, openSurface, leadThreadIds);
}

export function Ft3SurfaceContent(props: Ft3PanelProps & { readonly surfaceType: string }) {
  const entry = Object.hasOwn(ft3SurfaceRegistry, props.surfaceType)
    ? ft3SurfaceRegistry[props.surfaceType]
    : undefined;
  if (!entry || !entry.available(props.threadRef)) {
    return (
      <p className="p-4 text-sm text-muted-foreground" role="status">
        Panel unavailable.
      </p>
    );
  }
  const Component = entry.component;
  return (
    <Suspense
      fallback={
        <p className="p-4 text-sm text-muted-foreground" role="status">
          Loading panel…
        </p>
      }
    >
      <Component
        key={`${props.threadRef.environmentId}:${props.threadRef.threadId}:${props.surfaceType}`}
        threadRef={props.threadRef}
        visible={props.visible}
      />
    </Suspense>
  );
}
