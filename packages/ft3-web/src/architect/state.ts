import { connectionAtomRuntime } from "~/connection/runtime";
import { createArchitectEnvironmentAtoms } from "./backend.ts";

export const architectEnvironment = createArchitectEnvironmentAtoms(connectionAtomRuntime);
