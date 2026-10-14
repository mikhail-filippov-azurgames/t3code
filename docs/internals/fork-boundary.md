# Fork boundary

> For maintainers. This repository is a fork of an upstream project tracked as the `upstream` remote.

The fork keeps its divergence at the module boundary. New behavior lives in its own modules —
toolkits, reactors, adapters, and separate packages where needed — while upstream files receive only
the wiring that connects them. Keeping changes in owned modules is what lets an upstream sync stay a
merge instead of a rewrite.

Before syncing with upstream and during review of the delta, regenerate the inventory with
`pnpm fork:inventory` (or `node scripts/fork-inventory.ts [baseRef]`, default `upstream/main`). The
script reports the merge base, ahead/behind counts, modified upstream files ordered by churn, added
files grouped by directory, and any deletions or renames. Do not maintain a static catalog of those
files in docs; the working tree is the source and the command reproduces it.

One deliberate exception to the no-barrel rule: [packages/contracts/src/index.ts](../../packages/contracts/src/index.ts)
is a root barrel of `export *` statements and the package's public API, with roughly 1,850 imports
across about 1,750 files. It is intentionally unlike the subpath-only, no-barrel `packages/shared`;
do not collapse it for consistency.
