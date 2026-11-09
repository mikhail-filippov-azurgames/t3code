/**
 * The letter-kind classifier port (design §9.4, §8). Only participant letters
 * to the lead are classified; the sender kind is always kept on the letter.
 * Until a Hugging Face model is chosen the port is a no-op returning `null`,
 * and the sender kind stays authoritative with no feedback recorded.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { MailLetter, MailLetterKind } from "./contracts.ts";

export interface MailClassifyInput {
  readonly taskId: string;
  readonly kind: MailLetterKind;
  readonly body: string;
  readonly senderRoleId: string;
}

export interface MailClassification {
  readonly kind: MailLetterKind;
  readonly confidence: number;
  readonly version: string;
}

export class MailKindClassifier extends Context.Service<
  MailKindClassifier,
  {
    /** `null` while no classifier model is chosen: the sender kind is authoritative. */
    readonly classify: (
      input: MailClassifyInput,
    ) => Effect.Effect<MailClassification | null, never, never>;
  }
>()("@t3tools/ft3-mail/classifier/MailKindClassifier") {}

/** The no-op classifier: every letter keeps its sender kind and no feedback is written. */
export const layerNoopClassifier: Layer.Layer<MailKindClassifier> = Layer.succeed(
  MailKindClassifier,
  MailKindClassifier.of({
    classify: (_input: MailClassifyInput) => Effect.succeed(null),
  }),
);

/**
 * The kind server transitions (rounds, approve/changes) use: the lead decision
 * wins, then the classifier when its confidence reached the threshold at send
 * time, otherwise the sender kind. `kindDisputed` marks exactly the letters
 * whose classifier kind differs below the threshold.
 */
export const effectiveLetterKind = (letter: MailLetter): MailLetterKind =>
  letter.leadKind ?? (letter.kindDisputed ? letter.kind : (letter.classifierKind ?? letter.kind));

export interface ClassifiedLetter {
  readonly classifierKind: MailLetterKind | null;
  readonly classifierConfidence: number | null;
  readonly kindDisputed: boolean;
}

/** Applies the threshold to one classification; a no-op (`null`) keeps the sender kind. */
export const applyClassification = (
  senderKind: MailLetterKind,
  classification: MailClassification | null,
  threshold: number,
): ClassifiedLetter => {
  if (classification === null) {
    return { classifierKind: null, classifierConfidence: null, kindDisputed: false };
  }
  if (classification.confidence >= threshold) {
    return {
      classifierKind: classification.kind,
      classifierConfidence: classification.confidence,
      kindDisputed: false,
    };
  }
  return {
    classifierKind: classification.kind,
    classifierConfidence: classification.confidence,
    kindDisputed: classification.kind !== senderKind,
  };
};
