import { createBoardEnvironmentAtoms } from "@t3tools/client-runtime/state/board";

import { connectionAtomRuntime } from "../connection/runtime";

export const boardEnvironment = createBoardEnvironmentAtoms(connectionAtomRuntime);
