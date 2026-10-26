import { connectionAtomRuntime } from "~/connection/runtime";
import { createCommitsEnvironmentAtoms } from "./backend.ts";

export const commitsEnvironment = createCommitsEnvironmentAtoms(connectionAtomRuntime);
