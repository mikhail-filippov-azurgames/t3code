# ft3: база данных, миграции и legacy-импорт

Всё ниже относится к SQLite инстанса. Конкретные абсолютные пути не фиксируются: файлы
лежат внутри дома инстанса (`T3 home`), который задаётся при запуске.

## Где лежат файлы

Сервер выводит каталог состояния из дома инстанса (`apps/server/src/config.ts`):

- `<home>/userdata/statev2.sqlite` — рабочая база V2;
- `<home>/dev/statev2.sqlite` — та же база в dev-режиме, когда dev URL задан, а корневой
  каталог не передан явно;
- `<home>/userdata/state.sqlite` — база V1. `initializeV2Database` копирует её в
  `statev2.sqlite` только при отсутствии `statev2.sqlite`;
- `<stateDir>/attachments` — вложения, которыми пользуется V2 (`<id>.<extension>`);
- `<stateDir>/pi/<instanceId>` — управляемый agent-dir Pi и `inference-profiles.json`.

Здесь `<stateDir>` — это `<home>/userdata` или `<home>/dev` по правилу выше.

Пакетные импортёры получают либо путь к базе, либо корень дома источника и корень дома
назначения. Ни один CLI не требует абсолютного пути, зашитого в репозитории.

## Два журнала миграций

| Журнал                  | Владелец | Назначение                                                                                                 |
| ----------------------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| `effect_sql_migrations` | upstream | core-миграции V2. Миграции ft3 его не используют; legacy-подготовка один раз переносит из него fork-строки |
| `ft3_migrations`        | ft3      | журнал пакетов форка: `migration_id`, `created_at`, `name`                                                 |

`apps/server/src/persistence/Sqlite.ts` вызывает core `runMigrations()`, затем
`Ft3Host.runMigrations()` на той же сессии. Идентификаторы журналов независимы.
`packages/ft3-host/src/Migrations.ts` собирает единый loader:

1. host-миграции из `packages/ft3-host/src/Migrations/`;
2. `migrations` из `@t3tools/ft3-board/migrations`;
3. `migrations` из `@t3tools/ft3-architect/migrations`.

Занятые id — 1–9. Следующая миграция получает id `10` независимо от того, в каком пакете
лежит файл. Ожидаемый список миграций проверяется в четырёх местах:
`packages/ft3-host/src/Migrations.test.ts`, `packages/ft3-board/src/migrations.test.ts`,
`packages/ft3-architect/src/migrations.test.ts`,
`apps/server/src/persistence/ft3Migrations.test.ts`.

Свойства мигратора, на которые опираются тесты:

- неуспешная миграция не записывается в журнал, а частично применённые изменения
  откатываются;
- повторный прогон возвращает пустой список и не трогает данные;
- `ft3_migrations` можно создать заранее (так делает legacy-подготовка).

## Таблицы ft3

Все таблицы форка имеют префикс `ft3_`. Владелец таблицы — пакет, в чьём файле миграции она
объявлена. Внешние ключи на V2 включаются, потому что persistence выставляет
`PRAGMA foreign_keys = ON`; логическое удаление V2 (`deleted_at`) не запускает SQL-каскад,
поэтому доска и purge удаляют строки явно.

### `packages/ft3-host/src/Migrations/`

| Миграция                             | Таблица                                     | Колонки и назначение                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------ | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `001_Ft3Meta`                        | `ft3_meta`                                  | `key TEXT PRIMARY KEY`, `value TEXT NOT NULL`. Резервное key/value-хранилище форка; миграции строк не создают, код вне тестов его не читает                                                                                                                                                                                                                                                                                                                                                                                                      |
| `006_Ft3DelegatedTaskSummaries`      | `ft3_delegated_task_summaries`              | `child_thread_id`, `parent_environment_id`, `parent_thread_id`, `source_turn_id` — идентичность выжимки; `completed_at` — момент завершения хода; `summary_text` — текст; `source` (`deterministic`/`model`), `source_turn_ids_json` — источники; `watermark` — позиция событий; `content_fingerprint` — защита от повторной генерации; `state`, `error`, `attempt_count`, `retry_after` — lease/retry; `updated_at`. PK `(child_thread_id, source_turn_id)`. Индекс `idx_ft3_delegated_task_summaries_child_latest` — последняя выжимка ребёнка |
| `007_Ft3TaskHandoffs`                | `ft3_task_handoffs`                         | `task_id TEXT PRIMARY KEY`, `parent_thread_id`, `handoff_json`, `created_at`. OCL-handoff, прикреплённый к задаче; повтор идемпотентен                                                                                                                                                                                                                                                                                                                                                                                                           |
| `008_Ft3DelegatedTaskSummaryReactor` | `ft3_delegated_task_summary_reactor_cursor` | `id INTEGER PRIMARY KEY CHECK (id = 1)`, `sequence`. Курсор реактора выжимок; строка `(1, 0)` создаётся миграцией                                                                                                                                                                                                                                                                                                                                                                                                                                |

### `packages/ft3-board/src/migrations.ts`

| Миграция           | Таблица                        | Колонки и назначение                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------ | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `2_Board`          | `ft3_board_orchestrators`      | `thread_id` — PK и FK на `orchestration_v2_projection_threads(thread_id)` с `ON DELETE CASCADE`; `created_by`, `created_at`. Человеческая отметка координатора                                                                                                                                                                                                                                                                                            |
| `2_Board`          | `ft3_board_cards`              | `card_id` PK; `orchestrator_thread_id` FK на `ft3_board_orchestrators` с каскадом; `title`, `body`; `status`; `created_by`; `assignee_json`; `executor_role`; `executor_thread_id`; `outcome`; `last_error`; `failure_streak`; `order_index`; `archived`; `created_at`, `updated_at`; `readiness` (default `'ready'`), `readiness_note`. Индексы по координатору, исполнителю, кандидатам nudge и `(orchestrator_thread_id, archived, readiness, status)` |
| `2_Board`          | `ft3_board_card_events`        | `entry_id` PK; `card_id` FK с каскадом; `at`; `status`; `executor_role`; `model`; `effort`; `body`; `source`. История карточки                                                                                                                                                                                                                                                                                                                            |
| `2_Board`          | `ft3_board_card_deletions`     | `card_id` PK; `orchestrator_thread_id`; `deleted_at`; `reason`; `history_event_count`. Запись об удалении переживает карточку, поэтому FK нет                                                                                                                                                                                                                                                                                                             |
| `3_BoardReactor`   | `ft3_board_reactor_cursor`     | `id = 1`, `sequence`. Курсор `BoardReactor`                                                                                                                                                                                                                                                                                                                                                                                                               |
| `3_BoardReactor`   | `ft3_board_reactor_wakes`      | `wake_key` PK; `orchestrator_thread_id` FK с каскадом; `executor_thread_id`; `context`. Очередь пробуждений координатора                                                                                                                                                                                                                                                                                                                                  |
| `3_BoardReactor`   | `ft3_board_reactor_background` | `provider_thread_id` PK; `thread_id`; `task_ids_json`. Связь фонового provider-thread с задачами                                                                                                                                                                                                                                                                                                                                                          |
| `3_BoardReactor`   | `ft3_board_reactor_outcomes`   | `card_id` FK с каскадом, `execution_key`; PK по паре. Дедупликация terminal-исходов                                                                                                                                                                                                                                                                                                                                                                       |
| `9_BoardRetention` | —                              | Добавляет индекс `idx_ft3_board_cards_retention` по `(status, archived, updated_at)`. Новых таблиц нет                                                                                                                                                                                                                                                                                                                                                    |

### `packages/ft3-architect/src/migrations.ts`

| Миграция                | Таблица                 | Колонки и назначение                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `4_Architect`           | `ft3_architect_binding` | `binding_id` PK; `coordinator_thread_id` FK на `orchestration_v2_projection_threads` с каскадом; `architect_thread_id`; `project_id`; `architect_task_effort`; `status`; `created_at`, `created_by`; `replaced_by_binding_id`, `detach_reason`; `create_idempotency_key`, `create_request_fingerprint`; `close_idempotency_key`, `close_request_fingerprint`; `routing_evidence_json`. Уникальные частичные индексы: одна active-связка на координатора и на архитектора; уникальность `(coordinator_thread_id, create_idempotency_key)`                                                                                                                                                       |
| `4_Architect`           | `ft3_architect_review`  | `review_id` PK; `binding_id` FK с каскадом; `coordinator_thread_id`, `architect_thread_id`; `subject_child_thread_id`; `reason`, `question`, `refs_json`, `execution_posture`; `answer_disposition`, `status`, `answer_summary`; ключи и fingerprints идемпотентности для request/answer/publish/cancel; `cancelled_at`, `cancelled_by`; `created_at`, `answered_at`, `published_at`, `publish_delivered_at`; `last_publish_failure_reason`, `last_publish_failure_message`, `last_publish_failure_at`; `origin` (default `'coordinator-request'`), `published_by`. Индексы по координатору и статусу, по связке, уникальный request-key и уникальная неопубликованная advice-запись на связку |
| `5_ArchitectReviewWake` | `ft3_architect_review`  | Добавляет `request_wake_delivered_at`. Отметка доставки пробуждения архитектору; закрывает рестарт-гэп                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

## Какие upstream-таблицы и проекции читает ft3

Прямые SQL-чтения сосредоточены в `ft3-orchestration`, `ft3-board` и импортёрах; остальное
идёт через `ThreadManagementService`.

| Upstream-таблица                                                               | Что используется                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `orchestration_v2_projection_threads`                                          | `thread_id`, `project_id`, `title`, `deleted_at`, `updated_at`, `payload_json`. Форк опирается на `payload_json.lineage`: `parentThreadId`, `relationshipToParent` (`"subagent"`), `rootThreadId`; на `deleted_at` — для purge и фильтрации; на `project_id`/`title` — для принадлежности и заголовков задач. Таблица также цель FK для доски и архитектора                                                                                                                                                                                                           |
| `orchestration_v2_projection_subagents`                                        | `subagent_id`, `thread_id` (родитель), `run_id`, `parent_node_id`, `provider`, `driver`, `provider_instance_id`, `provider_thread_id`, `child_thread_id`, `origin`, `status`, `started_at`, `completed_at`, `updated_at`, `payload_json`. Форк читает задачи с `origin = 'app_owned'`, `child_thread_id != null`; `payload_json.role` — запрошенная роль ребёнка (`architecture`, `implementation`, `review`, `test`, `research`, `general`, `design`) для бейджей sidebar; `status` — состояние задачи. Импорт создаёт синтетические строки с `origin = 'app_owned'` |
| `orchestration_v2_projection_provider_turns`                                   | `thread_id`, `provider_turn_id`, `ordinal`, `status`. Последний ход ребёнка для истории выжимок (`DelegatedTaskSummaryRepository.listHistory`)                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `orchestration_v2_projection_runs`, `..._run_attempts`, `..._runtime_requests` | Читаются через `ThreadManagementService.getThreadRecords`: последний run, попытки, pending runtime requests — для `task_list`/`task_read` и staleness выжимки                                                                                                                                                                                                                                                                                                                                                                                                         |
| `orchestration_events`                                                         | `sequence`, `aggregate_kind = 'thread'`, `stream_id`. Watermark выжимки: `MAX(sequence)` по треду ребёнка                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `scheduled_tasks`                                                              | Пишется legacy-импортом (`calendar_events` → `scheduled_tasks`) и очищается purge'ом по `thread_id`                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

### Что физически удаляет `DeletedThreadPurge`

`packages/ft3-board/src/DeletedThreadPurge.ts` стирает строки удалённого треда из
`ft3_architect_review`, `ft3_architect_binding`, `ft3_board_orchestrators`,
`ft3_board_cards`, `ft3_delegated_task_summaries`, `ft3_task_handoffs`, `scheduled_tasks`,
а также из проекций V2: context transfers/handoffs, checkpoints и их scopes, turn items и
позиции, plans, messages, runtime requests, provider turns/threads/sessions/bindings,
subagents, nodes, run attempts, runs, effect outbox, thread launch workflows, legacy import
state, events, command receipts и саму `orchestration_v2_projection_threads`.

## Legacy-импорт старого форка

Импорт — одноразовая операция над **копией** базы и дома. Живая база форка защищена
проверкой пути (`prepareLegacyDatabase.ts`, `importLegacyData.ts`): CLI отказывается
работать с ней и требует записываемую копию.

### Файлы и CLI

| Файл                        | CLI                                                                          | Что делает                                                                 |
| --------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `prepareLegacyDatabase.ts`  | `prepareLegacyDatabaseCli.ts <copy-path>`                                    | Готовит копию: наполняет staging и переносит fork-миграции из core-журнала |
| `importLegacyData.ts`       | `importLegacyDataCli.ts <copy-path>`                                         | Переносит доменные таблицы, календарь и lineage в V2/ft3-таблицы           |
| `importProviderSettings.ts` | `importProviderSettingsCli.ts <source-settings.json> <target-settings.json>` | Переписывает `providerInstances` под драйверы V2                           |
| `importAttachments.ts`      | `importAttachmentsCli.ts <source-home> <target-home>`                        | Копирует `userdata/attachments`                                            |
| `importPiAgentDir.ts`       | `importPiAgentDirCli.ts <source-home> <target-home> [--instance pi]`         | Копирует Pi credentials/model catalog и собирает `inference-profiles.json` |

### Порядок шагов

1. Снять копию базы старого форка. Запустить `prepareLegacyDatabaseCli` на копии.
2. Положить подготовленную копию как `state.sqlite` в каталог состояния и дать V2 один раз
   стартовать: `initializeV2Database` создаст `statev2.sqlite`, core-миграции создадут
   проекции V2, `Ft3Host.runMigrations()` — таблицы форка.
3. Запустить `importLegacyDataCli` на полученной `statev2.sqlite` (или её копии). Шаг
   требует уже созданных V2-проекций и `ft3_*`-таблиц.
4. При необходимости — `importProviderSettingsCli` для `settings.json`.
5. При необходимости — `importAttachmentsCli` и `importPiAgentDirCli` для домов.

Порядок важен: `importLegacyData` читает staging, созданный шагом 1, и пишет в таблицы,
созданные шагом 2.

### Что делает подготовка

`prepareLegacyDatabaseSql` в одной транзакции:

- создаёт `ft3_delegation_lineage_staging(thread_id TEXT PRIMARY KEY, created_at,
  payload_json)`;
- очищает её и заново наполняет из `projection_thread_activities`, где
  `kind = 'delegation.created'`;
- читает из `effect_sql_migrations` строки с `migration_id >= 53` (миграции старого форка);
- создаёт при необходимости `ft3_migrations` и вставляет эти строки с **отрицательными**
  id и префиксом `Legacy:` в имени;
- удаляет перенесённые строки из `effect_sql_migrations`.

Отрицательные id держат high-water mark ft3-мигратора ниже id пакетов ft3 (1–9), поэтому
ft3-мигратор не считает их применёнными; удаление fork-строк из core-журнала не даёт
core-мигратору пропустить свои шаги.
`ft3_delegation_lineage_staging` — таблица только импорта; в `ft3_migrations` её нет.

### Что переносит `importLegacyData`

Одна транзакция. Таблицы-источники: `board_orchestrators`, `board_cards`,
`board_card_events`, `board_card_deletions`, `coordinator_architect_binding`,
`architecture_review`, `projection_delegated_task_summaries`, `calendar_events`,
`ft3_delegation_lineage_staging`.

- Доска и архитектор копируются в `ft3_board_*` и `ft3_architect_*` через
  `INSERT OR IGNORE`.
- Выжимки копируются в `ft3_delegated_task_summaries`.
- `calendar_events` превращаются в `scheduled_tasks` только для ежедневного
  фиксированного времени (`minute hour * * *`): `schedule_json =
  {"type":"fixed_time","timeOfDay":"HH:MM"}`; `task_id` = `event_id`.
- Для каждой staging-строки с существующими `childThreadId` и `parentThreadId`
  создаётся синтетический subagent (`subagent_id = "ft3:" + childThreadId`,
  `parent_node_id = "ft3:node:" + childThreadId`, `origin = "app_owned"`,
  `status = "completed"`, `run_id`/`provider_thread_id` = `NULL`) и восстанавливается
  lineage треда через `json_set`: `parentThreadId`, `relationshipToParent = "subagent"`,
  `rootThreadId`. Корень семьи вычисляется подъёмом по цепочке staging-родителей.
- Провайдер и драйвер берутся из `payload.requested`; при отсутствии или невалидном
  значении — `legacy` и `native`. `createdAt` при невалидной дате — epoch. Остальные
  поля payload сохраняются.

### Идемпотентность

| Шаг                      | Поведение при повторе                                                                                                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `prepareLegacyDatabase`  | staging перезаполняется заново; журнал — `INSERT OR IGNORE` с теми же отрицательными id; повторная очистка core-журнала безопасна                                                                                  |
| `importLegacyData`       | доска/архитектор/выжимки — `INSERT OR IGNORE`; subagents — `ON CONFLICT(subagent_id) DO NOTHING`; lineage-update идемпотентен; календарь — `ON CONFLICT(task_id) DO NOTHING`; повторный прогон даёт те же счётчики |
| `importProviderSettings` | существующий V2-инстанс сохраняется, если driver совпадает; `--overwrite` заменяет; недописанная копия с V1-driver доводится до V2                                                                                 |
| `importAttachments`      | одинаковые байты пропускаются; различающиеся сохраняются как conflict без `--overwrite`; запись атомарная                                                                                                          |
| `importPiAgentDir`       | существующие V2-файлы выигрывают без `--overwrite`; пустой JSON-объект считается пустым и заполняется; перед перезаписью пишется `.bak`                                                                            |

У файловых импортёров есть `--dry-run`; `importProviderSettingsCli` дополнительно пишет
`.before-provider-import.bak` перед заменой `settings.json`.

### Известные оговорки

- **У каждой записи `providerInstances` должен быть `driver`.** Запись без `driver`
  (например, только `config.homePath`) ломает разбор настроек провайдеров, и V2 молча
  откатывается к провайдерам по умолчанию. Правя `settings.json` вручную, указывайте
  `driver` и `enabled`. Домашние папки Codex и Claude (`codex-home`, `claude-home`)
  задаёт лаунчер через переменные окружения, в `settings.json` их не прописывают.

- **Orphan-родители пропускаются.** Если `childThreadId` или `parentThreadId` отсутствует
  в `orchestration_v2_projection_threads` (или в цепочке обнаружен цикл), staging-строка
  не импортируется и попадает в `skipped`. Это ожидаемо для удалённых тредов.
- **Subagent'ы синтетические.** У импортированных задач нет native run/provider-thread;
  история provider-turn для них отсутствует. `status` всегда `completed`, даже если
  старый форк знал больше.
- **Календарь теряет часть данных.** Переносятся только daily fixed-time события;
  остальные cron-формы пропускаются для ручного разбора. Timezone источника не
  переносится. `last_run_status` выводится грубо: `never` при `last_fired_at = NULL`,
  иначе `succeeded`; `last_run_error = NULL`, `run_count = 0`.
- **Провайдеры переименовываются.** `kimi` → `acpRegistry` с `agentId = "kimi"`,
  `commandArgs = ["acp"]`; `museCode` → `muse` с удалением `homePath`. Неизвестный драйвер
  сохраняется как есть и остаётся недоступным в V2.
- **Bare-команды разрешаются в путь** через `where`/`which`; если не найдены — остаётся
  имя, и провайдер сообщает «not installed» вместо падения импорта.
- **Вложения требуют V2-имени.** Копируются только файлы вида `<lowercase-id>.<ext>`; V2
  ищет их по имени, поэтому строки БД не пишутся. Остальные имена попадают в `invalid`.
- **Pi-профили выводятся из legacy-настроек.** Если в источнике нет
  `inference-profiles.json`, конфиг собирается из instance settings и `ft3-local.baseUrl`
  модели; если не удаётся — файл не создаётся.
- **Импорт не является сквозной транзакцией между файлами.** База импортируется одной
  транзакцией, а файлы (`settings.json`, attachments, Pi) пишутся по отдельности; при
  сбое между шагами повтор безопасен, но частичный результат возможен.
- **Живая база запрещена.** Обе DB-CLI отказываются работать с живым путём старого форка;
  направляйте их на копию.
