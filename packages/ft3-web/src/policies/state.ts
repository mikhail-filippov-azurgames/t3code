import { connectionAtomRuntime } from "~/connection/runtime";
import { createPoliciesEnvironmentAtoms } from "./backend.ts";

export const policiesEnvironment = createPoliciesEnvironmentAtoms(connectionAtomRuntime);
