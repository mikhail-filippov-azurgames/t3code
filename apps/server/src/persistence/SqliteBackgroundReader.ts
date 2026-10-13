// @effect-diagnostics nodeBuiltinImport:off
import * as NodeWorkerThreads from "node:worker_threads";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { SqlError, classifySqliteError } from "effect/unstable/sql/SqlError";
import type * as Statement from "effect/unstable/sql/Statement";

/**
 * Runs heavy read-only statements away from the event loop. `node:sqlite` is
 * synchronous, so a slow query on the main connection freezes every request.
 */
export class SqliteBackgroundReader extends Context.Service<
  SqliteBackgroundReader,
  {
    readonly all: <A extends object>(
      statement: Statement.Statement<A>,
    ) => Effect.Effect<ReadonlyArray<A>, SqlError>;
  }
>()("t3/persistence/SqliteBackgroundReader") {}

// Plain CommonJS evaluated by the worker, so the server bundle needs no extra entry.
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(workerData.filename, { readOnly: true });
db.exec("PRAGMA busy_timeout = 5000");
const statements = new Map();
parentPort.on("message", ({ id, sql, params }) => {
  try {
    let statement = statements.get(sql);
    if (statement === undefined) {
      if (statements.size >= 32) statements.clear();
      statement = db.prepare(sql);
      statements.set(sql, statement);
    }
    parentPort.postMessage({ id, rows: statement.all(...params) });
  } catch (error) {
    parentPort.postMessage({
      id,
      error: { message: String(error && error.message), code: error && error.code, errcode: error && error.errcode },
    });
  }
});
`;

type WorkerReply =
  | { readonly id: number; readonly rows: ReadonlyArray<object> }
  | {
      readonly id: number;
      readonly error: {
        readonly message: string;
        readonly code?: unknown;
        readonly errcode?: unknown;
      };
    };

const toSqlError = (cause: unknown, operation: string) =>
  new SqlError({
    reason: classifySqliteError(cause, { message: "Background read failed", operation }),
  });

/** A read-only connection to `filename` on a worker thread, spawned on first use. */
export const layerWorker = (filename: string) =>
  Layer.effect(
    SqliteBackgroundReader,
    Effect.gen(function* () {
      let worker: NodeWorkerThreads.Worker | undefined;
      let nextId = 0;
      const pending = new Map<
        number,
        (effect: Effect.Effect<ReadonlyArray<object>, SqlError>) => void
      >();

      const failAll = (failed: NodeWorkerThreads.Worker, cause: unknown) => {
        if (worker !== failed) return;
        worker = undefined;
        const error = toSqlError(cause, "worker");
        for (const resume of pending.values()) resume(Effect.fail(error));
        pending.clear();
      };

      const ensureWorker = () => {
        if (worker !== undefined) return worker;
        const spawned = new NodeWorkerThreads.Worker(WORKER_SOURCE, {
          eval: true,
          workerData: { filename },
        });
        spawned.unref();
        spawned.on("message", (reply: WorkerReply) => {
          const resume = pending.get(reply.id);
          if (resume === undefined) return;
          pending.delete(reply.id);
          resume(
            "rows" in reply
              ? Effect.succeed(reply.rows)
              : Effect.fail(
                  toSqlError(
                    Object.assign(new Error(reply.error.message), {
                      code: reply.error.code,
                      errcode: reply.error.errcode,
                    }),
                    "execute",
                  ),
                ),
          );
        });
        spawned.on("error", (cause) => failAll(spawned, cause));
        spawned.on("exit", (code) =>
          failAll(spawned, new Error(`SQLite background reader exited with code ${code}`)),
        );
        worker = spawned;
        return spawned;
      };

      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          const current = worker;
          worker = undefined;
          await current?.terminate();
        }),
      );

      const all = <A extends object>(statement: Statement.Statement<A>) =>
        Effect.callback<ReadonlyArray<object>, SqlError>((resume) => {
          const id = nextId++;
          pending.set(id, resume);
          try {
            const [sql, params] = statement.compile();
            // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
            ensureWorker().postMessage({ id, sql, params });
          } catch (cause) {
            pending.delete(id);
            resume(Effect.fail(toSqlError(cause, "postMessage")));
          }
          return Effect.sync(() => {
            pending.delete(id);
          });
        }).pipe(
          Effect.map((rows) => rows as ReadonlyArray<A>),
          Effect.withSpan("SqliteBackgroundReader.all"),
        );

      return SqliteBackgroundReader.of({ all });
    }),
  );

/** In-memory databases cannot be shared across threads, so reads stay on the main connection. */
export const layerSameConnection = Layer.succeed(
  SqliteBackgroundReader,
  SqliteBackgroundReader.of({ all: (statement) => statement }),
);
