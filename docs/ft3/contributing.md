# ft3: правила изменения проекта

Этот документ читают до первой правки. Карта пакетов — в [README.md](./README.md),
журнал швов — в [fork-boundary.md](../internals/fork-boundary.md).

## 1. Граница с upstream

Логика форка живёт только в `packages/ft3-*`. Upstream-файлы получают **аддитивные швы**:

- импорт пакета;
- один вызов или один проп;
- слот в существующем ряду/списке;
- ранний возврат-перехватчик, который при «не моём» случае возвращает управление
  upstream-ветке без изменений.

Запрещено удалять, переписывать или «улучшать заодно» upstream-код. Если без этого нельзя
обойтись, сначала ищите внешний шов; копия upstream-модуля в `packages/ft3-*` — крайняя мера
и требует отдельного объяснения в `fork-boundary.md`.

Каждая правка upstream-файла получает строку в
[fork-boundary.md](../internals/fork-boundary.md): файл, точная правка, зачем. Без строки
правка не считается завершённой.

Настоящий bug fix upstream, который нельзя вынести наружу, помечается в журнале как
`"upstream bug fix — drop when upstream fixes"` и удаляется, когда upstream исправляет
поведение сам. Примеры текущего состояния — Codex drain и Muse reconciliation в
`fork-boundary.md`.

## 2. Швы должны переживать upstream

Предпочитайте generic-швы:

- generic-проп (`depth`, `decorations`, `source`) вместо ветки под конкретный ft3-экран;
- generic-hook (`decorateRuntime`, `setPiExtensionSourceTransform`) вместо копии адаптера;
- один реестр (`ft3SurfaceRegistry`) вместо набора `case` в upstream;
- расширение union + `normalize*` вместо правки каждого потребителя;
- generic-namespace настроек (`ft3`) вместо параллельного store.

Чем меньше строк upstream знает о ft3, тем дешевле rebase. Если шов требует правки
нескольких upstream-файлов, проверьте, нельзя ли свести его к одной точке.

## 3. Новые таблицы и миграции

Новая таблица добавляется миграцией пакета, а не правкой core-схемы:

1. Выберите владельца: `ft3-host` (`packages/ft3-host/src/Migrations/`), `ft3-board`
   (`src/migrations.ts`) или `ft3-architect` (`src/migrations.ts`).
2. Возьмите **следующий глобальный id**. Сейчас заняты 1–9, следующий — `10`. Для host —
   файл `NNN_<Name>.ts`; для пакета — ключ `<id>_<Name>` в объекте `migrations`, функция —
   `Effect.gen` с SQL через `SqlClient`.
3. Для host-миграции добавьте импорт и запись в `loader` в
   `packages/ft3-host/src/Migrations.ts`; для пакетной — запись в `migrations` пакета.
4. Обновите **все** ожидания списка миграций:
   - `packages/ft3-host/src/Migrations.test.ts`;
   - `packages/ft3-board/src/migrations.test.ts`;
   - `packages/ft3-architect/src/migrations.test.ts`;
   - `apps/server/src/persistence/ft3Migrations.test.ts`.
5. Проверьте, что повторный прогон пуст, а неуспешная миграция не попадает в журнал.
6. Если меняется набор таблиц, обновите ожидаемый список таблиц в
   `packages/ft3-host/src/Migrations.test.ts`.
7. Опишите таблицу и её владельца в [database.md](./database.md).

Не добавляйте колонки в upstream-таблицы и не создавайте второй журнал миграций.
Идентификаторы `ft3_migrations` и `effect_sql_migrations` независимы.

## 4. Новый ft3 RPC

Порядок:

1. Контракт метода (payload, success, error) — в `src/rpc-contracts.ts` пакета-владельца:
   `ft3-board`, `ft3-architect`, `ft3-pi`, `ft3-vcs` или `ft3-host` для
   `openContext.resolveDoc`.
2. Scope — в карте `*RpcScopes` того же файла: чтение — `orchestration:read`, запись —
   `orchestration:operate`.
3. Серверный обработчик и `serviceLayer` — в `src/rpc.ts` пакета.
4. Регистрация — в `packages/ft3-host/src/rpc.ts`: импорт `*Rpcs`, `*Handlers`, `*Scopes` и
   `*ServiceLayer` пакета и их spread в `group`, `handlers`, `ft3RpcScopes`, `serviceLayer`.
   `FT3_WS_METHODS` уже собирается из пакетных карт. Серверная группа слита в
   `apps/server/src/ws.ts`; этот файл для нового метода не правится.
5. Браузерный контракт — `packages/ft3-host/src/rpc-contracts.ts`; web импортирует только
   его, а не серверный `./rpc`.
6. Добавьте stub в `packages/ft3-host/src/rpc.test.ts` и вызов в оба сценария (успех и
   отказ без scope). Тест `FT3 RPC scope map` требует ровно один scope на каждый метод.
7. Если метод меняет пользовательский сценарий, добавьте live-проверку (раздел 5).

Не добавляйте метод в upstream `WsRpcGroup` или `RpcAuthorization.ts` вручную.

## 5. Проверки

Пакетные скрипты — канонические: `typecheck` запускает `tsc --noEmit`, `test` запускает
`vp test run` с корневым конфигом. Из каталога пакета это эквивалентно:

```sh
pnpm exec tsc --noEmit -p .
pnpm run test
```

Из корня:

```sh
pnpm --filter @t3tools/ft3-board run typecheck
pnpm --filter @t3tools/ft3-board run test
```

Проверяйте все затронутые `packages/ft3-*`, а также:

```sh
pnpm --filter t3 run typecheck
pnpm --filter @t3tools/web run typecheck
```

Обязательный минимум перед завершением:

1. Typecheck всех `packages/ft3-*`, `apps/server`, `apps/web`.
2. Тесты каждого затронутого пакета. Для `ft3-web` — `pnpm run test` (unit + browser
   projects).
3. CI-гейт `.github/workflows/ft3-gate.yml` остаётся актуальным. В нём **два** списка
   пакетов (typecheck и tests) плюс отдельные шаги для правленых upstream-файлов
   (`apps/server/src/ws.test.ts`, `apps/server/src/persistence/ft3Migrations.test.ts`,
   `apps/server/src/textGeneration/CodexTextGeneration.test.ts`, desktop-тесты,
   `@t3tools/provider-muse`). Новый `packages/ft3-*` или новый правленый upstream-тест
   добавляется в гейт.
4. **Live-проверка пользовательского изменения.** Unit-тестов недостаточно. Соберите web
   (`pnpm --filter @t3tools/web run build`) и перезапустите сервер, который вы запускали;
   пройдите изменённый сценарий в работающем инстансе. Для UI — тот же экран/панель/меню,
   для серверного поведения — видимый результат через клиент или RPC.
5. Если правился upstream-файл, прогоните его тесты из гейта.

Известные падения upstream-тестов на Windows (в частности, тесты adapters/testkit в
`apps/server/src/orchestration-v2`) не являются регрессиями форка; не «чините» их в рамках
ft3-задачи и не добавляйте в гейт. Не запускайте repo-wide suite: CI владеет полным
прогоном.

## 6. Windows и локальный инструментарий

- Запускайте `pnpm`/`vp` из Windows Node, а не из WSL: workspace-пути, store и нативные
  бинарники у WSL и Windows разные, поэтому установка из WSL ломает запуск в Windows.
- Node берётся из `package.json` (`engines`) через `vp`; не подменяйте его другим Node.
- Pre-commit hook — `.vite-hooks/pre-commit`, одна команда `vp staged`.
- `typescript` в репозитории — drop-in `@tsc-rs/typescript`; `pnpm exec tsc` и
  `vp run typecheck` используют его. Параллельные tsc-процессы могут делить daemon и
  возвращать чужие диагностики — гейт запускает пакеты последовательно.
- Проверка пути с пробелами уже учтена в `apps/web/vite.config.ts`; не заменяйте upstream
  `new URL(...).pathname` на `fileURLToPath` глобально.

## 7. Коммиты

Только conventional subject, без body и без `Co-Authored-By`:

```text
feat(ft3-board): add readiness filter to the board page
fix(ft3-web): keep the selected commit when the diff panel opens
```

Ниже subject допустима только ссылка на задачу. Объяснение причины и результатов — в
ответе человеку, не в Git history.

## 8. Rebase на upstream

1. `git fetch` upstream и `git rebase` текущую ветку на upstream.
2. Конфликты ожидаемы **только на швах** из `fork-boundary.md`. Конфликт в файле, которого
   нет в журнале, означает либо незаписанный шов, либо захваченную upstream-логику — сначала
   разберите причину, потом продолжайте.
3. Если конфликтует `pnpm-lock.yaml`, возьмите lockfile upstream целиком и выполните
   `pnpm install`, затем закоммитьте результат. Не сливайте lockfile вручную.
4. Перезапустите проверки из раздела 5.
5. Просмотрите upstream-изменения на предмет функций, которые уже делают то же, что ft3.
   Если upstream закрыл потребность, **удалите нашу реализацию и шов**, а не поддерживайте
   две версии. Пример класса таких задач — маскирование frontmatter в превью Markdown:
   если upstream начнёт делать это сам, `MarkdownDocumentPreview` и его шов удаляются.
6. После rebase обновите `fork-boundary.md`: уберите исчезнувшие швы, добавьте новые,
   проверьте, что примеры строк и тестов ещё существуют.
