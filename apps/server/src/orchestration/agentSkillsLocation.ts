import { fileURLToPath } from "node:url";

// Control-plane skills ship with the checkout. Harnesses do not always expose
// them in their own skill list, so briefs carry the directory instead.
const checkoutSkillsDirectory = fileURLToPath(
  new URL("../../../../.agents/skills", import.meta.url),
);

/** Skills directory that ships with this checkout, with forward slashes. */
export const AGENT_SKILLS_DIRECTORY = checkoutSkillsDirectory.replaceAll("\\", "/");

/** One sentence a brief can carry so an agent can open a skill without skill discovery. */
export const AGENT_SKILLS_HINT = `Skill files that drive this workflow live in ${AGENT_SKILLS_DIRECTORY}: read <skill>/SKILL.md directly when your harness does not list the skill.`;
