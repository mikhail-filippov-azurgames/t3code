import { boardRpcs } from "@t3tools/ft3-board/rpc-contracts";
import { architectRpcs } from "@t3tools/ft3-architect/rpc-contracts";
import { piRpcs } from "@t3tools/ft3-pi/rpc-contracts";
import { ft3VcsRpcs } from "@t3tools/ft3-vcs/rpc-contracts";
import * as RpcGroup from "effect/rpc/RpcGroup";

import { openContextRpcs } from "./openContextRpc.ts";

export { FT3_OPENCONTEXT_WS_METHODS } from "./openContextRpc.ts";

export const group = RpcGroup.make(
  ...boardRpcs,
  ...architectRpcs,
  ...piRpcs,
  ...ft3VcsRpcs,
  ...openContextRpcs,
);
