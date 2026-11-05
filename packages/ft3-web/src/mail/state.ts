import { connectionAtomRuntime } from "~/connection/runtime";
import { createMailEnvironmentAtoms } from "./backend.ts";

export const mailEnvironment = createMailEnvironmentAtoms(connectionAtomRuntime);
