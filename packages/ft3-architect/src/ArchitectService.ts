import { CommandId, isProviderAvailable, type ModelSelection, ThreadId } from "@t3tools/contracts";
import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as BoardRepository from "@t3tools/ft3-board/repository";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";

import * as McpInvocationContext from "../../../apps/server/src/mcp/McpInvocationContext.ts";
import * as ProviderRegistry from "../../../apps/server/src/provider/ProviderRegistry.ts";
import * as ThreadManagement from "../../../apps/server/src/orchestration-v2/ThreadManagementService.ts";
import * as ArchitectRepository from "./ArchitectRepository.ts";
import * as Contracts from "./contracts.ts";

type Scope = McpInvocationContext.McpInvocationScope;

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
};

export class ArchitectService extends Context.Service<
  ArchitectService,
  {
    readonly getBinding: (
      scope: Scope,
      input: Contracts.ArchitectGetCoordinatorBindingInput,
    ) => Effect.Effect<
      Contracts.ArchitectGetCoordinatorBindingResult,
      Contracts.ArchitectMcpFailure
    >;
    readonly listReviews: (
      scope: Scope,
      input: Contracts.ArchitectListArchitectureReviewsInput,
    ) => Effect.Effect<
      Contracts.ArchitectListArchitectureReviewsResult,
      Contracts.ArchitectMcpFailure
    >;
    readonly createOrGet: (
      scope: Scope,
      input: Contracts.ArchitectCreateOrGetInput,
    ) => Effect.Effect<Contracts.ArchitectCreateOrGetResult, Contracts.ArchitectMcpFailure>;
    readonly replace: (
      scope: Scope,
      input: Contracts.ArchitectReplaceInput,
    ) => Effect.Effect<Contracts.ArchitectReplaceResult, Contracts.ArchitectMcpFailure>;
    readonly detach: (
      scope: Scope,
      input: Contracts.ArchitectDetachInput,
    ) => Effect.Effect<Contracts.ArchitectDetachResult, Contracts.ArchitectMcpFailure>;
  }
>()("@t3tools/ft3-architect/ArchitectService") {}

const unavailable = () =>
  new Contracts.ArchitectMcpFailure({
    code: "orchestration_error",
    message: "The architect query could not be completed.",
  });

const repositoryFailure = (
  error: ArchitectRepository.ArchitectRepositoryError | Contracts.ArchitectMcpFailure,
) => (error._tag === "OrchestratorMcpFailure" ? error : unavailable());

const make = Effect.gen(function* () {
  const repo = yield* ArchitectRepository.ArchitectRepository;
  const board = yield* BoardRepository.BoardRepository;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const crypto = yield* Crypto.Crypto;
  const hash = (value: unknown) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(JSON.stringify(stableValue(value))))
      .pipe(Effect.map(Hex.encode), Effect.mapError(unavailable));

  const resolveCaller = Effect.fn("Ft3ArchitectService.resolveCaller")(function* (scope: Scope) {
    if (!scope.capabilities.has("orchestration")) {
      return yield* new Contracts.ArchitectMcpFailure({
        code: "capability_denied",
        message: "This credential cannot read architect bindings or reviews.",
      });
    }
    const caller = yield* McpInvocationContext.requireThreadScope(scope, "Architect queries");
    const shell = yield* threads
      .getThreadShell(caller.thread.threadId)
      .pipe(Effect.mapError(unavailable));
    if (shell === null || shell.deletedAt !== null) {
      return yield* new Contracts.ArchitectMcpFailure({
        code: "thread_not_found",
        message: "The calling thread was not found.",
      });
    }
    if (shell.lineage.relationshipToParent === "subagent") {
      return yield* new Contracts.ArchitectMcpFailure({
        code: "delegated_executor_denied",
        message: "Delegated executor threads cannot query architect bindings or reviews.",
      });
    }
    const binding = yield* repo
      .getActiveBindingByArchitect(caller.thread.threadId)
      .pipe(Effect.mapError(unavailable));
    return { caller, binding };
  });

  const requireQueryScope = Effect.fn("Ft3ArchitectService.requireQueryScope")(function* (
    scope: Scope,
    coordinatorThreadId: ThreadId,
  ) {
    const { caller, binding } = yield* resolveCaller(scope);
    if (binding !== null) {
      if (binding.coordinatorThreadId !== coordinatorThreadId) {
        return yield* new Contracts.ArchitectMcpFailure({
          code: "architect_denied",
          message: "Architect threads may only query their own binding and reviews.",
        });
      }
      return;
    }
    if (caller.thread.threadId !== coordinatorThreadId) {
      return yield* new Contracts.ArchitectMcpFailure({
        code: "capability_denied",
        message: "Only the coordinator thread itself (or a human on it) may query this binding.",
      });
    }
    const orchestrators = yield* board.listOrchestrators().pipe(Effect.mapError(unavailable));
    if (
      !orchestrators.some(
        (mark) => mark.threadId === coordinatorThreadId && mark.createdBy === "human",
      )
    ) {
      return yield* new Contracts.ArchitectMcpFailure({
        code: "capability_denied",
        message:
          "This thread is not a registered board orchestrator. Ask a human to mark this thread as a board orchestrator, then retry this tool.",
      });
    }
  });

  const requireControlScope = Effect.fn("Ft3ArchitectService.requireControlScope")(function* (
    scope: Scope,
    coordinatorThreadId: ThreadId,
    operation: "create an architect" | "replace the architect" | "detach the architect",
  ) {
    if (!scope.capabilities.has("orchestration")) {
      return yield* new Contracts.ArchitectMcpFailure({
        code: "capability_denied",
        message: `This credential cannot ${operation}.`,
      });
    }
    const caller = yield* McpInvocationContext.requireThreadScope(scope, "Architect control");
    const shell = yield* threads
      .getThreadShell(caller.thread.threadId)
      .pipe(Effect.mapError(unavailable));
    if (shell === null || shell.deletedAt !== null) {
      return yield* new Contracts.ArchitectMcpFailure({
        code: "thread_not_found",
        message: "The calling thread was not found.",
      });
    }
    if (shell.lineage.relationshipToParent === "subagent") {
      return yield* new Contracts.ArchitectMcpFailure({
        code: "delegated_executor_denied",
        message: `Delegated executor threads cannot ${operation}.`,
      });
    }
    const binding = yield* repo
      .getActiveBindingByArchitect(caller.thread.threadId)
      .pipe(Effect.mapError(unavailable));
    if (binding !== null) {
      return yield* new Contracts.ArchitectMcpFailure({
        code: "architect_denied",
        message: `Architect threads cannot ${operation}.`,
      });
    }
    if (caller.thread.threadId !== coordinatorThreadId) {
      return yield* new Contracts.ArchitectMcpFailure({
        code: "capability_denied",
        message: `Only the coordinator thread itself (or a human on it) may ${operation}.`,
      });
    }
    const orchestrators = yield* board.listOrchestrators().pipe(Effect.mapError(unavailable));
    if (
      !orchestrators.some(
        (mark) => mark.threadId === coordinatorThreadId && mark.createdBy === "human",
      )
    ) {
      return yield* new Contracts.ArchitectMcpFailure({
        code: "capability_denied",
        message:
          "This thread is not a registered board orchestrator. Ask a human to mark this thread as a board orchestrator, then retry this tool.",
      });
    }
    return { caller, shell };
  });

  const requireCreateScope = Effect.fn("Ft3ArchitectService.requireCreateScope")(function* (
    scope: Scope,
    coordinatorThreadId: ThreadId,
  ) {
    return yield* requireControlScope(scope, coordinatorThreadId, "create an architect");
  });

  const validateArchitectSelection = Effect.fn("Ft3ArchitectService.validateArchitectSelection")(
    function* (input: Contracts.ArchitectCreateOrGetInput) {
      const evidence = input.routingEvidence;
      const selected = evidence.consideredCandidates.at(-1);
      const optionsMatch =
        (yield* hash(selected === undefined ? [] : selected.options)) ===
        (yield* hash(input.modelSelection.options ?? []));
      if (
        evidence.role !== "architecture" ||
        evidence.taskEffort !== input.taskEffort ||
        selected === undefined ||
        selected.disposition !== "selected" ||
        selected.providerInstanceId !== input.modelSelection.instanceId ||
        selected.model !== input.modelSelection.model ||
        !optionsMatch
      ) {
        return yield* new Contracts.ArchitectMcpFailure({
          code: "routing_evidence_mismatch",
          message: "The selected model does not match the accepted architecture routing evidence.",
        });
      }
      const catalog = yield* providers.getProviders.pipe(Effect.mapError(unavailable));
      const provider = catalog.find(
        (candidate) => candidate.instanceId === input.modelSelection.instanceId,
      );
      if (provider === undefined || provider.driver !== selected.driverKind) {
        return yield* new Contracts.ArchitectMcpFailure({
          code: "provider_unavailable",
          message: `Selected architecture provider ${input.modelSelection.instanceId} is not live under the recorded driver.`,
        });
      }
      if (!isProviderAvailable(provider)) {
        return yield* new Contracts.ArchitectMcpFailure({
          code: "provider_unavailable",
          message:
            provider.unavailableReason ?? "The selected architecture provider is unavailable.",
        });
      }
      const model = provider.models.find(
        (candidate) => candidate.slug === input.modelSelection.model,
      );
      if (model === undefined) {
        return yield* new Contracts.ArchitectMcpFailure({
          code: "model_unavailable",
          message: `Selected architecture model ${input.modelSelection.model} is not in the live provider catalog.`,
        });
      }
    },
  );

  const createArchitectThread = Effect.fn("Ft3ArchitectService.createArchitectThread")(function* (
    binding: Contracts.CoordinatorArchitectBinding,
    coordinator: OrchestrationV2ThreadShell,
  ) {
    const evidence = binding.routingEvidence;
    const selected = evidence?.consideredCandidates.at(-1);
    if (selected === undefined || selected.disposition !== "selected") {
      return yield* new Contracts.ArchitectMcpFailure({
        code: "routing_evidence_mismatch",
        message: "The active architect binding has no selected routing evidence.",
      });
    }
    const modelSelection: ModelSelection = {
      instanceId: selected.providerInstanceId,
      model: selected.model,
      options: selected.options,
    };
    yield* threads
      .dispatch({
        type: "thread.create",
        commandId: CommandId.make(`architect-create:${binding.bindingId}`),
        threadId: binding.architectThreadId,
        projectId: binding.projectId,
        title: "Architect",
        modelSelection,
        runtimeMode: coordinator.runtimeMode,
        interactionMode: "default",
        branch: coordinator.branch,
        worktreePath: coordinator.worktreePath,
        createdBy: "agent",
        creationSource: "mcp",
      })
      .pipe(Effect.mapError(unavailable));
  });

  const softDeleteArchitectThread = Effect.fn("Ft3ArchitectService.softDeleteArchitectThread")(
    function* (threadId: ThreadId) {
      const shell = yield* threads.getThreadShell(threadId).pipe(Effect.mapError(unavailable));
      if (shell === null) return;
      yield* threads
        .dispatch({
          type: "thread.delete",
          commandId: CommandId.make(`architect-delete:${threadId}`),
          threadId,
        })
        .pipe(Effect.mapError(unavailable));
    },
  );

  return ArchitectService.of({
    getBinding: Effect.fn("Ft3ArchitectService.getBinding")(function* (scope, input) {
      yield* requireQueryScope(scope, input.coordinatorThreadId);
      const binding = yield* repo
        .getActiveBindingByCoordinator(input.coordinatorThreadId)
        .pipe(Effect.mapError(unavailable));
      return { binding };
    }),
    listReviews: Effect.fn("Ft3ArchitectService.listReviews")(function* (scope, input) {
      yield* requireQueryScope(scope, input.coordinatorThreadId);
      const reviews = yield* repo
        .listReviewsByCoordinator({
          coordinatorThreadId: input.coordinatorThreadId,
          ...(input.status === undefined ? {} : { status: input.status }),
        })
        .pipe(Effect.mapError(unavailable));
      return { reviews };
    }),
    createOrGet: Effect.fn("Ft3ArchitectService.createOrGet")(function* (scope, input) {
      const { caller, shell } = yield* requireCreateScope(scope, input.coordinatorThreadId);
      yield* validateArchitectSelection(input);
      const at = DateTime.formatIso(yield* DateTime.now);
      const coordinatorThreadId = input.coordinatorThreadId;
      const bindingId = `architect-binding:${(yield* hash(["architect-binding", coordinatorThreadId, input.idempotencyKey])).slice(0, 40)}`;
      const architectThreadId = ThreadId.make(
        `arch:${(yield* hash(["architect-thread", coordinatorThreadId, input.idempotencyKey])).slice(0, 40)}`,
      );
      const createRequestFingerprint = yield* hash({
        taskEffort: input.taskEffort,
        modelSelection: input.modelSelection,
        routingEvidence: input.routingEvidence,
      });
      const outcome = yield* repo
        .createOrGetBinding({
          bindingId,
          coordinatorThreadId,
          architectThreadId,
          projectId: shell.projectId,
          architectTaskEffort: input.taskEffort,
          routingEvidence: input.routingEvidence,
          createdAt: at,
          createdBy: caller.thread.threadId,
          createIdempotencyKey: input.idempotencyKey,
          createRequestFingerprint,
        })
        .pipe(Effect.mapError(repositoryFailure));
      const binding = outcome.binding;
      if (binding.status !== "active") {
        return yield* new Contracts.ArchitectMcpFailure({
          code: "binding_not_found",
          message:
            "This architect binding is terminal and cannot be recreated by replaying its create key.",
        });
      }
      const exactCreateReplay = binding.createIdempotencyKey === input.idempotencyKey;
      if (!outcome.created && !exactCreateReplay) {
        return { architectThreadId: binding.architectThreadId, created: false, binding };
      }
      const existingThread = yield* threads
        .getThreadShell(binding.architectThreadId)
        .pipe(Effect.mapError(unavailable));
      if (existingThread === null || existingThread.deletedAt !== null) {
        yield* createArchitectThread(binding, shell);
      }
      return { architectThreadId: binding.architectThreadId, created: outcome.created, binding };
    }),
    replace: Effect.fn("Ft3ArchitectService.replace")(function* (scope, input) {
      const { caller, shell } = yield* requireControlScope(
        scope,
        input.coordinatorThreadId,
        "replace the architect",
      );
      yield* validateArchitectSelection(input);
      const at = DateTime.formatIso(yield* DateTime.now);
      const coordinatorThreadId = input.coordinatorThreadId;
      const bindingId = `architect-binding:${(yield* hash(["architect-binding", coordinatorThreadId, input.idempotencyKey])).slice(0, 40)}`;
      const architectThreadId = ThreadId.make(
        `arch:${(yield* hash(["architect-thread", coordinatorThreadId, input.idempotencyKey])).slice(0, 40)}`,
      );
      const closeRequestFingerprint = yield* hash({
        operation: "replace",
        reason: input.reason,
        taskEffort: input.taskEffort,
        modelSelection: input.modelSelection,
        routingEvidence: input.routingEvidence,
        replacedByBindingId: bindingId,
      });
      const createRequestFingerprint = yield* hash({
        taskEffort: input.taskEffort,
        modelSelection: input.modelSelection,
        routingEvidence: input.routingEvidence,
      });
      const createInput: Contracts.ArchitectCreateBindingInput = {
        bindingId,
        coordinatorThreadId,
        architectThreadId,
        projectId: shell.projectId,
        architectTaskEffort: input.taskEffort,
        routingEvidence: input.routingEvidence,
        createdAt: at,
        createdBy: caller.thread.threadId,
        createIdempotencyKey: input.idempotencyKey,
        createRequestFingerprint,
      };

      const priorReplacement = yield* repo
        .findBindingByCreateKey({ coordinatorThreadId, createIdempotencyKey: input.idempotencyKey })
        .pipe(Effect.mapError(repositoryFailure));
      if (priorReplacement !== null) {
        yield* repo.createOrGetBinding(createInput).pipe(Effect.mapError(repositoryFailure));
        if (priorReplacement.status === "active") {
          const existingThread = yield* threads
            .getThreadShell(priorReplacement.architectThreadId)
            .pipe(Effect.mapError(unavailable));
          if (existingThread === null || existingThread.deletedAt !== null) {
            yield* createArchitectThread(priorReplacement, shell);
          }
          const replaced = yield* repo
            .findReplaceReplay({
              coordinatorThreadId,
              closeIdempotencyKey: input.idempotencyKey,
              closeRequestFingerprint,
            })
            .pipe(Effect.mapError(repositoryFailure));
          if (replaced !== null) {
            const linked = yield* repo
              .linkReplacementWinner({
                replacedBindingId: replaced.bindingId,
                closeIdempotencyKey: input.idempotencyKey,
                closeRequestFingerprint,
                winnerBindingId: priorReplacement.bindingId,
              })
              .pipe(Effect.mapError(repositoryFailure));
            if (linked === null) {
              return yield* new Contracts.ArchitectMcpFailure({
                code: "binding_conflict",
                message: "The committed replacement could not be linked to its prior binding.",
              });
            }
            yield* softDeleteArchitectThread(replaced.architectThreadId);
          }
        }
        return { architectThreadId: priorReplacement.architectThreadId, binding: priorReplacement };
      }

      const active = yield* repo
        .getActiveBindingByCoordinator(coordinatorThreadId)
        .pipe(Effect.mapError(repositoryFailure));
      let closed: Contracts.CoordinatorArchitectBinding | null;
      if (active !== null) {
        closed = yield* repo
          .closeBinding({
            bindingId: active.bindingId,
            status: "replaced",
            replacedByBindingId: null,
            detachReason: input.reason,
            idempotencyKey: input.idempotencyKey,
            closeRequestFingerprint,
          })
          .pipe(Effect.mapError(repositoryFailure));
        if (closed === null) {
          const winner = yield* repo
            .getActiveBindingByCoordinator(coordinatorThreadId)
            .pipe(Effect.mapError(repositoryFailure));
          if (winner !== null) {
            return { architectThreadId: winner.architectThreadId, binding: winner };
          }
          return yield* new Contracts.ArchitectMcpFailure({
            code: "binding_conflict",
            message: "Another replacement committed the close; retry after its winner is visible.",
          });
        }
      } else {
        closed = yield* repo
          .findReplaceReplay({
            coordinatorThreadId,
            closeIdempotencyKey: input.idempotencyKey,
            closeRequestFingerprint,
          })
          .pipe(Effect.mapError(repositoryFailure));
        if (closed === null) {
          const winner = yield* repo
            .getActiveBindingByCoordinator(coordinatorThreadId)
            .pipe(Effect.mapError(repositoryFailure));
          if (winner !== null) {
            return { architectThreadId: winner.architectThreadId, binding: winner };
          }
          return yield* new Contracts.ArchitectMcpFailure({
            code: "binding_not_found",
            message:
              "No active architect or exact interrupted replacement exists for this coordinator.",
          });
        }
      }
      const created = yield* repo
        .createOrGetBinding(createInput)
        .pipe(Effect.mapError(repositoryFailure));
      const linked = yield* repo
        .linkReplacementWinner({
          replacedBindingId: closed.bindingId,
          closeIdempotencyKey: input.idempotencyKey,
          closeRequestFingerprint,
          winnerBindingId: created.binding.bindingId,
        })
        .pipe(Effect.mapError(repositoryFailure));
      if (linked === null) {
        return yield* new Contracts.ArchitectMcpFailure({
          code: "binding_conflict",
          message: "The committed replacement could not be linked to its prior binding.",
        });
      }
      if (created.binding.bindingId !== bindingId) {
        const winner = created.binding;
        yield* softDeleteArchitectThread(architectThreadId);
        return { architectThreadId: winner.architectThreadId, binding: winner };
      }
      const binding = created.binding;
      yield* createArchitectThread(binding, shell);
      yield* softDeleteArchitectThread(closed.architectThreadId);
      return { architectThreadId: binding.architectThreadId, binding };
    }),
    detach: Effect.fn("Ft3ArchitectService.detach")(function* (scope, input) {
      yield* requireControlScope(scope, input.coordinatorThreadId, "detach the architect");
      const coordinatorThreadId = input.coordinatorThreadId;
      const closeRequestFingerprint = yield* hash({ operation: "detach", reason: input.reason });
      const active = yield* repo
        .getActiveBindingByCoordinator(coordinatorThreadId)
        .pipe(Effect.mapError(repositoryFailure));
      if (active === null) {
        const replayed = yield* repo
          .findDetachReplay({
            coordinatorThreadId,
            closeIdempotencyKey: input.idempotencyKey,
            closeRequestFingerprint,
          })
          .pipe(Effect.mapError(repositoryFailure));
        if (replayed !== null) {
          return { binding: replayed };
        }
        return yield* new Contracts.ArchitectMcpFailure({
          code: "binding_not_found",
          message: "No active architect binding for this coordinator.",
        });
      }
      const closed = yield* repo
        .closeBinding({
          bindingId: active.bindingId,
          status: "detached",
          replacedByBindingId: null,
          detachReason: input.reason,
          idempotencyKey: input.idempotencyKey,
          closeRequestFingerprint,
        })
        .pipe(Effect.mapError(repositoryFailure));
      if (closed === null || closed.status !== "detached") {
        return yield* new Contracts.ArchitectMcpFailure({
          code: "binding_conflict",
          message:
            "The architect binding changed during detach; read the current binding before retrying.",
        });
      }
      yield* softDeleteArchitectThread(active.architectThreadId);
      return { binding: closed };
    }),
  });
});

export const layer = Layer.effect(ArchitectService, make);
