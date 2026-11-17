import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { parse } from "smol-toml";

import {
  decodeClaude,
  decodeCodex,
  decodeProvider,
  endpointOrigin,
  expandHome,
  helperIsPath,
  isZavodKeyHelper,
} from "./detect.ts";

export type ModelFamily = "claude" | "codex";

export interface ZavodGatewayConfig {
  readonly origin: string;
  readonly helperCommand: string;
}

export interface GatewayModelsList {
  readonly kind: "list";
  readonly ids: ReadonlyArray<string>;
}

export type GatewayModelsResult =
  | GatewayModelsList
  | { readonly kind: "unavailable"; readonly reason: string };

export interface GatewayCatalogModel {
  readonly slug: string;
  readonly isCustom: boolean;
}

export const HELPER_TIMEOUT = "10 seconds";
export const REQUEST_TIMEOUT = "15 seconds";

const decodeModelsResponse = Schema.decodeUnknownEffect(
  Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String })) }),
);

const readOptional = Effect.fn("Zavod.readGatewayFile")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(file).pipe(
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.undefined,
    ),
  );
});

/** Gateway origin and key helper of a Claude or Codex home, or null when the home is not on a gateway. */
export const readZavodGatewayConfig = Effect.fn("Zavod.readGatewayConfig")(function* (input: {
  readonly family: ModelFamily;
  readonly homePath: string;
  readonly homeDirectory?: string;
}): Effect.fn.Return<ZavodGatewayConfig | null, never, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  const home = input.homeDirectory ?? (yield* HostProcess.HomeDirectory);
  return yield* Effect.gen(function* () {
    if (input.family === "claude") {
      const text = yield* readOptional(path.join(input.homePath, "settings.json"));
      if (text === undefined) return null;
      const settings = yield* decodeClaude(text);
      const url = settings.env?.ANTHROPIC_BASE_URL?.trim();
      const helper = settings.apiKeyHelper;
      if (!url || helper === undefined || !helperIsPath(helper, home, path)) return null;
      const origin = endpointOrigin(url);
      if (origin === undefined) return null;
      const command = expandHome(helper.trim().replace(/^(["'])(.*)\1$/, "$2"), home, path);
      return isZavodKeyHelper(command) ? { origin, helperCommand: command } : null;
    }
    const text = yield* readOptional(path.join(input.homePath, "config.toml"));
    if (text === undefined) return null;
    const toml = yield* Effect.try({ try: () => parse(text), catch: () => "invalid toml" });
    const codex = yield* decodeCodex(toml);
    const active = codex.model_provider;
    const raw = active === undefined ? undefined : codex.model_providers?.[active];
    if (raw === undefined) return null;
    const provider = yield* decodeProvider(raw);
    const command = provider.auth?.command;
    if (command === undefined || !helperIsPath(command, home, path, false)) return null;
    const origin = endpointOrigin(provider.base_url);
    if (origin === undefined) return null;
    const helperCommand = expandHome(command.trim(), home, path);
    return isZavodKeyHelper(helperCommand) ? { origin, helperCommand } : null;
  }).pipe(Effect.orElseSucceed(() => null));
});

const runHelper = (command: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const handle = yield* spawner.spawn(
        ChildProcess.make(command, [], { stdin: "ignore", stderr: "ignore" }),
      );
      const [stdout, exitCode] = yield* Effect.all(
        [Stream.mkString(Stream.decodeText(handle.stdout)), handle.exitCode],
        { concurrency: 2 },
      );
      return exitCode === 0 ? stdout.trim() : "";
    }),
  );

/**
 * Lists the models the gateway serves to the current key. Every failure becomes
 * `unavailable` with a fixed reason, so the key never reaches a message.
 */
export const fetchGatewayModels = Effect.fn("Zavod.fetchGatewayModels")(function* (
  config: ZavodGatewayConfig,
): Effect.fn.Return<
  GatewayModelsResult,
  never,
  HttpClient.HttpClient | ChildProcessSpawner.ChildProcessSpawner
> {
  const unavailable = (reason: string): GatewayModelsResult => ({ kind: "unavailable", reason });
  const key = yield* runHelper(config.helperCommand).pipe(
    Effect.timeoutOption(HELPER_TIMEOUT),
    Effect.orElseSucceed(() => undefined),
    Effect.catchDefect(() => Effect.undefined),
  );
  if (key === undefined || key._tag === "None") return unavailable("helper timed out or failed");
  if (key.value === "") return unavailable("helper returned no key");

  const http = yield* HttpClient.HttpClient;
  const request = HttpClientRequest.get(`${config.origin}/v1/models`).pipe(
    HttpClientRequest.acceptJson,
    HttpClientRequest.setHeader("authorization", `Bearer ${key.value}`),
  );
  return yield* http.execute(request).pipe(
    Effect.flatMap((response) =>
      response.status !== 200
        ? Effect.succeed(unavailable(`status ${response.status}`))
        : response.json.pipe(
            Effect.flatMap(decodeModelsResponse),
            Effect.map((body): GatewayModelsResult => {
              const ids = body.data.map((model) => model.id.trim()).filter(Boolean);
              return ids.length === 0 ? unavailable("empty model list") : { kind: "list", ids };
            }),
            Effect.orElseSucceed(() => unavailable("invalid response")),
          ),
    ),
    Effect.timeoutOption(REQUEST_TIMEOUT),
    Effect.map((outcome) =>
      outcome._tag === "Some" ? outcome.value : unavailable("request timed out"),
    ),
    Effect.orElseSucceed(() => unavailable("request failed")),
    Effect.catchDefect(() => Effect.succeed(unavailable("request failed"))),
  );
});

const FAMILY_PREFIXES: Record<ModelFamily, ReadonlyArray<string>> = {
  claude: ["claude"],
  codex: ["gpt", "codex"],
};

/** Keeps custom models and the models of the instance's own family. */
export function filterModelFamily<M extends GatewayCatalogModel>(
  models: ReadonlyArray<M>,
  family: ModelFamily,
): ReadonlyArray<M> {
  const prefixes = FAMILY_PREFIXES[family];
  return models.filter(
    (model) =>
      model.isCustom || prefixes.some((prefix) => model.slug.toLowerCase().startsWith(prefix)),
  );
}

/** True when the list keeps at least one non-custom model of the catalog. */
export function listMatchesCatalog(
  models: ReadonlyArray<GatewayCatalogModel>,
  list: GatewayModelsList,
): boolean {
  const ids = new Set(list.ids);
  return models.some((model) => !model.isCustom && ids.has(model.slug));
}

/**
 * Keeps custom models and the models the gateway lists. A list that would leave
 * no catalog model counts as unavailable, so an id format change cannot empty the picker.
 */
export function applyGatewayModels<M extends GatewayCatalogModel>(
  models: ReadonlyArray<M>,
  result: GatewayModelsResult,
  lastGood: GatewayModelsList | undefined,
): ReadonlyArray<M> {
  for (const list of [result.kind === "list" ? result : undefined, lastGood]) {
    if (list === undefined || !listMatchesCatalog(models, list)) continue;
    const ids = new Set(list.ids);
    return models.filter((model) => model.isCustom || ids.has(model.slug));
  }
  return models;
}
