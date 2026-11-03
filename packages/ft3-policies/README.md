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
  `readPolicySettings` и `resolvePolicyDocumentSources`;
- `./server` — строгие парсеры документов политики ролей и lead-скиллов:
  `parseRolesDocumentSet`, `parseRoleFile`, `parseLeadSkillsDocumentSet`,
  `parseLeadSkillFile` и типы `PolicyIssue`.

## Встроенные шаблоны

`assets/roles/` — `roles.json` (`corvis-role-map-v1`) и девять Markdown-файлов
ролей; `assets/lead-skills/` — `lead-skills.json` и `SKILL.md` трёх скиллов
(`t3-orchestrator`, `board-orchestrator`, `plan-orchestrator`). Шаблоны
обезличены: без абсолютных путей и `oc://`-идентификаторов, `configured: false`
до заполнения человеком.

`roles.json` отображает имя, которое называет lead (`id`), на delegated role id
(`roleId`) и, при необходимости, на upstream-роль (`upstreamRole`; `architecture`
→ `architect`). Поля `documentsWrite` нет: право записи документов определяется
lineage треда и грантом lead, а не ролью. Парсеры:

- отклоняют неизвестную схему, revision, `roleId`, путь файла и повтор
  `id`/`roleId`/`upstreamRole`/`file` с кодом §5 (`frontmatter_invalid`,
  `role_unknown`, `role_mapping_conflict`) и номером строки;
- предупреждают об объявленном лишнем `.md` (`role_unknown`, warning) и
  сообщают о недостающем файле только для этой роли;
- сообщают `role_missing` с подсказкой, когда включённой функции (board →
  `lead`, planning → `planner` и хотя бы один `architect*`) не хватает роли;
- для скиллов: `lead_skill_missing` с путём, сверка `name` в `SKILL.md` с
  манифестом; фиксированный набор скиллов, `create-orchestrator-architect`
  отсутствует.

`document_unconfigured` — warning: шаблон разобран без ошибок, но функции,
которым он нужен, остаются выключенными до `configured: true`.

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

Загрузчик, snapshot, RPC и UI — следующие задачи дизайна; пакет не читает файлы
и не знает формат store: парсеры получают содержимое от вызывающего кода.
Шов upstream — generic-ключ `ft3PolicyDocuments` в
`packages/contracts/src/settings.ts`; строка — в
[fork-boundary.md](../../docs/internals/fork-boundary.md).

## Тесты

`pnpm run test`: разрешение зависимостей функций, декодирование `ft3.policies`
(включая отброшенный `architect`), приоритет project override и шов
`ProjectSettingsOverrides`; парсинг встроенных шаблонов ролей и lead-скиллов;
каждый код §5 парсеров (`frontmatter_invalid`, `role_unknown`,
`role_mapping_conflict`, `role_missing`, `lead_skill_missing`,
`document_missing`, `document_unconfigured`), подсказки для неизвестной и
недостающей роли, сверка `roleId`/`name` с манифестом и номера строк.
