/**
 * Applied copies of policy documents in `statev2.sqlite` (`ft3_policy_applied`,
 * design §10.4). Applied state must survive a restart, so a pending external
 * edit is never applied silently after one; the database is additive state and
 * a store failure only degrades apply persistence, never startup.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";

import type { PolicyDocumentKey } from "./contracts.ts";

/** Who applied a version; stored for the Policies tab and audit. */
export const POLICY_APPLIED_BY = ["human_tab", "human_apply", "auto"] as const;
export type PolicyAppliedBy = (typeof POLICY_APPLIED_BY)[number];

/** Applied state is environment-wide in this slice; a project override is a later seam. */
export const POLICY_ENVIRONMENT_SCOPE = "environment";

export interface PolicyAppliedFile {
  /** "" for the main document, else the manifest-relative path of a tree file. */
  readonly file: string;
  readonly sha256: string;
  readonly content: string;
  /** Store stable id when the file lives in the store. */
  readonly stableId: string | null;
}

export interface PolicyAppliedRecord extends PolicyAppliedFile {
  readonly appliedAt: string;
  readonly appliedBy: PolicyAppliedBy;
}

export interface PolicyAppliedLoadInput {
  readonly scope: string;
  readonly key: PolicyDocumentKey;
}

export interface PolicyAppliedSaveInput extends PolicyAppliedLoadInput {
  readonly files: readonly PolicyAppliedFile[];
  readonly appliedAt: string;
  readonly appliedBy: PolicyAppliedBy;
}

export class PolicyAppliedStore extends Context.Service<
  PolicyAppliedStore,
  {
    readonly load: (
      input: PolicyAppliedLoadInput,
    ) => Effect.Effect<readonly PolicyAppliedRecord[], never>;
    /** Replaces every applied file of the document atomically. */
    readonly save: (input: PolicyAppliedSaveInput) => Effect.Effect<void, never>;
  }
>()("@t3tools/ft3-policies/policyAppliedStore") {}

/** SQLite-backed applied copies; a missing table degrades to no persistence. */
const sqlLayer = Layer.effect(
  PolicyAppliedStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const load = Effect.fn("PolicyAppliedStore.load")(function* (input: PolicyAppliedLoadInput) {
      const rows = yield* sql<{
        readonly file: string;
        readonly stable_id: string | null;
        readonly sha256: string;
        readonly content: string;
        readonly applied_at: string;
        readonly applied_by: string;
      }>`
        SELECT file, stable_id, sha256, content, applied_at, applied_by
        FROM ft3_policy_applied
        WHERE scope = ${input.scope} AND key = ${input.key}
        ORDER BY file
      `;
      return rows.map(
        (row) =>
          ({
            file: row.file,
            stableId: row.stable_id,
            sha256: row.sha256,
            content: row.content,
            appliedAt: row.applied_at,
            appliedBy: row.applied_by as PolicyAppliedBy,
          }) satisfies PolicyAppliedRecord,
      );
    });

    const save = Effect.fn("PolicyAppliedStore.save")(function* (input: PolicyAppliedSaveInput) {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`
            DELETE FROM ft3_policy_applied
            WHERE scope = ${input.scope} AND key = ${input.key}
          `;
          for (const file of input.files) {
            yield* sql`
              INSERT INTO ft3_policy_applied
                (scope, key, file, stable_id, sha256, content, applied_at, applied_by)
              VALUES
                (${input.scope}, ${input.key}, ${file.file}, ${file.stableId}, ${file.sha256},
                 ${file.content}, ${input.appliedAt}, ${input.appliedBy})
            `;
          }
        }),
      );
    });

    return PolicyAppliedStore.of({
      load: Effect.fn("PolicyAppliedStore.loadOrEmpty")((input: PolicyAppliedLoadInput) =>
        load(input).pipe(Effect.orElseSucceed(() => [])),
      ),
      save: Effect.fn("PolicyAppliedStore.saveOrWarn")((input: PolicyAppliedSaveInput) =>
        save(input).pipe(
          Effect.catch((cause) =>
            Effect.logWarning(`Could not persist the applied policy version: ${cause}`),
          ),
        ),
      ),
    });
  }),
);

export const layer = sqlLayer;

/** Test double: applied copies in memory, keyed by scope and document. */
export const layerMemory: Layer.Layer<PolicyAppliedStore> = Layer.effect(
  PolicyAppliedStore,
  Effect.map(Ref.make(new Map<string, PolicyAppliedRecord[]>()), (state) => {
    const idOf = (input: PolicyAppliedLoadInput) => `${input.scope}\u0000${input.key}`;
    return PolicyAppliedStore.of({
      load: Effect.fn("PolicyAppliedStore.memoryLoad")((input: PolicyAppliedLoadInput) =>
        Effect.map(Ref.get(state), (all) => all.get(idOf(input)) ?? []),
      ),
      save: Effect.fn("PolicyAppliedStore.memorySave")((input: PolicyAppliedSaveInput) =>
        Ref.update(state, (all) => {
          const next = new Map(all);
          next.set(
            idOf(input),
            input.files.map((file) => ({
              ...file,
              appliedAt: input.appliedAt,
              appliedBy: input.appliedBy,
            })),
          );
          return next;
        }),
      ),
    });
  }),
);
