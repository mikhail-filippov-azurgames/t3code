// @effect-diagnostics nodeBuiltinImport:off
// Interactive stdin writes are not exposed by Effect's ChildProcess handle;
// same suppression precedent as serviceLauncher.ts and cli/triage.ts.
import * as NodeChildProcess from "node:child_process";

/**
 * Plain (Effect-free) Node process factory for Pi RPC children.
 *
 * Kept free of Effect imports on purpose: the Pi RPC child needs
 * interactive stdin writes, which Effect's `ChildProcess` handle does not
 * expose, and this keeps the spawn boundary identical to the existing
 * `serviceLauncher.ts` precedent.
 *
 * @module provider/pi/piProcessFactory
 */

export interface PiSpawnedProcess {
  readonly pid: number | undefined;
  readonly writeStdin: (line: string) => void;
  readonly endStdin: () => void;
  readonly kill: (signal?: NodeJS.Signals) => void;
  readonly onStdout: (listener: (chunk: string) => void) => void;
  readonly onStderr: (listener: (chunk: string) => void) => void;
  readonly onExit: (listener: (code: number | null) => void) => void;
  readonly onClose: (listener: (code: number | null) => void) => void;
  readonly onError: (listener: (cause: unknown) => void) => void;
}

export type PiProcessFactory = (input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}) => PiSpawnedProcess;

export const nodePiProcessFactory: PiProcessFactory = (input) => {
  const child = NodeChildProcess.spawn(input.command, [...input.args], {
    cwd: input.cwd,
    env: input.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout?.setEncoding("utf-8");
  child.stderr?.setEncoding("utf-8");
  return {
    pid: child.pid,
    writeStdin: (line) => {
      child.stdin?.write(line);
    },
    endStdin: () => {
      child.stdin?.end();
    },
    kill: (signal) => {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal ?? "SIGTERM");
    },
    onStdout: (listener) => {
      child.stdout?.on("data", listener);
    },
    onStderr: (listener) => {
      child.stderr?.on("data", listener);
    },
    onExit: (listener) => {
      child.on("exit", (code) => listener(code));
    },
    onClose: (listener) => {
      child.on("close", (code) => listener(code));
    },
    onError: (listener) => {
      child.on("error", listener);
    },
  };
};
