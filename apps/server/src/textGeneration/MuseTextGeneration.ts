/**
 * MuseTextGeneration — commit/PR/branch/title text via headless `muse exec`.
 *
 * Runs the official CLI, never the separately billed Model API, and never
 * passes `--api-key-stdin`: subscription provenance comes from the `muse
 * login` session the process inherits through its sanitized environment.
 *
 * @module textGeneration/MuseTextGeneration
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  DEFAULT_TEXT_GENERATION_REASONING_EFFORT,
  type ModelSelection,
  TextGenerationError,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import { sanitizeBranchFragment } from "@t3tools/shared/git";
import {
  normalizeCliError,
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

const MUSE_TIMEOUT_MS = 180_000;
const JSON_ONLY_SUFFIX = "\n\nReturn ONLY the JSON object, no fences or prose.";

type TextOperation =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

/** Decode one JSON-object model answer against the prompt's schema. */
export function decodeMuseJsonOutput<S extends Schema.Top>(
  operation: TextOperation,
  outputSchema: S,
  stdout: string,
): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> {
  return Schema.decodeEffect(Schema.fromJsonString(outputSchema))(extractJsonObject(stdout)).pipe(
    Effect.mapError(
      (cause) =>
        new TextGenerationError({
          operation,
          detail: "Muse returned output outside the requested JSON shape.",
          cause,
        }),
    ),
  );
}

export const makeMuseTextGeneration = Effect.fn("makeMuseTextGeneration")(function* (input: {
  readonly museBin: string;
  readonly environment?: NodeJS.ProcessEnv;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const resolvedEnvironment = input.environment ?? process.env;

  const runMuseExec = Effect.fn("runMuseExec")(function* <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchema,
    modelSelection,
  }: {
    readonly operation: TextOperation;
    readonly cwd: string;
    readonly prompt: string;
    readonly outputSchema: S;
    readonly modelSelection: ModelSelection;
  }): Effect.fn.Return<S["Type"], TextGenerationError, Scope.Scope | S["DecodingServices"]> {
    const promptPath = yield* fileSystem
      .makeTempFileScoped({ prefix: `t3code-muse-text-${process.pid}-` })
      .pipe(
        Effect.tap((filePath) => fileSystem.writeFileString(filePath, `${prompt}${JSON_ONLY_SUFFIX}`)),
        Effect.mapError(
          (cause) =>
            new TextGenerationError({ operation, detail: "Failed to write Muse prompt file.", cause }),
        ),
      );
    const reasoningEffort =
      getModelSelectionStringOptionValue(modelSelection, "reasoningEffort") ??
      DEFAULT_TEXT_GENERATION_REASONING_EFFORT;
    const spawnCommand = yield* resolveSpawnCommand(
      input.museBin,
      [
        "exec",
        "--prompt-file",
        promptPath,
        "--model",
        modelSelection.model,
        "--reasoning-effort",
        reasoningEffort,
      ],
      { env: resolvedEnvironment },
    ).pipe(
      Effect.mapError((cause) => normalizeCliError("muse", operation, cause, "Failed to resolve Muse spawn.")),
    );
    const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      env: resolvedEnvironment,
      cwd,
      shell: spawnCommand.shell,
    });
    const child = yield* commandSpawner.spawn(command).pipe(
      Effect.mapError((cause) =>
        normalizeCliError("muse", operation, cause, "Failed to spawn Muse CLI process"),
      ),
    );
    const collected = yield* Effect.gen(function* () {
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          child.stdout.pipe(
            Stream.decodeText(),
            Stream.runFold(() => "", (acc, chunk) => acc + chunk),
            Effect.mapError((cause) =>
              normalizeCliError("muse", operation, cause, "Failed to collect Muse output"),
            ),
          ),
          child.stderr.pipe(
            Stream.decodeText(),
            Stream.runFold(() => "", (acc, chunk) => acc + chunk),
            Effect.mapError((cause) =>
              normalizeCliError("muse", operation, cause, "Failed to collect Muse error output"),
            ),
          ),
          Effect.mapError(
            child.exitCode,
            (cause) => normalizeCliError("muse", operation, cause, "Muse text generation failed."),
          ),
        ],
        { concurrency: "unbounded" },
      );
      if (exitCode !== 0) {
        const stderrDetail = stderr.trim();
        const stdoutDetail = stdout.trim();
        const detail = stderrDetail.length > 0 ? stderrDetail : stdoutDetail;
        return yield* new TextGenerationError({
          operation,
          detail:
            detail.length > 0
              ? `Muse CLI command failed: ${detail}`
              : `Muse CLI command failed with code ${exitCode}.`,
        });
      }
      return stdout;
    }).pipe(
      Effect.timeoutOption(MUSE_TIMEOUT_MS),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new TextGenerationError({ operation, detail: "Muse text generation timed out." }),
            ),
          onSome: (value) => Effect.succeed(value),
        }),
      ),
    );
    return yield* decodeMuseJsonOutput(operation, outputSchema, collected);
  });

  return {
    generateCommitMessage: (input: TextGeneration.CommitMessageGenerationInput) =>
      Effect.gen(function* () {
        const built = buildCommitMessagePrompt(input);
        const decoded = yield* runMuseExec({
          operation: "generateCommitMessage",
          cwd: input.cwd,
          prompt: built.prompt,
          outputSchema: built.outputSchema,
          modelSelection: input.modelSelection,
        }).pipe(Effect.scoped);
        const branch =
          "branch" in decoded && typeof decoded.branch === "string"
            ? sanitizeBranchFragment(decoded.branch)
            : undefined;
        return {
          subject: sanitizeCommitSubject(decoded.subject),
          body: decoded.body.trim(),
          ...(branch === undefined ? {} : { branch }),
        } satisfies TextGeneration.CommitMessageGenerationResult;
      }),
    generatePrContent: (input: TextGeneration.PrContentGenerationInput) =>
      Effect.gen(function* () {
        const built = buildPrContentPrompt(input);
        const decoded = yield* runMuseExec({
          operation: "generatePrContent",
          cwd: input.cwd,
          prompt: built.prompt,
          outputSchema: built.outputSchema,
          modelSelection: input.modelSelection,
        }).pipe(Effect.scoped);
        return {
          title: sanitizePrTitle(decoded.title),
          body: decoded.body.trim(),
        } satisfies TextGeneration.PrContentGenerationResult;
      }),
    generateBranchName: (input: TextGeneration.BranchNameGenerationInput) =>
      Effect.gen(function* () {
        const built = buildBranchNamePrompt(input);
        const decoded = yield* runMuseExec({
          operation: "generateBranchName",
          cwd: input.cwd,
          prompt: built.prompt,
          outputSchema: built.outputSchema,
          modelSelection: input.modelSelection,
        }).pipe(Effect.scoped);
        return {
          branch: sanitizeBranchFragment(decoded.branch),
        } satisfies TextGeneration.BranchNameGenerationResult;
      }),
    generateThreadTitle: (input: TextGeneration.ThreadTitleGenerationInput) =>
      Effect.gen(function* () {
        const built = buildThreadTitlePrompt(input);
        const decoded = yield* runMuseExec({
          operation: "generateThreadTitle",
          cwd: input.cwd,
          prompt: built.prompt,
          outputSchema: built.outputSchema,
          modelSelection: input.modelSelection,
        }).pipe(Effect.scoped);
        return {
          title: sanitizeThreadTitle(decoded.title),
          ...(typeof decoded.needsRefinement === "boolean"
            ? { needsRefinement: decoded.needsRefinement }
            : {}),
        } satisfies TextGeneration.ThreadTitleGenerationResult;
      }),
  } satisfies TextGeneration.TextGeneration["Service"];
});
