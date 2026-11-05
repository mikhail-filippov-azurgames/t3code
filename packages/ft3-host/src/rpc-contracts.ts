import { boardRpcs } from "@t3tools/ft3-board/rpc-contracts";
import { docsRpcs } from "@t3tools/ft3-docs/rpc-contracts";
import { mailRpcs } from "@t3tools/ft3-mail/rpc-contracts";
import { piRpcs } from "@t3tools/ft3-pi/rpc-contracts";
import { policiesRpcs } from "@t3tools/ft3-policies/rpc-contracts";
import { ft3VcsRpcs } from "@t3tools/ft3-vcs/rpc-contracts";
import * as RpcGroup from "effect/rpc/RpcGroup";

export { FT3_DOCS_WS_METHODS } from "@t3tools/ft3-docs/rpc-contracts";
export { FT3_MAIL_WS_METHODS } from "@t3tools/ft3-mail/rpc-contracts";

export const group = RpcGroup.make(
  ...boardRpcs,
  ...piRpcs,
  ...ft3VcsRpcs,
  ...docsRpcs,
  ...policiesRpcs,
  ...mailRpcs,
);
