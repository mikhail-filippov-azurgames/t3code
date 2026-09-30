import * as NodeModule from "node:module";
import * as NodeURL from "node:url";

// Classic compiler API for parsing the pinned Pi bundle. The catalog
// `typescript` is the native v7 port without `createSourceFile`; the legacy
// v6 package (a declared devDependency here) keeps the parser.
import * as TypeScript from "typescript-legacy";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import serverPackageJson from "../../apps/server/package.json" with { type: "json" };

import {
  CLI_RUNTIME_EXTERNAL_PREFIXES,
  findEsmImportsOfExternalPackages,
  findInlinedExternalPackages,
  selectCliRuntimeExternalDependencies,
  shouldBundleCliDependency,
} from "./cli-external-packages.ts";

// Only the field this test cares about; decoding ignores everything else.
// optionalDependencies matter as much as dependencies here: every native family
// in the list declares its actual platform bindings there (ffi-rs -> @yuuang/*,
// msgpackr-extract -> @msgpackr-extract/*, fff-node -> @ff-labs/fff-bin-*), so
// reading only `dependencies` would check nothing for exactly those packages.
const PackageManifest = Schema.Struct({
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  optionalDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  peerDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
type PackageManifest = typeof PackageManifest.Type;

const decodeManifest = Schema.decodeUnknownSync(Schema.fromJsonString(PackageManifest));

describe("shouldBundleCliDependency", () => {
  it("bundles ordinary runtime dependencies", () => {
    for (const id of ["effect", "@effect/platform", "hono", "@t3tools/shared/hostProcess"]) {
      assert.strictEqual(shouldBundleCliDependency(id), true, id);
    }
  });

  it("never bundles node: builtins", () => {
    assert.strictEqual(shouldBundleCliDependency("node:fs"), false);
  });

  it("leaves native addons and their dlopen wrappers external", () => {
    for (const id of [
      "node-pty",
      "ffi-rs",
      "@yuuang/ffi-rs-win32-x64-msvc",
      "@ff-labs/fff-node",
      "@clerk/electron-passkeys",
      "msgpackr-extract",
      "@msgpackr-extract/msgpackr-extract-win32-x64",
    ]) {
      assert.strictEqual(shouldBundleCliDependency(id), false, id);
    }
  });

  // The real package is `node-gyp-build-optional-packages`, reached by prefix.
  // It is transitive to a selected dependency root, so the runtime closure test
  // below ensures it follows that root into the sidecar.
  it("treats prefix-matched siblings as external", () => {
    assert.strictEqual(shouldBundleCliDependency("node-gyp-build-optional-packages"), false);
  });
});

describe("selectCliRuntimeExternalDependencies", () => {
  it("keeps only runtime-external dependency roots for the Windows sidecar", () => {
    assert.deepStrictEqual(
      selectCliRuntimeExternalDependencies({
        "@ff-labs/fff-node": "2.0.0",
        effect: "3.0.0",
        "node-pty": "4.0.0",
      }),
      {
        "@ff-labs/fff-node": "2.0.0",
        "node-pty": "4.0.0",
      },
    );
  });

  it("selects every external root declared by the server", () => {
    assert.deepStrictEqual(
      Object.keys(selectCliRuntimeExternalDependencies(serverPackageJson.dependencies)).sort(),
      ["@earendil-works/pi-coding-agent", "@ff-labs/fff-node", "msgpackr-extract", "node-pty"],
    );
  });

  // The pinned Pi harness must travel in the Windows server sidecar: the
  // packaged app has no dev-time node_modules, and `resolvePiRuntime`'s
  // bundled-kind lookup walks up to the sidecar's node_modules. The sidecar's
  // `vp install --prod` installs the selected root plus its full transitive
  // closure, so selecting the root is the whole proof — no other wiring.
  it("selects the bundled Pi harness root for the Windows sidecar", () => {
    assert.deepStrictEqual(
      selectCliRuntimeExternalDependencies({
        "@earendil-works/pi-coding-agent": "0.87.1",
        effect: "3.0.0",
      }),
      { "@earendil-works/pi-coding-agent": "0.87.1" },
    );
    assert.ok(
      (
        (serverPackageJson.dependencies as Record<string, string>)[
          "@earendil-works/pi-coding-agent"
        ] ?? ""
      ).trim().length > 0,
      "the Pi harness must stay a declared server dependency so the pin is exact",
    );
  });
});

// An external package is loaded from the real filesystem, so its own `require`
// also resolves from the real filesystem. If one of its dependencies was
// bundled away instead of left external, that dependency does not follow the
// selected root into the sidecar.
//
// Found the hard way: node-gyp-build-optional-packages requires detect-libc,
// which was bundled. Windows was fine; WSL got MODULE_NOT_FOUND.
it.layer(NodeServices.layer)("external package dependency closure", (it) => {
  // Read manifests off disk from the pnpm store rather than resolving them.
  // `require("<name>/package.json")` cannot do this job: under pnpm isolation a
  // transitive package (detect-libc, msgpackr-extract, ffi-rs) is not reachable
  // by name from this file at all, and an `exports` map can refuse the
  // `/package.json` subpath outright (@ff-labs/fff-node). Both surface as "not
  // installed", which would let this test skip everything and pass while
  // checking nothing. The store contains the dependency graph the sidecar's
  // minimal production install resolves.
  const readInstalledPackages = Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const storeDir = path.resolve(
      path.dirname(NodeURL.fileURLToPath(import.meta.url)),
      "../../node_modules/.pnpm",
    );

    // The store holds regular files too (lock.yaml), so a path built under one
    // raises ENOTDIR rather than reporting absence. That throws on Linux while
    // Windows quietly returns false, which is exactly the kind of difference
    // this test exists to catch, so treat any failure as "not there".
    const isPresent = (candidate: string) =>
      fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false));

    const installed = new Map<string, PackageManifest>();
    if (!(yield* isPresent(storeDir))) return installed;

    for (const entry of yield* fileSystem.readDirectory(storeDir)) {
      const modulesDir = path.join(storeDir, entry, "node_modules");
      if (!(yield* isPresent(modulesDir))) continue;

      for (const owner of yield* fileSystem.readDirectory(modulesDir)) {
        const names = owner.startsWith("@")
          ? (yield* fileSystem.readDirectory(path.join(modulesDir, owner))).map(
              (scoped) => `${owner}/${scoped}`,
            )
          : [owner];

        for (const name of names) {
          if (installed.has(name)) continue;
          const manifestPath = path.join(modulesDir, name, "package.json");
          if (!(yield* isPresent(manifestPath))) continue;
          installed.set(name, decodeManifest(yield* fileSystem.readFileString(manifestPath)));
        }
      }
    }
    return installed;
  }).pipe(Effect.cached, Effect.runSync);

  // Runtime-external only. The build-only entries resolve `bun:*` and are never
  // loaded by Node, so their closure genuinely does not need to be external.
  const isRuntimeExternal = (name: string) =>
    CLI_RUNTIME_EXTERNAL_PREFIXES.some((prefix) => name.startsWith(prefix));

  // A cold walk of the pnpm store can exceed the root timeout when the Windows
  // lane runs four filesystem-heavy workspace suites at once.
  it.effect(
    "finds the runtime-external packages on disk",
    () =>
      Effect.gen(function* () {
        const installed = yield* readInstalledPackages;
        const found = [...installed.keys()].filter(isRuntimeExternal);

        // Without this the closure check below can pass vacuously: if nothing is
        // read, nothing is checked. These are the packages whose closure actually
        // broke WSL, so require them by name — plus the Pi harness, whose
        // presence in the store is what lets the sidecar install carry it.
        for (const required of [
          "node-pty",
          "node-gyp-build-optional-packages",
          "detect-libc",
          "@earendil-works/pi-coding-agent",
        ]) {
          assert.ok(
            found.includes(required),
            `expected ${required} in the pnpm store; the closure check is only meaningful if it can read these (found ${found.length})`,
          );
        }
      }),
    120_000,
  );

  // The Pi harness root is exempt from the manifest walk below, and the
  // exemption is load-bearing, not a weakening: Pi ships a self-contained
  // dist bundle (see the `pi dist bundle is self-contained` test), so its
  // manifest dependencies are build-time inputs that Pi's own bundler
  // inlined — requiring them external would force shared packages like
  // `yaml` out of the server bundle and break the single-executable. The
  // spawned CLI resolves its real runtime requires (Node built-ins plus
  // guarded optionals) from the sidecar, where `vp install --prod` carries
  // the selected root's full transitive closure.
  const isExemptSelfContainedCli = (name: string) => name === "@earendil-works/pi-coding-agent";

  it.effect("keeps every runtime dependency of an external package external too", () =>
    Effect.gen(function* () {
      const installed = yield* readInstalledPackages;
      const violations: string[] = [];
      const seen = new Set<string>();
      // Seeded from what is actually installed and matches a prefix, so scoped
      // prefixes like "@yuuang/" and "@ff-labs/" are covered too. Seeding from
      // the prefix strings themselves would skip every scoped entry, since a
      // prefix is not a package name.
      const queue = [...installed.keys()].filter(isRuntimeExternal);

      for (const name of queue) {
        if (seen.has(name)) continue;
        seen.add(name);

        const manifest = installed.get(name);
        if (!manifest) continue;

        const declared = {
          ...manifest.dependencies,
          ...manifest.optionalDependencies,
          ...manifest.peerDependencies,
        };
        if (isExemptSelfContainedCli(name)) continue;
        for (const dependency of Object.keys(declared)) {
          if (!isRuntimeExternal(dependency)) {
            violations.push(`${name} -> ${dependency}`);
          }
          if (!seen.has(dependency)) queue.push(dependency);
        }
      }

      assert.deepStrictEqual(
        violations,
        [],
        `these dependencies of external packages would be bundled away and fail to resolve under WSL: ${violations.join(", ")}`,
      );
    }),
  );

  // Machine-checked premise of the Pi exemption above. The spawned Pi CLI
  // must resolve its real runtime requires from the sidecar without the
  // manifest-walk closure: its dist bundle is self-contained apart from
  // Node built-ins and guarded optional probes (`bufferutil` /
  // `utf-8-validate` are ws accelerators wrapped in try/catch and already
  // external; `supports-color` is a guarded `debug`-package probe). A text
  // regex is not enough here — the `@aws-sdk/*` names occur as
  // `require('...')` text inside Bedrock error-message string literals —
  // so the scan parses each file and collects only real `require` /
  // `__require` call arguments. If a future Pi pin hard-requires a new
  // file-backed package, this fails and the exemption must be revisited.
  it.effect("pi dist bundle is self-contained (exemption premise)", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const bundleDir = path.resolve(
        path.dirname(NodeURL.fileURLToPath(import.meta.url)),
        "../../apps/server/node_modules/@earendil-works/pi-coding-agent/dist/bundle",
      );
      const cliJs = path.join(bundleDir, "cli.js");
      assert.ok(
        yield* fileSystem.exists(cliJs).pipe(Effect.orElseSucceed(() => false)),
        `expected the pinned Pi CLI at ${cliJs}; run the install step that provides apps/server/node_modules first`,
      );
      const chunksDir = path.join(bundleDir, "chunks");
      const entries = [
        "cli.js",
        ...(yield* fileSystem.readDirectory(chunksDir)).map((entry) => `chunks/${entry}`),
      ];
      const specifiers = new Set<string>();
      for (const entry of entries) {
        if (!entry.endsWith(".js")) continue;
        const source = yield* fileSystem.readFileString(path.join(bundleDir, entry));
        const script = TypeScript.createSourceFile(
          entry,
          source,
          TypeScript.ScriptTarget.Latest,
          false,
        );
        const visit = (node: TypeScript.Node): void => {
          if (TypeScript.isCallExpression(node)) {
            const callee = node.expression.getText(script);
            const firstArgument = node.arguments[0];
            if (
              (callee === "require" || callee === "__require") &&
              firstArgument !== undefined &&
              TypeScript.isStringLiteralLike(firstArgument)
            ) {
              const specifier = firstArgument.text;
              if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
                specifiers.add(specifier);
              }
            }
          }
          TypeScript.forEachChild(node, visit);
        };
        visit(script);
      }
      assert.ok(
        specifiers.size > 0,
        "the require scan saw nothing; the bundle shape changed and this proof is blind",
      );
      const allowedOptionals = new Set(["bufferutil", "utf-8-validate", "supports-color"]);
      const unexpected = [...specifiers]
        .filter((specifier) => !NodeModule.isBuiltin(specifier))
        .filter((specifier) => !allowedOptionals.has(specifier))
        .sort();
      assert.deepStrictEqual(
        unexpected,
        [],
        `Pi dist requires file-backed packages outside the sidecar story: ${unexpected.join(", ")}`,
      );
    }),
  );
});

// Configuring the bundler is not the same as checking what it emitted. These
// exercise the scanner against the marker shape rolldown actually produces.
describe("findInlinedExternalPackages", () => {
  const region = (path: string) => `//#region ${path}
var x = 1;
//#endregion
`;

  it("flags an external package that was inlined", () => {
    const source =
      region("../../node_modules/.pnpm/detect-libc@2.1.2/node_modules/detect-libc/lib/process.js") +
      region(
        "../../node_modules/.pnpm/msgpackr-extract@3.0.4/node_modules/msgpackr-extract/index.js",
      );
    const result = findInlinedExternalPackages(source);

    assert.deepStrictEqual(result.inlined, ["detect-libc", "msgpackr-extract"]);
    assert.strictEqual(result.regionCount, 2);
  });

  it("flags scoped external packages", () => {
    const result = findInlinedExternalPackages(
      region("../../node_modules/@ff-labs/fff-node/dist/src/index.js"),
    );
    assert.deepStrictEqual(result.inlined, ["@ff-labs/fff-node"]);
  });

  it("ignores packages that are meant to be bundled", () => {
    const source =
      region("../../node_modules/.pnpm/effect@4.0.0/node_modules/effect/dist/index.js") +
      region("../../src/server/main.ts");
    const result = findInlinedExternalPackages(source);

    assert.deepStrictEqual(result.inlined, []);
    assert.strictEqual(result.regionCount, 2);
  });

  // regionCount is what separates "clean" from "this scan went blind because the
  // marker format changed". A caller that ignores it gets a vacuous pass.
  // The scan has to answer both directions. Checking only that externals are
  // absent still passes on a bundle that externalized everything, which is the
  // failure this whole change prevents.
  it("reports the packages that were inlined, not just the violations", () => {
    const source =
      region("../../node_modules/.pnpm/effect@4.0.0/node_modules/effect/dist/index.js") +
      region("../../node_modules/.pnpm/yaml@2.4.0/node_modules/yaml/dist/index.js") +
      region("../../src/server/main.ts");
    const result = findInlinedExternalPackages(source);

    assert.deepStrictEqual(result.inlinedPackages, ["effect", "yaml"]);
    assert.deepStrictEqual(result.inlined, []);
  });

  it("does not report the pnpm store directory as a package", () => {
    const result = findInlinedExternalPackages(
      region("../../node_modules/.pnpm/effect@4.0.0/node_modules/effect/dist/index.js"),
    );
    assert.deepStrictEqual(result.inlinedPackages, ["effect"]);
  });

  it("reports no regions when the marker format is absent", () => {
    const result = findInlinedExternalPackages("var x = 1; // node_modules/detect-libc/lib.js");
    assert.strictEqual(result.regionCount, 0);
    assert.deepStrictEqual(result.inlined, []);
  });
});

// The single-executable build can only `import` built-ins. A file-backed
// import of an external package passes every bundler check and the regular
// `node dist/bin.mjs` path, then fails inside the executable, so the scan
// reads the emitted module graph instead.
describe("findEsmImportsOfExternalPackages", () => {
  it("flags static and dynamic imports of file-backed packages", () => {
    const source = [
      'import { FileFinder } from "@ff-labs/fff-node";',
      'import * as fs from "fs";',
      'import { createRequire } from "node:module";',
      'const pty = () => import("node-pty");',
      'const data = () => import("@ff-labs/fff-bin-linux-x64-gnu", { with: { type: "json" } });',
      'const lazy = () => import(/* @vite-ignore */ "ffi-rs");',
      'const local = () => import("./chunk-abc.mjs");',
    ].join("\n");

    assert.deepStrictEqual(findEsmImportsOfExternalPackages(source), [
      "@ff-labs/fff-bin-linux-x64-gnu",
      "@ff-labs/fff-node",
      "ffi-rs",
      "node-pty",
    ]);
  });

  it("flags side-effect imports and re-exports too", () => {
    const source = ['import "msgpackr-extract";', 'export { load } from "ffi-rs";'].join("\n");
    assert.deepStrictEqual(findEsmImportsOfExternalPackages(source), [
      "ffi-rs",
      "msgpackr-extract",
    ]);
  });

  it("does not mistake createRequire calls for imports", () => {
    const source = 'const { FileFinder } = createRequire(import.meta.url)("@ff-labs/fff-node");';
    assert.deepStrictEqual(findEsmImportsOfExternalPackages(source), []);
  });
});
