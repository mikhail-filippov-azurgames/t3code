import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

const SERVER_SOURCE_ROOT = `${process.cwd()}/src`;
const ORCHESTRATOR_SERVICE = "mcp/toolkits/orchestrator/service.ts";

const EXPECTED_TURN_START_ORIGINS: Readonly<Record<string, readonly string[]>> = {
  "background/CalendarReactor.ts": ["calendar-turn"],
  [ORCHESTRATOR_SERVICE]: [
    "delegation-continuation",
    "delegation-provider-switch-replay",
    "input.runOrigin",
    "input.runOrigin",
  ],
  "orchestration/BoardReactor.ts": ["orphaned-worker-restoration"],
  "orchestration/Layers/ProviderCommandReactor.ts": ["queued-turn-restoration"],
  "orchestration/Layers/ProviderRuntimeIngestion.ts": [
    "delegation-parent-wake",
    "delayed-notification-delivery",
  ],
  "orchestration/decider.ts": ["async-question-answer-turn"],
  "ws.ts": ["board-card-start", "orchestrator-brief", "orchestrator-brief"],
};

const EXPECTED_ORCHESTRATOR_HELPER_CALLS: Readonly<Record<string, number>> = {
  dispatchDelegatedTurnStart: 2,
  dispatchFollowUpTurn: 1,
  dispatchWakeTurn: 2,
  wakeArchitectForReview: 2,
  wakeCoordinatorForPublish: 2,
};

const EXPECTED_ORCHESTRATOR_HELPER_ORIGINS: Readonly<Record<string, readonly string[]>> = {
  dispatchDelegatedTurnStart: ["delegation-retry", "delegation-start"],
  dispatchWakeTurn: ["architect-review-request-wake", "coordinator-publication-wake"],
};

function sortedRecord(entries: Map<string, Array<string>>): Record<string, Array<string>> {
  return Object.fromEntries(
    [...entries]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, values]) => [key, [...values].sort()]),
  );
}

function originLabel(lines: Array<string>, propertyLine: number, propertyIndent: number): string {
  for (let lineIndex = propertyLine + 1; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? "";
    const indentation = /^\s*/.exec(line)?.[0].length ?? 0;
    const content = line.trim();
    if (content.startsWith("}") && indentation < propertyIndent) break;
    if (indentation !== propertyIndent) continue;
    const tagged = /^runOrigin\s*:\s*\{\s*_tag\s*:\s*["']([^"']+)["']\s*\},?$/.exec(content);
    if (tagged !== null) return tagged[1] ?? "<unsupported>";
    if (/^runOrigin\s*:\s*input\.runOrigin\s*,?$/.test(content)) return "input.runOrigin";
  }
  return "<missing>";
}

const collectTurnStartOrigins = Effect.fn("AgentRunOriginProducers.collectTurnStartOrigins")(
  function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* fs.glob("**/*.ts", { root: SERVER_SOURCE_ROOT });
    const origins = new Map<string, Array<string>>();
    const turnStart = /\btype\s*:\s*["']thread\.turn\.start["']/g;
    const normalizedRoot = SERVER_SOURCE_ROOT.replaceAll("\\", "/");
    const normalizedCwd = process.cwd().replaceAll("\\", "/");
    for (const path of paths) {
      const normalizedPath = path.replaceAll("\\", "/").replace(/^\.\//, "");
      const fullPath =
        /^[A-Za-z]:\//.test(normalizedPath) || normalizedPath.startsWith("/")
          ? normalizedPath
          : normalizedPath.startsWith("src/")
            ? `${normalizedCwd}/${normalizedPath}`
            : `${normalizedRoot}/${normalizedPath}`;
      const relativePath = fullPath.startsWith(`${normalizedRoot}/`)
        ? fullPath.slice(normalizedRoot.length + 1)
        : fullPath;
      if (
        relativePath.endsWith(".test.ts") ||
        relativePath.endsWith(".spec.ts") ||
        relativePath.endsWith(".d.ts")
      ) {
        continue;
      }
      const source = yield* fs.readFileString(fullPath);
      const lines = source.split(/\r?\n/);
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const line = lines[lineIndex] ?? "";
        const commandTypeOnly =
          relativePath === "ws.ts" &&
          /^\s*command:\s*Extract<OrchestrationCommand,\s*\{\s*type:\s*["']thread\.turn\.start["']\s*\}\s*>,?\s*$/.test(
            line,
          );
        if (commandTypeOnly) continue;
        for (const match of line.matchAll(turnStart)) {
          const afterType = line.slice(match.index! + match[0].length);
          const inlineOrigin =
            /^\s*,\s*runOrigin\s*:\s*(?:\{\s*_tag\s*:\s*["']([^"']+)["']\s*\}|input\.runOrigin)/.exec(
              afterType,
            );
          const propertyIndent = /^\s*/.exec(line)?.[0].length ?? 0;
          const label =
            inlineOrigin === null
              ? afterType.includes("}")
                ? "<missing>"
                : originLabel(lines, lineIndex, propertyIndent)
              : (inlineOrigin[1] ?? "input.runOrigin");
          const entries = origins.get(relativePath) ?? [];
          entries.push(label);
          origins.set(relativePath, entries);
        }
      }
    }
    return sortedRecord(origins);
  },
);

function collectHelperCallOrigins(source: string, helperName: string): Array<string> {
  const call = new RegExp(`\\b${helperName}\\s*\\(\\s*\\{([\\s\\S]*?)\\n\\s*\\}\\s*\\)`, "g");
  return [...source.matchAll(call)]
    .map((match) => {
      const origin = /\brunOrigin\s*:\s*\{\s*_tag\s*:\s*["']([^"']+)["']\s*\}/.exec(match[1] ?? "");
      return origin?.[1] ?? "<missing>";
    })
    .sort();
}

function countHelperCalls(source: string, helperName: string): number {
  return [...source.matchAll(new RegExp(`\\b${helperName}\\s*\\(`, "g"))].length;
}

const collectOrchestratorHelperOrigins = Effect.fn(
  "AgentRunOriginProducers.collectOrchestratorHelperOrigins",
)(function* () {
  const fs = yield* FileSystem.FileSystem;
  const source = yield* fs.readFileString(`${SERVER_SOURCE_ROOT}/${ORCHESTRATOR_SERVICE}`);
  const actualCounts = new Map<string, Array<string>>();
  const actualOrigins = new Map<string, Array<string>>();
  for (const helperName of Object.keys(EXPECTED_ORCHESTRATOR_HELPER_CALLS)) {
    actualCounts.set(helperName, [String(countHelperCalls(source, helperName))]);
  }
  for (const helperName of Object.keys(EXPECTED_ORCHESTRATOR_HELPER_ORIGINS)) {
    actualOrigins.set(helperName, collectHelperCallOrigins(source, helperName));
  }
  return { actualCounts, actualOrigins };
});

it.layer(NodeServices.layer)("server thread run-origin invariants", (it) => {
  it.effect("lists every server thread.turn.start producer with its expected origin", () =>
    Effect.gen(function* () {
      assert.deepEqual(
        yield* collectTurnStartOrigins(),
        sortedRecord(
          new Map(
            Object.entries(EXPECTED_TURN_START_ORIGINS).map(([path, origins]) => [
              path,
              [...origins],
            ]),
          ),
        ),
      );
    }),
  );

  it.effect("pins delegation, wake, and restart reconciliation routes to their origins", () =>
    Effect.gen(function* () {
      const { actualCounts, actualOrigins } = yield* collectOrchestratorHelperOrigins();
      assert.deepEqual(
        actualCounts,
        new Map(
          Object.entries(EXPECTED_ORCHESTRATOR_HELPER_CALLS).map(([name, count]) => [
            name,
            [String(count)],
          ]),
        ),
      );
      assert.deepEqual(
        sortedRecord(actualOrigins),
        sortedRecord(
          new Map(
            Object.entries(EXPECTED_ORCHESTRATOR_HELPER_ORIGINS).map(([name, labels]) => [
              name,
              [...labels],
            ]),
          ),
        ),
      );
    }),
  );
});
