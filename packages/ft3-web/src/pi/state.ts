import { connectionAtomRuntime } from "~/connection/runtime";
import { createPiInferenceEnvironmentAtoms } from "./backend.ts";

export const piEnvironment = createPiInferenceEnvironmentAtoms(connectionAtomRuntime);
