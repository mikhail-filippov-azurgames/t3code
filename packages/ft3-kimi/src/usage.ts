import type { AcpRegistrySettings } from "@t3tools/provider-acp-registry/settings";
import {
  tokenCount,
  totalTokens,
  type ProviderUsageReader,
  type ProviderUsageScan,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { isKimiAcpSettings } from "./settings.ts";

const WIRE_FILE_NAME = "wire.jsonl";
const SESSION_PREFIX = "session_";
const READ_CONCURRENCY = 4;

export type KimiUsageReaderEnv = FileSystem.FileSystem | Path.Path;

function resolveKimiHome(
  environment: NodeJS.ProcessEnv,
  paths: Path.Path,
  homeDirectory: string,
): string {
  const override = environment["KIMI_CODE_HOME"];
  return override !== undefined && override.length > 0
    ? override
    : paths.join(homeDirectory, ".kimi-code");
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function sessionIdOf(relativePath: string, paths: Path.Path): string {
  const segment = relativePath.split(paths.sep).find((part) => part.startsWith(SESSION_PREFIX));
  return segment === undefined ? relativePath : segment.slice(SESSION_PREFIX.length);
}

/** The CLI writes one usage.record per turn; older lines stay byte-stable across appends. */
export function parseKimiWireLine(
  line: string,
  sessionId: string,
  lineIndex: number,
): UsageRecord | null {
  if (!line.includes("usage.record")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  const value = object(parsed);
  if (value === null || value["type"] !== "usage.record") return null;
  const timestampMs = value["time"];
  if (typeof timestampMs !== "number" || !Number.isFinite(timestampMs) || timestampMs <= 0) {
    return null;
  }
  const model = value["model"];
  if (typeof model !== "string" || model.trim().length === 0) return null;
  const usage = object(value["usage"]);
  if (usage === null) return null;
  const totals = {
    uncachedInputTokens: tokenCount(usage["inputOther"]),
    cachedInputTokens: tokenCount(usage["inputCacheRead"]),
    cacheCreationTokens: tokenCount(usage["inputCacheCreation"]),
    outputTokens: tokenCount(usage["output"]),
    reasoningTokens: 0,
  };
  if (totalTokens(totals) === 0) return null;
  return {
    provider: "kimi",
    timestampMs,
    model: model.trim(),
    sessionId,
    totals,
    reportedCostUsd: null,
    speed: "standard",
    dedupeKey: `kimi:${sessionId}:${lineIndex}`,
  };
}

interface WireFile {
  readonly path: string;
  readonly records: readonly UsageRecord[];
}

export const kimiUsageReader: Extract<
  ProviderUsageReader<AcpRegistrySettings, KimiUsageReaderEnv>,
  { readonly kind: "scan" }
> = {
  kind: "scan",
  provider: "kimi",
  scan: Effect.fn("kimiUsageReader.scan")(function* ({ instances, windowStartMs }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const homeDirectory = yield* HostProcess.HomeDirectory;
    const hostEnvironment = yield* HostProcess.Environment;

    const roots = new Set<string>();
    for (const instance of instances) {
      if (instance.config === undefined || !isKimiAcpSettings(instance.config)) continue;
      roots.add(
        paths.join(
          resolveKimiHome({ ...hostEnvironment, ...instance.environment }, paths, homeDirectory),
          "sessions",
        ),
      );
    }

    return yield* Effect.forEach([...roots], (root) =>
      Effect.gen(function* () {
        const exists = yield* fileSystem.exists(root).pipe(Effect.orElseSucceed(() => false));
        if (!exists) {
          return {
            dir: root,
            files: null,
            status: "missing",
            message: "No Kimi session directory on this environment.",
          } satisfies ProviderUsageScan;
        }
        const wireFiles: string[] = [];
        const walk: (
          directory: string,
        ) => Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> = Effect.fnUntraced(
          function* (directory: string) {
            const names = yield* fileSystem
              .readDirectory(directory)
              .pipe(Effect.orElseSucceed(() => [] as string[]));
            for (const name of names) {
              const child = paths.join(directory, name);
              const info = yield* fileSystem.stat(child).pipe(Effect.option);
              if (info._tag === "None") continue;
              if (info.value.type === "Directory") {
                yield* walk(child);
              } else if (info.value.type === "File" && name === WIRE_FILE_NAME) {
                const mtime = info.value.mtime;
                if (mtime._tag === "Some" && mtime.value.getTime() < windowStartMs) continue;
                wireFiles.push(child);
              }
            }
          },
        );
        yield* walk(root);

        let failed = 0;
        const files: Array<WireFile | null> = yield* Effect.forEach(
          wireFiles,
          (filePath) =>
            Effect.gen(function* () {
              const text = yield* fileSystem
                .readFileString(filePath)
                .pipe(Effect.orElseSucceed(() => null));
              if (text === null) {
                failed += 1;
                return null;
              }
              const sessionId = sessionIdOf(paths.relative(root, filePath), paths);
              const records: UsageRecord[] = [];
              for (const [index, line] of text.split("\n").entries()) {
                const record = parseKimiWireLine(line, sessionId, index);
                if (record !== null && record.timestampMs >= windowStartMs) records.push(record);
              }
              return { path: filePath, records };
            }),
          { concurrency: READ_CONCURRENCY },
        );
        const read = files.filter((file): file is WireFile => file !== null);
        return {
          dir: root,
          files: read,
          ...(failed > 0
            ? {
                status: "partial",
                message: "Some Kimi session files could not be read.",
              }
            : {}),
        } satisfies ProviderUsageScan;
      }),
    );
  }),
};
