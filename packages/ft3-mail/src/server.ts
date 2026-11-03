/**
 * Server layers of mail: routing over the applied policies, the database and the
 * board card snapshot. The caller provides the database, crypto, settings and tracker.
 */
import { BoardCardId } from "@t3tools/ft3-board/contracts";
import { BoardRepository } from "@t3tools/ft3-board/repository";
import {
  normalServicePolicyLayer,
  routingPolicyServiceLayer,
  sqlPolicyUsageRecorderLayer,
} from "@t3tools/ft3-policies/routing";
import { layer as featureGateLayer, PolicyChangeTracker } from "@t3tools/ft3-policies/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { documentsWriteFactsLayer } from "./documentsWrite.ts";
import { layer as repositoryLayer } from "./repository.ts";
import { layer as serviceLayer, MailPolicyEvidence } from "./service.ts";

const policyEvidenceLayer = Layer.effect(
  MailPolicyEvidence,
  Effect.gen(function* () {
    const board = yield* BoardRepository;
    const tracker = yield* PolicyChangeTracker;
    return MailPolicyEvidence.of({
      snapshotJson: tracker.snapshot().pipe(Effect.map((snapshot) => JSON.stringify(snapshot))),
      recordCardSnapshot: Effect.fn("MailPolicyEvidence.recordCardSnapshot")(function* (input) {
        yield* board
          .setPolicySnapshot({
            cardId: BoardCardId.make(input.cardId),
            policySnapshotJson: input.snapshotJson,
          })
          .pipe(Effect.orDie);
      }),
    });
  }),
);

const routingLayer = routingPolicyServiceLayer().pipe(
  Layer.provide(Layer.mergeAll(normalServicePolicyLayer, sqlPolicyUsageRecorderLayer)),
);

export const layer = serviceLayer.pipe(
  Layer.provide(
    Layer.mergeAll(repositoryLayer, routingLayer, featureGateLayer, policyEvidenceLayer),
  ),
);

/** The `documents:write` facts of a mail member; the docs toolkit takes them as its write facts. */
export const documentsWriteFacts = documentsWriteFactsLayer.pipe(Layer.provide(repositoryLayer));
