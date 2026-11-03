/**
 * Role resolution over the applied `roles` document: the lead's name, a Corvis
 * role id and an upstream role resolve to one applied instruction, so an edited
 * role file reaches a child only after it is applied. With no applied, configured
 * document the resolver reports roles off, the upstream behavior.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { PolicyChangeTracker } from "./policyChangeTracker.ts";
import {
  type CorvisRoleId,
  type ParsedRoleEntry,
  type ParsedRolesDocument,
  UPSTREAM_DELEGATED_ROLES,
  type UpstreamDelegatedRole,
} from "./roleDocuments.ts";

/** The role a delegated child gets when the caller names none and roles are on. */
export const DEFAULT_DELEGATED_ROLE = "general";

/** One role id keeps its historical alias: `architecture` names `architect`. */
const ROLE_ID_ALIASES: Readonly<Record<string, CorvisRoleId>> = { architecture: "architect" };

/** A specialization resolves to its base role when the manifest declares no entry of its own. */
const baseRoleName = (role: string): string | null =>
  role.startsWith("review-") ? "review" : role.startsWith("architect-") ? "architect" : null;

export interface ResolvedRole {
  /** The name the lead writes; unique in the manifest. */
  readonly id: string;
  readonly roleId: CorvisRoleId;
  readonly upstreamRole: UpstreamDelegatedRole | null;
  /** Applied manifest revision the role came from. */
  readonly revision: number;
  /** Body of the applied role file. */
  readonly instruction: string;
}

export class RoleResolutionError extends Schema.TaggedError<RoleResolutionError>()(
  "RoleResolutionError",
  {
    code: Schema.Literal("unknown_role"),
    role: Schema.String,
    /** Role names the applied document declares, sorted. */
    available: Schema.Array(Schema.String),
    rolesConfigured: Schema.Boolean,
  },
) {
  override get message(): string {
    return this.rolesConfigured
      ? `Role "${this.role}" has no entry in the applied roles document. Available roles: ${this.available.join(", ")}.`
      : `Role "${this.role}" needs a configured roles document. Without one the accepted roles are: ${UPSTREAM_DELEGATED_ROLES.join(", ")}.`;
  }
}

/** Mirrors the delegation call site: roles off, a resolved role, or a refusal. */
export type RoleAssignment =
  | { readonly _tag: "off"; readonly role: string | undefined }
  | { readonly _tag: "assigned"; readonly role: string; readonly resolved: ResolvedRole }
  | { readonly _tag: "rejected"; readonly message: string; readonly error: RoleResolutionError };

/** The child prompt line: the applied role instruction, not a path to read. */
export function roleInstructionLine(role: ResolvedRole): string {
  const body = role.instruction.trim();
  return body === ""
    ? `Your role is ${role.roleId}.`
    : `Your role is ${role.roleId}. Follow this role instruction before any work.\n\n${body}`;
}

const availableRoleNames = (document: ParsedRolesDocument): ReadonlyArray<string> =>
  document.roles.map((entry) => entry.id).sort();

const entryFor = (document: ParsedRolesDocument, role: string): ParsedRoleEntry | undefined => {
  const direct = document.roles.find(
    (entry) => entry.id === role || entry.roleId === role || entry.upstreamRole === role,
  );
  if (direct !== undefined) return direct;
  const alias = ROLE_ID_ALIASES[role];
  if (alias !== undefined) {
    const aliased = document.roles.find((entry) => entry.roleId === alias);
    if (aliased !== undefined) return aliased;
  }
  const base = baseRoleName(role);
  return base === null
    ? undefined
    : document.roles.find(
        (entry) => entry.id === base || entry.roleId === base || entry.upstreamRole === base,
      );
};

/** A declared role resolves once its file parsed; a missing or broken file does not. */
export function findAppliedRole(
  document: ParsedRolesDocument | null,
  role: string,
): ResolvedRole | null {
  if (document === null || !document.configured) return null;
  const entry = entryFor(document, role);
  if (entry === undefined) return null;
  const file = document.files.get(entry.file);
  if (file === undefined) return null;
  return {
    id: entry.id,
    roleId: entry.roleId,
    upstreamRole: entry.upstreamRole,
    revision: document.revision ?? 0,
    instruction: file.body,
  };
}

/**
 * The applied roles document of this runtime. The tracker is read from the
 * caller's context because applied policy state is not persisted yet, so a
 * runtime without one serves roles off instead of failing to build.
 */
const appliedRolesDocument: Effect.Effect<ParsedRolesDocument | null> = Effect.gen(function* () {
  const tracker = yield* Effect.serviceOption(PolicyChangeTracker);
  if (Option.isNone(tracker)) return null;
  const applied = yield* tracker.value.applied("roles");
  if (applied === null || applied.key !== "roles") return null;
  const document = applied.document;
  return document !== null && document.configured ? document : null;
});

const roleMethods = {
  configured: appliedRolesDocument.pipe(Effect.map((document) => document !== null)),
  resolve: Effect.fn("RoleResolver.resolve")(function* (role: string) {
    const document = yield* appliedRolesDocument;
    const resolved = findAppliedRole(document, role);
    if (resolved !== null) return resolved;
    return yield* new RoleResolutionError({
      code: "unknown_role",
      role,
      available: document === null ? [] : availableRoleNames(document),
      rolesConfigured: document !== null,
    });
  }),
  assignment: Effect.fn("RoleResolver.assignment")(function* (role: string | undefined) {
    const document = yield* appliedRolesDocument;
    if (document === null) {
      if (role === undefined || (UPSTREAM_DELEGATED_ROLES as readonly string[]).includes(role)) {
        return { _tag: "off", role } as const;
      }
      const error = new RoleResolutionError({
        code: "unknown_role",
        role,
        available: [],
        rolesConfigured: false,
      });
      return { _tag: "rejected", message: error.message, error } as const;
    }
    const requested = role ?? DEFAULT_DELEGATED_ROLE;
    const resolved = findAppliedRole(document, requested);
    if (resolved !== null) {
      return { _tag: "assigned", role: requested, resolved } as const;
    }
    const error = new RoleResolutionError({
      code: "unknown_role",
      role: requested,
      available: availableRoleNames(document),
      rolesConfigured: true,
    });
    return { _tag: "rejected", message: error.message, error } as const;
  }),
  // The lead's brief line; empty while roles are off or the lead role is unusable.
  leadLine: Effect.gen(function* () {
    const document = yield* appliedRolesDocument;
    const lead = findAppliedRole(document, "lead");
    return lead === null ? "" : roleInstructionLine(lead);
  }).pipe(Effect.withSpan("RoleResolver.leadLine")),
};

/** Serves roles from the applied `roles` document of `PolicyChangeTracker`. */
export class RoleResolver extends Context.Service<
  RoleResolver,
  {
    /** True while the applied roles document is configured; roles off otherwise. */
    readonly configured: Effect.Effect<boolean>;
    readonly resolve: (role: string) => Effect.Effect<ResolvedRole, RoleResolutionError>;
    readonly assignment: (role: string | undefined) => Effect.Effect<RoleAssignment>;
    readonly leadLine: Effect.Effect<string>;
  }
>()("@t3tools/ft3-policies/roleResolver") {}

export const layer: Layer.Layer<RoleResolver> = Layer.succeed(
  RoleResolver,
  RoleResolver.of(roleMethods),
);
