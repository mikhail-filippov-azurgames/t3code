// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { acquireServerHomeLock, serverHomeLockPath } from "./serverHomeLock.ts";

describe("server home lock", () => {
  it.effect("rejects a second server while the first server holds the same home", () => {
    const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-server-lock-"));

    return Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* acquireServerHomeLock(stateDir);
          const error = yield* acquireServerHomeLock(stateDir).pipe(Effect.flip);

          expect(error.message).toContain(`process ${process.pid}`);
          expect(error.message).toContain("Stop it before starting another server");
        }),
      );
      expect(NodeFS.existsSync(serverHomeLockPath(stateDir))).toBe(false);
    }).pipe(
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(stateDir, { recursive: true, force: true }))),
    );
  });

  it.effect("takes over a lock left by a dead process", () => {
    const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-server-lock-stale-"));
    const lockPath = serverHomeLockPath(stateDir);
    NodeFS.writeFileSync(lockPath, "2147483647\n");

    return Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* acquireServerHomeLock(stateDir);
          expect(NodeFS.readFileSync(lockPath, "utf8").trim()).toBe(String(process.pid));
        }),
      );
      expect(NodeFS.existsSync(lockPath)).toBe(false);
    }).pipe(
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(stateDir, { recursive: true, force: true }))),
    );
  });
});
