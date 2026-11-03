/** Server entry of `ft3-policies`: strict policy document parsers and the feature gate. */
export * from "./diagnostics.ts";
export * from "./leadSkills.ts";
export * from "./policyChangeTracker.ts";
export * from "./policyDocumentLoader.ts";
export * from "./roleDocuments.ts";
export {
  DEFAULT_DELEGATED_ROLE,
  RoleResolutionError,
  RoleResolver,
  findAppliedRole,
  layer as roleResolverLayer,
  roleInstructionLine,
} from "./roleResolver.ts";
export type { ResolvedRole, RoleAssignment } from "./roleResolver.ts";
export { FeatureDisabledError, FeatureGate, layer } from "./FeatureGate.ts";
