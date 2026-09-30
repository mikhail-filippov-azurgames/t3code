import type { PiSettings, ProviderInstanceId } from "@t3tools/contracts";
import { TextGenerationError } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { spawnAndCollect } from "../provider/providerSnapshot.ts";
import {
  ensurePiAgentFiles,
  normalizePiModelSlug,
  piModelIdFromSlug,
} from "../provider/pi/piAgentDir.ts";
import {
  hasPiManagedInferenceConfig,
  piInferenceSettingsForModel,
  piInferenceServerManager,
} from "../provider/pi/piInferenceServer.ts";
import {
  buildPiLaunchEnvironment,
  resolvePiLaunchProfile,
} from "../provider/pi/piPermissionBridge.ts";
import { PI_RUNTIME_PIN, resolvePiRuntime } from "../provider/pi/piRuntime.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import * as TextGeneration from "./TextGeneration.ts";
import {
  normalizeCliError,
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

const PI_TEXT_TIMEOUT_MS = 180_000;

function resolvePiModelArg(model: string | undefined, fallback: string): ReadonlyArray<string> {
  const selected = normalizePiModelSlug(model?.trim() || fallback);
  return selected ? ["--model", selected] : [];
}

export interface PiTextGenerationOptions {
  readonly instanceId: ProviderInstanceId;
  readonly settings: PiSettings;
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly inferenceServerManager?: Pick<
    typeof piInferenceServerManager,
    "acquireRequestSlot" | "getStatus" | "waitForExistingReady"
  >;
}

function resolvePiTextGenerationSettings(
  settings: PiSettings,
  model: string | undefined,
): PiSettings {
  const selectedModel = model?.trim() || settings.model.trim();
  if (!selectedModel) return settings;

  const selectedId = piModelIdFromSlug(selectedModel) ?? selectedModel;
  const configuredId = piModelIdFromSlug(settings.model) ?? settings.model.trim();
  const isBonsai27B = selectedId.toLowerCase() === "bonsai-2-27b";
  const isDifferentManagedModel =
    hasPiManagedInferenceConfig(settings) && selectedId !== configuredId;

  const resolved = piInferenceSettingsForModel(settings, selectedModel, {
    requireProfile: isBonsai27B || isDifferentManagedModel,
  });
  const resolvedId = piModelIdFromSlug(resolved.model) ?? resolved.model.trim();
  if (resolvedId !== selectedId) {
    throw new Error(`The selected Pi model profile does not match ${selectedId}.`);
  }
  return resolved;
}

export const makePiTextGeneration = Effect.fn("makePiTextGeneration")(function* (
  options: PiTextGenerationOptions,
) {
  const environment = options.environment ?? process.env;
  const inferenceServerManager = options.inferenceServerManager ?? piInferenceServerManager;
  // Capture services at construction: generation methods run later in a
  // service-free context, mirroring the provider adapter pattern.
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const provideRuntimeServices = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, pathService),
    );
  const runPiPrintUnlocked = (
    operation: string,
    cwd: string,
    prompt: string,
    settings: PiSettings,
    launchEnvironment: NodeJS.ProcessEnv,
  ): Effect.Effect<string, TextGenerationError> =>
    Effect.scoped(
      Effect.gen(function* () {
        // Each one-shot gets a disposable Pi state directory. Chat sessions
        // keep their per-instance agent dir and catalog untouched, even when
        // title/summary generation runs concurrently for another model.
        const agentDir = yield* provideRuntimeServices(
          fileSystem.makeTempDirectoryScoped({ prefix: "t3-pi-text-" }),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation,
                detail: `Failed to prepare isolated Pi state: ${cause instanceof Error ? cause.message : String(cause)}`,
              }),
          ),
        );
        const isolatedEnvironment = buildPiLaunchEnvironment(
          resolvePiLaunchProfile("approval-required"),
          launchEnvironment,
          agentDir,
        );
        if (!isolatedEnvironment.ok) {
          return yield* new TextGenerationError({
            operation,
            detail: `Pi launch environment could not be verified: ${isolatedEnvironment.reason}`,
          });
        }
        const piEnvironment = isolatedEnvironment.environment;
        const modelId = piModelIdFromSlug(settings.model) ?? settings.model;
        yield* provideRuntimeServices(
          ensurePiAgentFiles(agentDir, {
            baseUrl: settings.baseUrl,
            apiKey: settings.apiKey,
            models: [modelId],
            runtimeMode: "approval-required",
            defaultModel: modelId,
          }),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation,
                detail: `Failed to prepare Pi agent dir: ${cause instanceof Error ? cause.message : String(cause)}`,
              }),
          ),
        );
        const runtime = yield* provideRuntimeServices(
          resolvePiRuntime({
            binaryPath: settings.binaryPath,
            env: piEnvironment,
          }),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation,
                detail: `Pinned Pi runtime is unavailable (pin ${PI_RUNTIME_PIN}): ${cause instanceof Error ? cause.message : String(cause)}`,
              }),
          ),
        );
        const collected = yield* provideRuntimeServices(
          spawnAndCollect(
            runtime.command,
            ChildProcess.make(
              runtime.command,
              [
                ...runtime.prefixArgs,
                "--print",
                "--no-session",
                "--no-tools",
                "--no-extensions",
                "--no-skills",
                "--no-context-files",
                "--mode",
                "text",
                ...resolvePiModelArg(settings.model, settings.model),
                prompt,
              ],
              {
                cwd,
                env: piEnvironment,
                extendEnv: false,
              },
            ),
          ),
        ).pipe(
          Effect.timeoutOption(PI_TEXT_TIMEOUT_MS),
          Effect.flatMap((option) =>
            option._tag === "None"
              ? Effect.fail(
                  new TextGenerationError({ operation, detail: "Pi text generation timed out." }),
                )
              : Effect.succeed(option.value),
          ),
          Effect.mapError((cause) =>
            normalizeCliError("pi", operation, cause, "Pi text generation failed."),
          ),
        );
        if (collected.code !== 0) {
          return yield* new TextGenerationError({
            operation,
            detail: `Pi exited with code ${collected.code}: ${collected.stderr.slice(-500) || collected.stdout.slice(-500) || "no output"}`,
          });
        }
        const text = collected.stdout.trim();
        if (text.length === 0) {
          return yield* new TextGenerationError({ operation, detail: "Pi returned empty output." });
        }
        return text;
      }),
    );

  const runPiPrint = (
    operation: string,
    cwd: string,
    prompt: string,
    model: string | undefined,
  ): Effect.Effect<string, TextGenerationError> =>
    Effect.gen(function* () {
      const settings = yield* Effect.try({
        try: () => resolvePiTextGenerationSettings(options.settings, model),
        catch: (cause) =>
          new TextGenerationError({
            operation,
            detail:
              cause instanceof Error
                ? cause.message
                : "The selected Pi model profile is unavailable.",
            cause,
          }),
      });
      const launchEnvironmentResult = buildPiLaunchEnvironment(
        resolvePiLaunchProfile("approval-required"),
        environment,
      );
      if (!launchEnvironmentResult.ok) {
        return yield* new TextGenerationError({
          operation,
          detail: `Pi launch environment could not be verified: ${launchEnvironmentResult.reason}`,
        });
      }
      const launchEnvironment = launchEnvironmentResult.environment;
      let release: (() => void) | undefined;
      if (hasPiManagedInferenceConfig(settings)) {
        yield* Effect.tryPromise({
          try: async () => {
            let status = await inferenceServerManager.getStatus(options.instanceId, settings);
            if (!status.ready) {
              status =
                (await inferenceServerManager.waitForExistingReady(options.instanceId, settings)) ??
                status;
            }
            const expectedModelId = piModelIdFromSlug(settings.model);
            if (
              expectedModelId &&
              !status.modelIds.includes(expectedModelId) &&
              (status.ready || status.modelIds.length > 0)
            ) {
              throw new Error(
                `The inference endpoint does not serve the selected Pi model (${expectedModelId}); the text-generation request was not sent.`,
              );
            }
            if (!status.ready) {
              throw new Error(
                status.error ??
                  `The selected Pi inference endpoint is not ready for ${expectedModelId ?? "the selected model"}.`,
              );
            }
          },
          catch: (cause) =>
            new TextGenerationError({
              operation,
              detail:
                cause instanceof Error ? cause.message : "The Pi inference endpoint is not ready.",
              cause,
            }),
        });
        release = yield* Effect.tryPromise({
          try: (signal) =>
            inferenceServerManager.acquireRequestSlot(settings.baseUrl, undefined, signal),
          catch: (cause) =>
            new TextGenerationError({
              operation,
              detail: cause instanceof Error ? cause.message : "Inference request was interrupted.",
            }),
        });
      }
      return yield* runPiPrintUnlocked(operation, cwd, prompt, settings, launchEnvironment).pipe(
        Effect.ensuring(Effect.sync(() => release?.())),
      );
    });

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("PiTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });
      const text = yield* runPiPrint(
        "generateCommitMessage",
        input.cwd,
        prompt,
        input.modelSelection.model,
      );
      const [first, ...rest] = text.split(/\r?\n/);
      return {
        subject: sanitizeCommitSubject(first ?? ""),
        body: rest.join("\n").trim(),
        ...(input.includeBranch === true ? { branch: sanitizeFeatureBranchName(text) } : {}),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("PiTextGeneration.generatePrContent")(function* (input) {
      const { prompt } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      });
      const text = yield* runPiPrint(
        "generatePrContent",
        input.cwd,
        prompt,
        input.modelSelection.model,
      );
      const [first, ...rest] = text.split(/\r?\n/);
      return { title: sanitizePrTitle(first ?? ""), body: rest.join("\n").trim() || text };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("PiTextGeneration.generateBranchName")(function* (input) {
      const { prompt } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });
      const text = yield* runPiPrint(
        "generateBranchName",
        input.cwd,
        prompt,
        input.modelSelection.model,
      );
      return { branch: sanitizeBranchFragment(text) };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("PiTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt } = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        linkedContext: input.linkedContext,
        attachments: input.attachments,
      });
      const text = yield* runPiPrint(
        "generateThreadTitle",
        input.cwd,
        prompt,
        input.modelSelection.model,
      );
      return { title: sanitizeThreadTitle(text) };
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
});
