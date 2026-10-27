# @t3tools/ft3-delegation

Политика делегирования без собственного состояния. Пакет отвечает на два вопроса: можно ли
передать текст/задачу дальше и какие права получает дочерний инстанс.

## Экспорт

- `./server` — `detectSecrets`, `applyAuthorTextPolicy`, `applyDerivedTextPolicy`,
  `projectDerivedText`, `delegationTextDecision`, `delegationPermissionDecision`,
  `delegationPermissionDenial`, `normalizeDelegationPermissionEnvelope`, `tokenizeLaunchArgs`.

`ft3-board/authorTextPolicy` ре-экспортирует ту же политику, чтобы доска и архитектор не
зависели от серверного пакета напрямую.

## Швы

Вызывается из `apps/server/src/mcp/OrchestratorMcpService.ts` (вход `delegate_task`,
follow-up, выжимки и чтение тредов) и
`apps/server/src/orchestration-v2/Orchestrator.ts` (текст wake). Строки — в
[fork-boundary.md](../../docs/internals/fork-boundary.md): «Delegation secret boundary (S)»
и «Delegation permission envelope (S)».

## Тесты

`pnpm run test`: сканер секретов, решение по тексту, проекция, конверт прав и launch-args.
