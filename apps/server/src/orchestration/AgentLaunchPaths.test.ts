import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const PROVIDER_SERVICE = "provider/Layers/ProviderService.ts";

interface LaunchSite {
  readonly count: number;
  readonly launchesAgent: boolean;
  readonly why: string;
}

// Key: "<file relative to apps/server/src>::<call>". Update when code that starts an agent moves.
const EXPECTED_LAUNCH_SITES: Readonly<Record<string, LaunchSite>> = {
  "serverRuntimeStartup.ts::sendTurn": {
    count: 1,
    launchesAgent: true,
    why: "server-update continuation: sends a turn straight to the provider, bypassing thread.turn.start",
  },
  "orchestration/Layers/ProviderCommandReactor.ts::startSession": {
    count: 1,
    launchesAgent: true,
    why: "startProviderSession, reached from ensureSessionForThread (turn start, compaction, runtime-mode change)",
  },
  "orchestration/Layers/ProviderCommandReactor.ts::sendTurn": {
    count: 1,
    launchesAgent: true,
    why: "processTurnStartRequested: the only reactor path that sends a turn",
  },
  "orchestration/Layers/ProviderCommandReactor.ts::compactThread": {
    count: 1,
    launchesAgent: true,
    why: "compaction branch of processTurnStartRequested; may recover a session or fall back to sendTurn",
  },
  "provider/Layers/ProviderService.ts::startSession": {
    count: 2,
    launchesAgent: true,
    why: "recoverSessionForThread (resume without a turn) and ProviderService.startSession",
  },
  "provider/Layers/ProviderService.ts::sendTurn": {
    count: 2,
    launchesAgent: true,
    why: "ProviderService.sendTurn adapter call and the compactThread fallback that sends a turn without runOrigin",
  },
  "provider/Layers/ProviderService.ts::compaction.start": {
    count: 1,
    launchesAgent: true,
    why: "native compaction runs inside the live agent session",
  },
  "provider/Layers/CodexAdapter.ts::sendTurn": {
    count: 1,
    launchesAgent: true,
    why: "adapter implementation: starts the turn in the codex runtime",
  },
  "provider/Layers/ClaudeAdapter.ts::startSession": {
    count: 2,
    launchesAgent: true,
    why: "adapter-internal restart after rollbackThread, inside an already requested rollback",
  },
  "provider/Layers/MuseCodeAdapter.ts::startSession": {
    count: 2,
    launchesAgent: true,
    why: "SDK session open and autonomous respawn of a stalled dedicated host",
  },
  "provider/pi/piAdapter.ts::startSession": {
    count: 1,
    launchesAgent: true,
    why: "adapter-internal restart of an evicted process inside sendTurn",
  },
  "terminal/Manager.ts::startSession": {
    count: 3,
    launchesAgent: false,
    why: "terminal PTY session, not an agent",
  },
  "textGeneration/TextGeneration.ts::generateCommitMessage": {
    count: 1,
    launchesAgent: true,
    why: "text generation router: runs the provider CLI for a one-shot generation, not a thread turn",
  },
  "textGeneration/TextGeneration.ts::generatePrContent": {
    count: 1,
    launchesAgent: true,
    why: "text generation router, see generateCommitMessage",
  },
  "textGeneration/TextGeneration.ts::generateBranchName": {
    count: 1,
    launchesAgent: true,
    why: "text generation router, see generateCommitMessage",
  },
  "textGeneration/TextGeneration.ts::generateThreadTitle": {
    count: 1,
    launchesAgent: true,
    why: "text generation router, see generateCommitMessage",
  },
  "git/GitManager.ts::generateCommitMessage": {
    count: 1,
    launchesAgent: true,
    why: "commit message generation for a git action",
  },
  "git/GitManager.ts::generatePrContent": {
    count: 1,
    launchesAgent: true,
    why: "pull request text generation for a git action",
  },
  "orchestration/DelegatedTaskSummaryReactor.ts::generateCommitMessage": {
    count: 1,
    launchesAgent: true,
    why: "delegated task summary generation after a task completes",
  },
  "orchestration/Layers/ProviderCommandReactor.ts::generateBranchName": {
    count: 1,
    launchesAgent: true,
    why: "worktree branch name generated on the first turn",
  },
  "orchestration/Layers/ProviderCommandReactor.ts::generateThreadTitle": {
    count: 2,
    launchesAgent: true,
    why: "thread title generated on the first turn and on explicit regeneration",
  },
};

// ProviderService methods whose resolveRoutableSession call may respawn a session.
const EXPECTED_RECOVERING_OPERATIONS = [
  "compactThread",
  "interruptTurn",
  "respondToRequest",
  "respondToUserInput",
  "rollbackConversation",
  "sendTurn",
  "uploadFeedback",
];

// Tags declared in AgentRunOrigin that no server code produces today.
const EXPECTED_UNPRODUCED_ORIGIN_TAGS = [
  "compaction-fallback",
  "compaction-replay",
  "server-restart-continuation",
  "session-restoration",
];

const CALL_PATTERN =
  /(?:\.\s*|(?<![\w$.]))(startSession|sendTurn|compactThread|generateCommitMessage|generatePrContent|generateBranchName|generateThreadTitle)\s*\(|\b(compaction)\.start\s*\(/g;

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

const locate = Effect.gen(function* () {
  const path = yield* Path.Path;
  const serverSourceRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
  const contractsFile = yield* path.fromFileUrl(
    new URL("../../../../packages/contracts/src/orchestration.ts", import.meta.url),
  );
  return { serverSourceRoot, contractsFile };
});

const readServerSources = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { serverSourceRoot } = yield* locate;
  const entries = yield* fs.readDirectory(serverSourceRoot, { recursive: true });
  const sources: Array<{ readonly path: string; readonly text: string }> = [];
  for (const entry of entries) {
    const relative = entry.replaceAll("\\", "/");
    if (
      !relative.endsWith(".ts") ||
      relative.endsWith(".d.ts") ||
      /\.(test|spec)\.ts$/.test(relative) ||
      relative.includes("/testUtils/") ||
      relative.includes("node_modules/")
    ) {
      continue;
    }
    const text = yield* fs.readFileString(path.join(serverSourceRoot, relative));
    sources.push({ path: relative, text: stripComments(text) });
  }
  return sources;
});

function collectLaunchSites(
  sources: ReadonlyArray<{ readonly path: string; readonly text: string }>,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const { path, text } of sources) {
    for (const match of text.matchAll(CALL_PATTERN)) {
      const call = match[2] === undefined ? match[1] : "compaction.start";
      const key = `${path}::${call}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

it.layer(NodeServices.layer)("server agent launch paths", (it) => {
  it.effect(
    "lists every place in the server that starts an agent process, turn, or generation",
    () =>
      Effect.gen(function* () {
        const expected = Object.fromEntries(
          Object.entries(EXPECTED_LAUNCH_SITES)
            .map(([key, site]) => [key, site.count] as const)
            .sort(([a], [b]) => a.localeCompare(b)),
        );
        assert.deepEqual(collectLaunchSites(yield* readServerSources), expected);
      }),
  );

  it.effect("pins which ProviderService operations can respawn a session without a new turn", () =>
    Effect.gen(function* () {
      const sources = yield* readServerSources;
      const source = sources.find(({ path }) => path === PROVIDER_SERVICE)?.text;
      assert.isDefined(source);
      const operations: Array<string> = [];
      for (const match of source!.matchAll(/allowRecovery:\s*true/g)) {
        const names = [...source!.slice(0, match.index).matchAll(/"ProviderService\.(\w+)"/g)];
        operations.push(names.at(-1)?.[1] ?? "<unknown>");
      }
      assert.deepEqual([...new Set(operations)].sort(), EXPECTED_RECOVERING_OPERATIONS);
    }),
  );

  it.effect("pins which AgentRunOrigin tags have no producer in the server", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { contractsFile } = yield* locate;
      const contracts = yield* fs.readFileString(contractsFile);
      const declaration = /export const AgentRunOrigin = Schema\.Union\(\[([\s\S]*?)\]\)/.exec(
        contracts,
      );
      assert.isNotNull(declaration);
      const tags = [...declaration![1]!.matchAll(/TaggedStruct\("([^"]+)"/g)].map(
        (match) => match[1]!,
      );
      assert.isAbove(tags.length, 0);

      const sources = yield* readServerSources;
      const unproduced = tags.filter((tag) => {
        const marker = tag === "unknown" ? "UnknownAgentRunOrigin" : `"${tag}"`;
        return !sources.some(({ text }) => text.includes(marker));
      });
      assert.deepEqual(unproduced.sort(), EXPECTED_UNPRODUCED_ORIGIN_TAGS);
    }),
  );
});
