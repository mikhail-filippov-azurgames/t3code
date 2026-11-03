import type { DocsCaller } from "@t3tools/ft3-docs/server";
import { DocumentsWriteFactsPort } from "@t3tools/ft3-docs/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { MailRepository } from "./repository.ts";

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
