import * as NodeURL from "node:url";

const skillFile = NodeURL.fileURLToPath(
  new URL("../skills/create-orchestrator-architect/SKILL.md", import.meta.url),
);

// Control-plane skill shipped with the package; absolute so any project's agent can open it.
export const ARCHITECT_SKILL_PATH = skillFile.replaceAll("\\", "/");
