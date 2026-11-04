// @effect-diagnostics nodeBuiltinImport:off - pure path joining; the Effect Path service needs an Effect context.
import * as NodePath from "node:path";

import type { ContextTierRates, ModelRate, RateTable, TokenRates } from "./usagePricing.ts";

// OpenCode CLI's models.dev cache; read from disk, never fetched at runtime.
const OPENCODE_MODELS_FILE = NodePath.join("opencode", "models.json");

/** Ordered locations for the OpenCode model catalog on this host; the first existing file wins. */
export function openCodeCatalogCandidates(
  environment: NodeJS.ProcessEnv,
  homeDirectory: string,
  platform: NodeJS.Platform,
): string[] {
  const candidates: string[] = [];
  const cacheHome = environment["XDG_CACHE_HOME"]?.trim();
  if (cacheHome !== undefined && cacheHome.length > 0 && NodePath.isAbsolute(cacheHome)) {
    candidates.push(NodePath.join(cacheHome, OPENCODE_MODELS_FILE));
  }
  candidates.push(NodePath.join(homeDirectory, ".cache", OPENCODE_MODELS_FILE));
  if (platform === "win32") {
    const localAppData = environment["LOCALAPPDATA"]?.trim();
    if (localAppData !== undefined && localAppData.length > 0) {
      candidates.push(NodePath.join(localAppData, OPENCODE_MODELS_FILE));
    }
  }
  return candidates;
}

interface OpenCodeCost extends Readonly<Record<string, unknown>> {
  readonly input?: unknown;
  readonly output?: unknown;
  readonly cache_read?: unknown;
  readonly cache_write?: unknown;
  readonly tiers?: unknown;
  readonly context_over_200k?: unknown;
}

const PER_MILLION = 1_000_000;

function costPerToken(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value / PER_MILLION : null;
}

// Missing cache rates bill at the input rate, matching OpenCode's billing for uncached writes.
function openCodeTokenRates(cost: OpenCodeCost, tier: OpenCodeCost = {}): TokenRates | null {
  const input = costPerToken(tier.input ?? cost.input);
  const output = costPerToken(tier.output ?? cost.output);
  if (input === null || output === null) return null;
  return {
    inputCostPerToken: input,
    outputCostPerToken: output,
    cacheReadCostPerToken: costPerToken(tier.cache_read ?? cost.cache_read) ?? input,
    cacheCreationCostPerToken: costPerToken(tier.cache_write ?? cost.cache_write) ?? input,
  };
}

function contextTiers(cost: OpenCodeCost): ContextTierRates[] {
  const tiers = new Map<number, TokenRates>();
  const legacy = cost["context_over_200k"];
  // The legacy 200k field is a fallback; explicit tiers carry their own thresholds.
  if (!Array.isArray(cost.tiers) && typeof legacy === "object" && legacy !== null) {
    const rates = openCodeTokenRates(legacy as OpenCodeCost);
    if (rates !== null) tiers.set(200_000, rates);
  }
  if (Array.isArray(cost.tiers)) {
    for (const raw of cost.tiers) {
      if (typeof raw !== "object" || raw === null) continue;
      const entry = raw as Readonly<Record<string, unknown>>;
      const tier = entry["tier"];
      if (typeof tier !== "object" || tier === null) continue;
      const { type, size } = tier as Readonly<Record<string, unknown>>;
      if (type !== "context" || typeof size !== "number" || !Number.isFinite(size)) continue;
      const rates = openCodeTokenRates(cost, entry as OpenCodeCost);
      if (rates !== null) tiers.set(size, rates);
    }
  }
  return [...tiers.entries()]
    .map(([aboveTokens, rates]) => ({ aboveTokens, rates }))
    .sort((a, b) => b.aboveTokens - a.aboveTokens);
}

const normalizeKey = (value: string) => value.trim().toLowerCase();

/**
 * Builds a rate table from OpenCode's models.dev cache. Keys are `provider/model`; models on the
 * `opencode` (zen) provider also register their bare model ID, since that is what OpenCode bills.
 * Models without a cost entry are omitted, leaving them unpriced rather than priced at $0.
 */
export function parseOpenCodeCatalog(document: unknown): RateTable {
  const table = new Map<string, ModelRate>();
  if (typeof document !== "object" || document === null) return table;
  for (const provider of Object.values(document as Record<string, unknown>)) {
    if (typeof provider !== "object" || provider === null) continue;
    const providerId = (provider as Readonly<Record<string, unknown>>)["id"];
    const models = (provider as Readonly<Record<string, unknown>>)["models"];
    if (typeof providerId !== "string" || typeof models !== "object" || models === null) continue;
    const zenProvider = normalizeKey(providerId) === "opencode";
    for (const [modelId, raw] of Object.entries(models as Record<string, unknown>)) {
      if (typeof raw !== "object" || raw === null) continue;
      const cost = (raw as Readonly<Record<string, unknown>>)["cost"];
      if (typeof cost !== "object" || cost === null) continue;
      const standard = openCodeTokenRates(cost as OpenCodeCost);
      if (standard === null) continue;
      const tiers = contextTiers(cost as OpenCodeCost);
      const rate: ModelRate = {
        ...standard,
        fast: null,
        ultrafast: null,
        ...(tiers.length === 0 ? {} : { contextTiers: tiers }),
      };
      const key = normalizeKey(modelId);
      table.set(`${normalizeKey(providerId)}/${key}`, rate);
      if (zenProvider) table.set(key, rate);
    }
  }
  return table;
}
