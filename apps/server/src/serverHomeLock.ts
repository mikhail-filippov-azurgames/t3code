// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

const lockFileName = "server.lock";

class ServerHomeLockError extends Data.TaggedError("ServerHomeLockError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export const serverHomeLockPath = (stateDir: string) => NodePath.join(stateDir, lockFileName);

const isProcessAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

const readLockPid = (lockPath: string) => {
  const contents = NodeFS.readFileSync(lockPath, "utf8").trim();
  const pid = Number(contents);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`The server lock at '${lockPath}' has an invalid PID.`);
  }
  return pid;
};

const acquire = (stateDir: string) => {
  NodeFS.mkdirSync(stateDir, { recursive: true });
  const lockPath = serverHomeLockPath(stateDir);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const fd = NodeFS.openSync(lockPath, "wx");
      try {
        NodeFS.writeFileSync(fd, `${process.pid}\n`);
        return { fd, lockPath };
      } catch (error) {
        NodeFS.closeSync(fd);
        NodeFS.unlinkSync(lockPath);
        throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    let pid: number;
    try {
      pid = readLockPid(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (isProcessAlive(pid)) {
      throw new Error(
        `T3 Code cannot start because this data directory is already in use by process ${pid}. ` +
          `That server owns the database and server-runtime.json. Stop it before starting another server with this home, or use a separate --home-dir.`,
      );
    }

    try {
      NodeFS.unlinkSync(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  throw new Error(`Could not acquire the T3 Code data directory lock at '${lockPath}'.`);
};

export const acquireServerHomeLock = (stateDir: string) =>
  Effect.acquireRelease(
    Effect.try({
      try: () => acquire(stateDir),
      catch: (error) =>
        new ServerHomeLockError({
          message:
            error instanceof Error
              ? error.message
              : "Could not acquire the T3 Code data directory lock.",
          cause: error,
        }),
    }),
    ({ fd, lockPath }) =>
      Effect.sync(() => {
        NodeFS.closeSync(fd);
        try {
          if (readLockPid(lockPath) === process.pid) NodeFS.unlinkSync(lockPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }),
  );
