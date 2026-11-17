import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  claudePersonalRouteSettings,
  codexPersonalLaunchArgs,
  withClaudePersonalRoute,
} from "./personalRoute.ts";

const PERSONAL_ARG = '-c "model_provider=\\"openai\\""';

it.layer(NodeServices.layer)("Zavod personal route", (it) => {
  it.effect("adds the subscription provider only for a Zavod-routed ~/.codex", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "ft3-codex-route-" });
      const userDir = path.join(home, ".codex");
      const otherDir = path.join(home, "zavod-codex");
      yield* fileSystem.makeDirectory(userDir);
      yield* fileSystem.makeDirectory(otherDir);
      const route = (directory: string, config: string, launchArgs = "") =>
        fileSystem
          .writeFileString(path.join(directory, "config.toml"), config)
          .pipe(
            Effect.andThen(codexPersonalLaunchArgs(directory, launchArgs)),
            Effect.provideService(HostProcess.HomeDirectory, home),
          );
      const zavod =
        'model_provider = "zavod" # gateway\n\n[model_providers.zavod]\nbase_url = "x"\n';

      assert.strictEqual(yield* route(userDir, zavod), PERSONAL_ARG);
      assert.strictEqual(
        yield* route(userDir, zavod, " --enable hooks "),
        `${PERSONAL_ARG} --enable hooks`,
      );
      assert.strictEqual(
        yield* route(userDir, 'model = "gpt-5.4"\n[x]\nmodel_provider = "zavod"\n'),
        "",
      );
      assert.strictEqual(yield* route(userDir, "model_provider = 'openai'\n"), "");
      assert.strictEqual(yield* route(otherDir, zavod, "--enable hooks"), "--enable hooks");
    }),
  );

  it.effect("neutralizes only a Zavod key helper in the personal ~/.claude settings", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "ft3-claude-route-" });
      const userDir = path.join(home, ".claude");
      const otherDir = path.join(home, "zavod");
      yield* fileSystem.makeDirectory(userDir);
      yield* fileSystem.makeDirectory(otherDir);
      const route = (settings: unknown, directory = userDir) =>
        fileSystem
          .writeFileString(path.join(directory, "settings.json"), JSON.stringify(settings))
          .pipe(
            Effect.andThen(claudePersonalRouteSettings(directory)),
            Effect.provideService(HostProcess.HomeDirectory, home),
          );
      const gatewayEnv = { ANTHROPIC_BASE_URL: "https://gateway.example.test" };

      assert.deepStrictEqual(
        yield* route({ env: gatewayEnv, apiKeyHelper: "/home/me/.zavod/bin/zavod-key" }),
        { apiKeyHelper: "", env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com" } },
      );
      assert.deepStrictEqual(
        yield* route({ apiKeyHelper: '"C:\\Users\\me\\.zavod\\bin\\zavod-key.exe"' }),
        { apiKeyHelper: "" },
      );
      assert.isUndefined(yield* route({ env: gatewayEnv, apiKeyHelper: "/opt/bin/my-key" }));
      assert.isUndefined(yield* route({ env: gatewayEnv }));
      assert.isUndefined(yield* route({ apiKeyHelper: "zavod-key" }, otherDir));
    }),
  );

  it("merges the route over existing flag settings", () => {
    const route = {
      apiKeyHelper: "",
      env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com" },
    } as const;
    const flagSettings: { readonly env: Record<string, string> } = { env: { KEEP: "1" } };
    assert.deepStrictEqual<unknown>(
      withClaudePersonalRoute({ ...flagSettings, disableAllHooks: true }, route),
      {
        disableAllHooks: true,
        apiKeyHelper: "",
        env: { KEEP: "1", ANTHROPIC_BASE_URL: "https://api.anthropic.com" },
      },
    );
    assert.deepStrictEqual(withClaudePersonalRoute(undefined, { apiKeyHelper: "" }), {
      apiKeyHelper: "",
    });
    assert.isUndefined(withClaudePersonalRoute(undefined, undefined));
  });
});
