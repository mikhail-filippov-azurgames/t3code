import { BoardMailFacts, BoardMailFactsError } from "@t3tools/ft3-board/boardMailFacts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { MailRepository } from "./repository.ts";

/**
 * The board's mail facts over the mail repository: implement letters by card
 * and open mail work by card. The repository answers "no mail tables" as no
 * open work; a failed query surfaces as a BoardMailFactsError, so the board
 * never names a mail table.
 */
export const boardMailFactsLayer: Layer.Layer<BoardMailFacts, never, MailRepository> = Layer.effect(
  BoardMailFacts,
  Effect.gen(function* () {
    const mail = yield* MailRepository;
    return BoardMailFacts.of({
      hasImplementLetter: Effect.fn("BoardMailFacts.hasImplementLetter")((cardIds) =>
        mail.tasksWithImplementLetters(cardIds).pipe(Effect.orElseSucceed(() => new Set<string>())),
      ),
      hasOpenMailWork: Effect.fn("BoardMailFacts.hasOpenMailWork")((cardId) =>
        mail
          .hasOpenMailWork(cardId)
          .pipe(Effect.mapError((cause) => new BoardMailFactsError({ cardId, cause }))),
      ),
    });
  }),
);
