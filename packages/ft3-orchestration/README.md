# @t3tools/ft3-orchestration

Читает V2-проекции делегированных задач и хранит выжимки по завершённым ходам. Собственного
движка оркестрации и собственного журнала событий нет.

## Экспорты

- `./server` — MCP-toolkit (`task_list`, `task_search`, `task_read`,
  `task_summary_history`, `task_attach_handoff`);
- `./reactor` — `DelegatedTaskSummaryReactor`.

## Что внутри

- `TaskQueryService` — принадлежность задачи родителю, статус, transcript, handoff, выжимка;
- `TaskHandoffService` — прикрепление OCL-handoff с проверкой секретов;
- `DelegatedTaskSummaryRepository` — `ft3_delegated_task_summaries` и watermark;
- `DelegatedTaskSummaryReactor` — детерминированный fallback сразу, модель — через
  `TextGeneration.generateCommitMessage`;
- `src/contracts.ts` — схемы MCP-входов/выходов.

## Швы

MCP-регистрация — через `ft3-host`; чтение lineage и subagents — из V2
(`lineage.parentThreadId`, `relationshipToParent = "subagent"`, `origin = "app_owned"`).
Строки — в [fork-boundary.md](../../docs/internals/fork-boundary.md): «Серверная композиция
ft3», «Панель «Карточки/История» в чате», «Delegation secret boundary».

## Тесты

`pnpm run test`: MCP-сервис и права, reactor выжимок, повторная генерация, история.
