import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

/** A failed mail read: the caller must not treat the card as free of mail work. */
export class BoardMailFactsError extends Schema.TaggedError<BoardMailFactsError>()(
  "BoardMailFactsError",
  {
    cardId: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/**
 * The board's narrow view of mail state (design §8). Board code reads mail
 * only through this port, which the mail package implements. A failed read is
 * an error, not an empty answer; without mail the port reports no activity.
 */
export class BoardMailFacts extends Context.Service<
  BoardMailFacts,
  {
    /**
     * Card ids with an implement letter on their mail task, bounded by the
     * selected cards. Empty when mail is absent.
     */
    readonly hasImplementLetter: (
      cardIds: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlySet<string>>;
    /**
     * Whether the card has a non-closed task with an open mail round or a
     * non-terminal delivery. False when mail is absent.
     */
    readonly hasOpenMailWork: (cardId: string) => Effect.Effect<boolean, BoardMailFactsError>;
  }
>()("@t3tools/ft3-board/boardMailFacts") {}

/** No mail in this composition: no implement letters, no open work. */
export const noBoardMailFactsLayer: Layer.Layer<BoardMailFacts> = Layer.succeed(
  BoardMailFacts,
  BoardMailFacts.of({
    hasImplementLetter: Effect.fn("BoardMailFacts.hasImplementLetter")(() =>
      Effect.succeed(new Set<string>()),
    ),
    hasOpenMailWork: Effect.fn("BoardMailFacts.hasOpenMailWork")(() => Effect.succeed(false)),
  }),
);
