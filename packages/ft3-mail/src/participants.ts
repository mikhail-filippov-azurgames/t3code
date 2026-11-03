/**
 * What a mail participant needs from delegation and documents: the launch
 * decision for a delegated role, and the `documents:write` facts of its member record.
 */
import { DelegationLaunchPolicy } from "@t3tools/ft3-delegation/server";
import { DEFAULT_DELEGATED_ROLE, FeatureGate } from "@t3tools/ft3-policies/server";
import type { DocsCaller } from "@t3tools/ft3-docs/server";
import { DocumentsWriteFactsPort } from "@t3tools/ft3-docs/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { MailRepository } from "./repository.ts";

/** With mail on, a delegated role must run as a mail participant; with mail off, delegation stays upstream. */
export const mailDelegationLaunchLayer: Layer.Layer<DelegationLaunchPolicy, never, FeatureGate> =
  Layer.effect(
    DelegationLaunchPolicy,
    Effect.gen(function* () {
      const gate = yield* FeatureGate;
      return DelegationLaunchPolicy.of({
        launchFor: Effect.fn("DelegationLaunchPolicy.mail")(function* (role: string | undefined) {
          if (!(yield* gate.isEffective("mail"))) return { _tag: "direct" } as const;
          return { _tag: "mail_required", role: role ?? DEFAULT_DELEGATED_ROLE } as const;
        }),
      });
    }),
  );

const NO_FACTS = { role: null, planStableId: null, granted: false } as const;

/** A participant writes documents only with the grant of its task, and the grant ends with the task. */
export const documentsWriteFactsLayer: Layer.Layer<DocumentsWriteFactsPort, never, MailRepository> =
  Layer.effect(
    DocumentsWriteFactsPort,
    Effect.gen(function* () {
      const repository = yield* MailRepository;
      return DocumentsWriteFactsPort.of({
        factsOf: Effect.fn("DocumentsWriteFactsPort.mail")(function* (caller: DocsCaller) {
          if (caller.threadId === null) return NO_FACTS;
          const participant = yield* repository
            .findParticipantByThread(caller.threadId)
            .pipe(Effect.orDie);
          if (participant === null) return NO_FACTS;
          return {
            role: participant.member.roleId,
            planStableId: null,
            granted: participant.member.documentsWrite && participant.taskStatus === "open",
          };
        }),
      });
    }),
  );
