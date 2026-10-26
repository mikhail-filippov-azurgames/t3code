import { connectionAtomRuntime } from "~/connection/runtime";
import { createBoardEnvironmentAtoms } from "./backend.ts";

export const boardEnvironment = createBoardEnvironmentAtoms(connectionAtomRuntime);
