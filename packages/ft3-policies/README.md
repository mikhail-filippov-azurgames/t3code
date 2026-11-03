# @t3tools/ft3-policies

Политика Corvis: контракты источников документов политики, настройки `ft3.policies`
и реестр функций с графом зависимостей.

## Экспорты

- `./contracts` — browser-safe: `PolicyDocumentKey`, `PolicyDocumentSource`
  (`builtin`, документ store через `DocAddress` из `@t3tools/ft3-docs/contracts`,
  внешний путь), `PolicyDocumentRef`, `PolicyRequirementId`, `FEATURE_REGISTRY`
  и `resolveFeatureStates`;
- `./settings` — схемы `ft3.policies` (`documents`, `applyExternalEdits`,
  `features`), типизированный project override `ft3PolicyDocuments`,
  `readPolicySettings` и `resolvePolicyDocumentSources`.

Встроенные шаблоны — ресурсы пакета `assets/`; их содержимое добавляют срезы
parser'ов. `DocumentKey` — `routingPolicy`, `roles`, `leadSkills`; по умолчанию
все три берут `{ kind: "builtin" }`.

## Функции

`documents`, `roles`, `board`, `mail`, `planning` плюс тумблеры rev2
(`delegation`, `orchestration`, `boardAutomation`, `sidebarForest`,
`chatExtensions`, `vcs`, `pi`, `kimi`, `usage`, `files`). Функции `architect` нет:
сохранённое значение отбрасывается при декодировании. Граф зависимостей:
`board → roles`, `mail → board, delegation`, `planning → mail, documents`;
`effectiveEnabled = requested && dependencies effective && requirements valid`.

`applyExternalEdits` и тумблеры — только environment-wide. Проект может
переопределить ровно один документ политики ключом `ft3PolicyDocuments`; этот
источник имеет приоритет над environment-настройкой для своего ключа.

## Границы

Парсеры, загрузчик, snapshot, RPC и UI — следующие задачи дизайна; пакет не
читает файлы и не знает формат store. Шов upstream — generic-ключ
`ft3PolicyDocuments` в `packages/contracts/src/settings.ts`; строка — в
[fork-boundary.md](../../docs/internals/fork-boundary.md).

## Тесты

`pnpm run test`: разрешение зависимостей функций, декодирование `ft3.policies`
(включая отброшенный `architect`), приоритет project override и шов
`ProjectSettingsOverrides`.
