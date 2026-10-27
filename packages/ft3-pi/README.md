# @t3tools/ft3-pi

Обёртка upstream Pi-драйвера: управляемый agent-dir, встроенный runtime, локальный
llama-server, профили инференса, Bonsai preset и запрет координаторских прав для
executor-only инстансов.

## Экспорты

- `./server` — `Ft3PiDriver`, менеджер llama-server,
  `derivePiInferenceConfigFromLegacySettings`, импорт Codex-resources;
- `./policy` — `isExecutorOnlyProviderInstance`;
- `./rpc-contracts`, `./rpc` — `pi.inferenceServer.*`, `pi.inferenceProfile.*`,
  `pi.bonsaiPreset.*`.

## Что внутри

- `agentDir.ts` — `models.json`, `settings.json`, `PI_CODING_AGENT_DIR`, пиннинг tools;
- `piRuntime.ts` — sentinel `binaryPath` → `@earendil-works/pi-coding-agent`, launcher;
- `inferenceServer.ts` — профили, `/health`, `/v1/models`, один процесс на endpoint;
- `localLlamaExtension.ts` — политика `ft3-local` без MCP-инструментов;
- `executorOnly.ts` — список `T3CODE_FT3_EXECUTOR_ONLY_INSTANCES`; `skills.ts` — импорт Codex-skills в agent-dir.

## Швы

`builtInDrivers.ts`, `ProviderSessionManager.ts`, `McpSessionRegistry.ts`,
`provider-pi/mcpExtensionSource.ts` и `mcpInjection.ts`, composer-слот в `ChatComposer.tsx`,
настройки Pi в `ProviderSettingsPanel.tsx`. Строки — в
[fork-boundary.md](../../docs/internals/fork-boundary.md): разделы Pi.

Тесты: `pnpm run test` — agent-dir, runtime, inference, control, policy, local llama, skills.
