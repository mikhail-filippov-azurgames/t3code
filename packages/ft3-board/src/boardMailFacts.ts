import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * The board's narrow view of mail state (design §8). Board code reads mail
 * only through this port, which the mail package implements; the port is
 * infallible, so without mail it reports no activity.
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
     * Whether the card's open task has an open mail round or a live delivery
     * (sent but not answered). False when mail is absent.
     */
    readonly hasOpenMailWork: (cardId: string) => Effect.Effect<boolean>;
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
