import * as Layer from "effect/Layer";

import * as BoardRetentionReactor from "./BoardRetentionReactor.ts";
import * as CoordinatorBoardNudgeReactor from "./CoordinatorBoardNudgeReactor.ts";
import * as DeletedThreadPurge from "./DeletedThreadPurge.ts";

export const layerWorker = () =>
  Layer.mergeAll(
    DeletedThreadPurge.layerWorker(),
    BoardRetentionReactor.layerWorker(),
    CoordinatorBoardNudgeReactor.layerWorker(),
  );
