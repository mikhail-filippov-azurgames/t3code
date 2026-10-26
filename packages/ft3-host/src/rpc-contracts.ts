import { boardRpcs } from "@t3tools/ft3-board/rpc-contracts";
import { architectRpcs } from "@t3tools/ft3-architect/rpc-contracts";
import * as RpcGroup from "effect/rpc/RpcGroup";

export const group = RpcGroup.make(...boardRpcs, ...architectRpcs);
