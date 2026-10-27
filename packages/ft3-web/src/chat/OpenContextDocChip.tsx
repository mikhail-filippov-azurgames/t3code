import { FileTextIcon, TriangleAlertIcon } from "lucide-react";
import React, { useCallback, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

import type { ContextMenuItem } from "@t3tools/contracts";
import { ContextChip, ContextChipLabel } from "~/components/ContextChip";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { readLocalApi } from "~/localApi";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import {
  openContextDocMenuItems,
  type OpenContextDocLinkStatus,
  type OpenContextDocMenuAction,
  type OpenContextDocResolutionFound,
  type OpenContextDocResolveResult,
} from "./openContextDocLink.ts";

function reportOpenContextDocFailure(operation: string, target: string, cause: unknown): void {
  console.error("[opencontext-doc-link] action failed", { operation, target }, cause);
}

type Resolution =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "found"; readonly doc: OpenContextDocResolutionFound }
  | { readonly kind: "not_found" }
  | { readonly kind: "unavailable" };

interface OpenContextDocLinkProps {
  /** Canonical `oc://doc/<stable_id>`. */
  readonly href: string;
  readonly stableId: string;
  /** Cloud links have no local store document to resolve. */
  readonly resolvable: boolean;
  readonly label: string;
  readonly className?: string | undefined;
  readonly canOpenDocument: boolean;
  readonly resolveDoc: (stableId: string) => Promise<OpenContextDocResolveResult | null>;
  readonly onOpenDocument: (absolutePath: string) => void;
}

function classifyResolution(result: OpenContextDocResolveResult | null): Resolution {
  if (result === null) return { kind: "unavailable" };
  if (result.status === "found") return { kind: "found", doc: result };
  return result.status === "not_found" ? { kind: "not_found" } : { kind: "unavailable" };
}

function menuStatusFor(resolution: Resolution): OpenContextDocLinkStatus {
  switch (resolution.kind) {
    case "found":
      return "found";
    case "not_found":
      return "not_found";
    case "unavailable":
      return "unavailable";
    default:
      return "idle";
  }
}

/**
 * A document link is a chip, not a plain anchor: the `oc:` scheme has no OS
 * handler, so a click resolves the stable id on the server and opens the
 * resolved host file read-only in the files panel. Resolution failures are
 * state on the chip plus a toast, never a dead click or a thrown error.
 */
export const OpenContextDocChip = React.memo(function OpenContextDocChip(
  props: OpenContextDocLinkProps,
) {
  const {
    href,
    stableId,
    resolvable,
    label,
    className,
    canOpenDocument,
    resolveDoc,
    onOpenDocument,
  } = props;
  const [resolution, setResolution] = useState<Resolution>({ kind: "idle" });
  const inFlightRef = useRef<Promise<Resolution> | null>(null);
  const resolutionRef = useRef<Resolution>(resolution);

  const setResolutionBoth = useCallback((next: Resolution) => {
    resolutionRef.current = next;
    setResolution(next);
  }, []);

  const ensureResolved = useCallback((): Promise<Resolution> => {
    if (!resolvable) {
      return Promise.resolve({ kind: "unavailable" } satisfies Resolution);
    }
    if (resolutionRef.current.kind === "found") {
      return Promise.resolve(resolutionRef.current);
    }
    if (inFlightRef.current !== null) return inFlightRef.current;
    setResolutionBoth({ kind: "loading" });
    const promise = resolveDoc(stableId)
      .then(classifyResolution, () => ({ kind: "unavailable" }) as Resolution)
      .then((outcome) => {
        inFlightRef.current = null;
        setResolutionBoth(outcome);
        return outcome;
      });
    inFlightRef.current = promise;
    return promise;
  }, [resolvable, resolveDoc, setResolutionBoth, stableId]);

  const reportResolutionFailure = useCallback(
    (outcome: Resolution) => {
      if (outcome.kind === "not_found") {
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "OpenContext document not found",
            description: `No document matches ${stableId}.`,
          }),
        );
      } else if (outcome.kind === "unavailable") {
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "OpenContext document unavailable",
            description: resolvable
              ? "The OpenContext store is not reachable from this environment."
              : "Cloud document links have no local document to open.",
          }),
        );
      }
    },
    [resolvable, stableId],
  );

  const openResolved = useCallback(async (): Promise<boolean> => {
    const outcome = await ensureResolved();
    if (outcome.kind !== "found") {
      reportResolutionFailure(outcome);
      return false;
    }
    if (!canOpenDocument) {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: "OpenContext document resolved",
          description: "Open it from a thread to view it in the files panel.",
        }),
      );
      return false;
    }
    onOpenDocument(outcome.doc.absolutePath);
    return true;
  }, [canOpenDocument, ensureResolved, onOpenDocument, reportResolutionFailure]);

  const copyValue = useCallback(
    (value: string, title: string) => {
      void writeTextToClipboard(value, title).then(
        () => toastManager.add({ type: "success", title: `${title} copied`, description: value }),
        (error: unknown) => {
          reportOpenContextDocFailure("copy-open-context-doc", stableId, error);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: `Failed to copy ${title.toLowerCase()}`,
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        },
      );
    },
    [stableId],
  );

  const handleActivate = useCallback(
    (event: ReactMouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      event.stopPropagation();
      if (!resolvable) {
        copyValue(href, "Link");
        return;
      }
      void openResolved();
    },
    [copyValue, href, openResolved, resolvable],
  );

  const handleContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const api = readLocalApi();
      if (!api) return;
      const position =
        event.clientX === 0 && event.clientY === 0
          ? (() => {
              const bounds = event.currentTarget.getBoundingClientRect();
              return { x: bounds.left, y: bounds.bottom };
            })()
          : { x: event.clientX, y: event.clientY };

      void (async () => {
        const outcome = await ensureResolved();
        const selected = (await api.contextMenu.show(
          openContextDocMenuItems({
            status: menuStatusFor(outcome),
            canOpenDocument,
            ...(outcome.kind === "found" ? { displayPath: outcome.doc.relativePath } : {}),
          }),
          position,
        )) as ContextMenuItem<OpenContextDocMenuAction>["id"] | null;
        const action = selected;
        if (action === "open-document") {
          await openResolved();
        } else if (action === "copy-link") {
          copyValue(href, "Link");
        } else if (action === "copy-document-path" && outcome.kind === "found") {
          copyValue(outcome.doc.absolutePath, "Document path");
        }
      })().catch((cause: unknown) => {
        reportOpenContextDocFailure("show-open-context-doc-menu", stableId, cause);
      });
    },
    [canOpenDocument, copyValue, ensureResolved, href, openResolved, stableId],
  );

  const isWarning = resolution.kind === "not_found" || resolution.kind === "unavailable";
  const resolvedPath = resolution.kind === "found" ? resolution.doc.absolutePath : href;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ContextChip
            kind="file"
            dir="ltr"
            {...(isWarning ? { state: "invalid" as const } : {})}
            render={<a href={href} />}
            className={className}
            data-opencontext-doc-status={resolution.kind}
            onClick={handleActivate}
            onContextMenu={handleContextMenu}
          >
            {isWarning ? <TriangleAlertIcon aria-hidden /> : <FileTextIcon aria-hidden />}
            <ContextChipLabel>{label}</ContextChipLabel>
          </ContextChip>
        }
      />
      <TooltipPopup
        side="top"
        className="max-w-[min(40rem,calc(100vw-2rem))] font-mono text-[11px] leading-tight"
      >
        <div className="overflow-x-auto whitespace-nowrap">{resolvedPath}</div>
      </TooltipPopup>
    </Tooltip>
  );
});
