# Fork boundary (ft3-v2)

Правило переезда на upstream V2: правки upstream-файлов минимальны, каждая только
подключает или настраивает, своей логики в upstream-файлах нет. Каждая правка
записывается в таблицу ниже.

Исключение для двух переносимых исправлений Muse описано в отдельной таблице
ниже: их логика остаётся в upstream-пакете провайдера, без копии адаптера в ft3.

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

| Upstream-файл                           | Правка                                                                           | Зачем                                                |
| --------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `apps/server/src/server.ts`             | импорт `ft3-host/server`, `Ft3Host.layer` в композиции Layer                     | подключение серверных возможностей ft3               |
| `apps/server/src/mcp/McpHttpServer.ts`  | импорт `ft3-host/server`, spread `Ft3Host.mcpToolkits` в `Layer.mergeAll`        | подключение регистрационных Layer MCP-toolkit'ов ft3 |
| `apps/server/src/persistence/Sqlite.ts` | импорт `ft3-host/server`, `Ft3Host.runMigrations()` после core `runMigrations()` | миграции пакета на той же SQLite-сессии после core   |
| `apps/server/package.json`              | зависимость `@t3tools/ft3-host: workspace:*`                                     | разрешение workspace-пакета                          |
| `pnpm-lock.yaml`                        | importers `packages/ft3-*` и workspace-зависимости                               | воспроизводимое подключение пакетов                  |

Журнал пакета — `ft3_migrations`, таблицы пакета имеют префикс `ft3_`.
Core-журнал `effect_sql_migrations` принадлежит upstream; миграции ft3 его
не используют. Идентификаторы миграций в двух журналах независимы.

## Исправления Muse в стеке ft3

Перед успешным завершением адаптер сверяет потоковый текст с `session/read`:
восстанавливает только совместимые хвосты и отсутствующие сообщения. Полнота
подтверждается только непротиворечивой историей с завершёнными сообщениями;
ошибка чтения сохраняет результат как `unavailable`, не блокируя завершение.

В V2 не было поля полноты. Необязательный `outputStatus` в provider turn
сохраняется существующей проекцией и JSON-контрактом; отсутствие поля у других
провайдеров не означает подтверждённую полноту. Дополнительная SQL-миграция
не требуется. `providerTurnId` является id оркестратора, поэтому для interrupt
после потери in-memory active отдельно передаётся сохранённый native id.

| Upstream-файл                                                                     | Правка                                                                          | Зачем                                                                                       |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `packages/provider-muse/src/server/adapter.ts`                                    | сверка истории перед terminal и fallback interrupt по native id                 | полнота текста и Stop после resume                                                          |
| `packages/provider-muse/src/server/protocol.ts`                                   | необязательный `history.mode`                                                   | отличать исключённую историю от полной                                                      |
| `packages/contracts/src/orchestrationV2.ts`                                       | необязательный `OrchestrationV2ProviderTurn.outputStatus`                       | сохранять `available` / `empty` / `unavailable` в результате хода                           |
| `packages/provider-core/src/server/ProviderAdapter.ts`                            | необязательный `ProviderAdapterV2InterruptInput.nativeTurnId`                   | передавать native identity без разбора внутренних id                                        |
| `apps/server/src/orchestration-v2/ProviderTurnControlService.ts`                  | native id из сохранённого turn в обоих interrupt-вызовах                        | fallback после потери состояния адаптера                                                    |
| `packages/provider-muse/src/server/adapter.test.ts`                               | регрессии восстановления текста, недостоверной истории и interrupt после resume | воспроизводимость обеих ошибок                                                              |
| `packages/contracts/src/orchestrationV2.test.ts`                                  | JSON round-trip с полем полноты и без него                                      | обратная совместимость результата                                                           |
| `apps/server/src/orchestration-v2/ProviderTurnControlService.test.ts`             | проверки передачи native id при Stop и restart                                  | доставка сохранённого native id                                                             |
| `apps/server/src/orchestration-v2/Adapters/MuseAdapterV2.testkit.ts`              | явная RPC-ошибка для незаписанного чтения истории                               | старые live-записи не подменяются выдуманной историей; записанные запросы остаются строгими |
| `apps/server/src/orchestration-v2/testkit/MuseReplayFixtures.integration.test.ts` | проверка `unavailable` в сохранённой проекции simple replay                     | полнота не выводится из одного terminal                                                     |
