# Fork boundary (ft3-v2)

Правило переезда на upstream V2: правки upstream-файлов минимальны, каждая только
подключает или настраивает, своей логики в upstream-файлах нет. Каждая правка
записывается в таблицу ниже.

Цель: desktop ft3-v2 работает одновременно со старым ft3 desktop и официальным
T3 Code без общих userData, single-instance lock, AppUserModelID и URL-схемы.
single-instance lock привязан к userData, поэтому отдельной правки не требует.

| Upstream-файл                                   | Правка                                                                                    | Зачем                                                                      |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `apps/desktop/src/app/DesktopConfig.ts`         | `userDataDirectoryOverride: trimmedString("T3CODE_DESKTOP_USER_DATA_DIR")`                | env-переопределение имени userData                                         |
| `apps/desktop/src/app/DesktopEnvironment.ts`    | поле `userDataDirectoryOverride`, проброшено из `DesktopConfig`                           | доставка значения в `resolveUserDataPath`                                  |
| `apps/desktop/src/app/DesktopUserData.ts`       | `resolveUserDataPath` берёт `current` имя из override                                     | изоляция Chromium-профиля от `t3code` (ft3) и `t3code-v2` (официальный T3) |
| `apps/desktop/src/electron/ElectronProtocol.ts` | `getDesktopScheme` и `registerDesktopSchemePrivilegesSync` читают `T3CODE_DESKTOP_SCHEME` | изоляция URL-схемы; регистрируется как privileged до `ready`               |

Тестовые правки той же desktop-интеграции:

| Upstream-файл                                        | Правка                              | Зачем                                        |
| ---------------------------------------------------- | ----------------------------------- | -------------------------------------------- |
| `apps/desktop/src/app/DesktopEnvironment.test.ts`    | тест передачи env override          | проверка конфигурации userData               |
| `apps/desktop/src/app/DesktopUserData.test.ts`       | тест имени каталога из override     | проверка изоляции userData                   |
| `apps/desktop/src/electron/ElectronProtocol.test.ts` | тесты override и fallback URL-схемы | проверка совместимости значений по умолчанию |

AppUserModelID переопределяется штатным env `T3CODE_DESKTOP_APP_USER_MODEL_ID`
(`apps/desktop/src/app/DesktopConfig.ts`), правки не требует.

## Значения для ft3-v2

| Компонент      | Старый ft3           | Официальный T3       | ft3-v2 (env)                                          |
| -------------- | -------------------- | -------------------- | ----------------------------------------------------- |
| userData       | `t3code`             | `t3code-v2`          | `T3CODE_DESKTOP_USER_DATA_DIR=ft3-v2`                 |
| AppUserModelID | `com.t3tools.t3code` | `com.t3tools.t3code` | `T3CODE_DESKTOP_APP_USER_MODEL_ID=com.t3tools.ft3.v2` |
| URL-схема      | `t3code`             | `t3code`             | `T3CODE_DESKTOP_SCHEME=ft3`                           |

Без env поведение совпадает с upstream.

## Серверная композиция ft3

`packages/ft3-host` владеет серверной композицией форка. Функциональные пакеты
подключаются через него; upstream-файлы только подключают его экспорты.
`packages/ft3-orchestration` читает V2-проекции без собственного движка и состояния.
Его MCP-регистрация использует существующие `McpToolAccess` и `toolkitRegistration`;
host загружает её при построении Layer, чтобы не замкнуть инициализацию модулей сервера.

| Upstream-файл                                       | Правка                                                                                  | Зачем                                                               |
| --------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `apps/server/src/server.ts`                         | импорт `ft3-host/server`, `Ft3Host.layer` и `Ft3Host.reactorLayer()` в композиции Layer | подключение серверных возможностей ft3, запуск реактора доски       |
| `apps/server/src/mcp/McpHttpServer.ts`              | импорт `ft3-host/server`, spread `Ft3Host.mcpToolkits` в `Layer.mergeAll`               | подключение регистрационных Layer MCP-toolkit'ов ft3                |
| `apps/server/src/persistence/Sqlite.ts`             | импорт `ft3-host/server`, `Ft3Host.runMigrations()` после core `runMigrations()`        | миграции пакета на той же SQLite-сессии после core                  |
| `apps/server/package.json`                          | зависимость `@t3tools/ft3-host: workspace:*`                                            | разрешение workspace-пакета                                         |
| `pnpm-lock.yaml`                                    | importers `packages/ft3-*` и workspace-зависимости                                      | воспроизводимое подключение пакетов                                 |
| `apps/server/src/persistence/ft3Migrations.test.ts` | ожидаемые записи `Board`, `BoardReactor` и `Architect` в журнале ft3                    | проверка подключения миграций пакетов доски, реактора и архитектора |

Журнал пакета — `ft3_migrations`, таблицы пакета имеют префикс `ft3_`.
Core-журнал `effect_sql_migrations` принадлежит upstream; миграции ft3 его
не используют. Идентификаторы миграций в двух журналах независимы.

`packages/ft3-board` хранит доску отдельно от журнала событий V2. Репозиторий
принимает человеческую отметку оркестратора для будущего UI; MCP не
предоставляет инструмент назначения этой роли. Инструменты регистрируются для
всех сессий, а capability `orchestration`, актуальная человеческая отметка и
принадлежность карточки проверяются при каждом вызове. Это позволяет назначать
и снимать роль без перезапуска сессии. Внешний ключ отметки указывает на
`orchestration_v2_projection_threads`; логическое удаление V2 не запускает
SQL-каскад, поэтому `BoardReactor` (`packages/ft3-board/src/BoardReactor.ts`)
обрабатывает `thread.deleted` и явно удаляет карточки, историю и отметку
оркестратора. Он же будит оркестратора по terminal-событиям исполнителей
(`subagent.updated`, `run.updated`, `provider-thread.updated`,
`runtime-request.updated`), хранит курсор и очередь пробуждений в таблицах
`ft3_board_reactor_*` и подключается в рантайм через `Ft3Host.reactorLayer()`.

`packages/ft3-architect` хранит связку координатор/архитектор и запрошенные
архитектурные ревью отдельно от журнала событий V2. Таблицы
`ft3_architect_binding` и `ft3_architect_review` повторяют итоговую схему
legacy `coordinator_architect_binding`/`architecture_review` (миграции
058–061, 063 старого форка) с V2-владением: `coordinator_thread_id` ссылается
на `orchestration_v2_projection_threads` с каскадом, как отметка доски.
Срез 1–2 переносит только чтение: инструменты `get_coordinator_binding` и
`list_architecture_reviews`. Отметка оркестратора не дублируется — проверка
при вызове читает `BoardRepository.listOrchestrators` из `ft3-board`. Права
повторяют `ft3-board`: capability `orchestration`, живой тред, отказ
делегированному исполнителю; доступ к данным — сам координатор (или человек
на нём) либо связанный архитектор только к своей связке. Создание, замена,
ответ и публикация ревью — в следующих срезах.

