# @t3tools/ft3-vcs

Чтение git-истории для графа коммитов и чат-чипов. Использует тот же `VcsProcess`, что и
upstream `GitVcsDriver`, не копируя драйвер.

## Экспорты

- `./service` — `CommitHistoryService`: `listCommitHistory`, `listRefs`, `getCommitDiff`,
  `resolveCommitMentions`;
- `./contracts` — `VcsCommitHistory*`, `VcsRefsList*`, `VcsCommitDiff*`,
  `VcsResolveCommitMentions*`;
- `./rpc`, `./rpc-contracts` — методы `vcs.listCommitHistory`,
  `vcs.listRepositoryRefs`, `vcs.getCommitDiff`, `vcs.resolveCommitMentions`.

## Поведение

- `git log` с `--decorate=full` и `--format`/`-z`, исключение `refs/t3/checkpoints`;
- пагинация `--skip`/`-n`, локализация протухшего `offset` по `id`;
- дифф против первого родителя, для корневого коммита — `git diff-tree --root`;
- сокращения SHA резолвятся только при единственном совпадении префикса.

## Швы

Подключение — через `ft3-host` (RPC-группа и `serviceLayer`). Web-потребители —
`packages/ft3-web/src/commits` и `src/chat`. Строки — в
[fork-boundary.md](../../docs/internals/fork-boundary.md): «Граф коммитов (S2)», «Выбор
коммита в графе (S2b)», «Chat text chips and Typora».

Тесты: `pnpm run test` — парсер, пагинация, refs и дифф на временном репозитории, резолв
commit-упоминаний на моке `VcsProcess`.
