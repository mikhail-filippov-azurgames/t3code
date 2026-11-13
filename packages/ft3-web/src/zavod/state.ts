import { connectionAtomRuntime } from "~/connection/runtime";
import { createZavodEnvironmentAtoms } from "./backend.ts";

export const zavodEnvironment = createZavodEnvironmentAtoms(connectionAtomRuntime);
