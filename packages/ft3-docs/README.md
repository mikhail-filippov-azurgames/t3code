# @t3tools/ft3-docs

Единственный владелец формата хранилища документов Corvis. Остальные пакеты
адресуют документы через `@t3tools/ft3-docs/contracts` и не знают ни схемы БД,
ни раскладки файлов.

## Экспорты

- `./contracts` - browser-safe типы и разбор ссылок: `DocAddress`, `DocRef`,
  `parseDocRef`;
- `./server` - серверная часть: `DocsStore` и его Effect-слой на отдельном
  `SqlClient` (`node:sqlite`), константы раскладки store. Реконсилятор, watcher,
  FTS и сервис документов добавляются следующими задачами.

## Формат хранилища

Спецификация зафиксирована по upstream OpenContext, коммит
`0649e7134346f6f5038a9b29cc5c824ae6a54f3f` (`crates/opencontext-core/src/lib.rs`).
Код upstream не импортируется и не копируется: формат воспроизводится на
`node:sqlite`, в репозитории хранятся только хеш коммита и правила ниже.

| Элемент     | Правило                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Корень      | `<root>/contexts/**` - файлы документов, `<root>/opencontext.db` - база. `root` задаёт серверная настройка, в репозитории его нет.                                                                                                                                                                                                                                                      |
| Схема       | Ровно две таблицы: `folders(id, parent_id -> folders ON DELETE CASCADE, name, rel_path UNIQUE, abs_path, description DEFAULT '', created_at, updated_at)` и `docs(id, folder_id -> folders ON DELETE CASCADE, name, rel_path UNIQUE, abs_path, description DEFAULT '', stable_id, created_at, updated_at)`, плюс `idx_docs_stable_id UNIQUE`. Других таблиц и колонок в этом файле нет. |
| `stable_id` | UUIDv4-строка из 16 случайных байтов с выставленными version/variant битами; создаётся один раз и не меняется.                                                                                                                                                                                                                                                                          |
| `rel_path`  | Разделитель `/`, без `..`, без пустых сегментов, имя без `/`; путь относительно `contexts/`.                                                                                                                                                                                                                                                                                            |
| `abs_path`  | `path.resolve(contextsRoot, rel_path)` для совместимости с внешним `oc`. `ft3-docs` никогда не читает файл по `abs_path`, только по `<contextsRoot>/<relPath>`, поэтому смешанные разделители старых строк не мешают.                                                                                                                                                                   |
| Время       | RFC3339 с миллисекундами, UTC.                                                                                                                                                                                                                                                                                                                                                          |
| frontmatter | Поле `stable_id: <uuid>`; остальные поля не трогаются. Файл без frontmatter получает блок `---\nstable_id: <uuid>\n---\n`. Вставка побайтовая: сохраняются BOM, CRLF/LF и порядок полей.                                                                                                                                                                                                |
| Ревизии     | В БД нет `revision` и `status`: это поля frontmatter. `@N` в `oc://doc/<stable_id>@N` не участвует в резолве и остаётся меткой.                                                                                                                                                                                                                                                         |
| Соединение  | Отдельный `SqlClient` на `opencontext.db`: `busy_timeout=5000`, `foreign_keys=ON`; `journal_mode` не меняется, чтобы файл оставался читаемым внешним `oc`; `SQLITE_BUSY` после таймаута повторяется до трёх раз.                                                                                                                                                                        |

## Адресация

```text
DocAddress = { kind: "path", relPath } | { kind: "id", stableId }
parseDocRef("oc://doc/<stable_id>[@N]" | "ocl://doc/<stable_id>" | "<rel/path.md>")
```

- `parseDocRef` принимает `oc://` и `ocl://` ссылки, необязательную метку `@N`
  и путь внутри store; на недопустимую ссылку возвращает `null`.
- Путь нормализуется к `/`, ведущий `./` снимается; абсолютные пути, `~`,
  `..` и пустые сегменты отклоняются.
- `DocRef = { stableId, relPath, name, sha256? }` - метаданные разрешённого
  документа; `sha256` отсутствует, когда известен только адрес.

## Хранилище: `DocsStore`

`DocsStore` - единственный код, который создаёт и меняет формат store. Слой
`DocsStore.layer({ root })` открывает `<root>/opencontext.db` своим
`SqlClient` (`busy_timeout=5000`, `foreign_keys=ON`, `journal_mode` не
меняется) и создаёт схему, если файл пустой.

| Операция                                                      | Правило                                                                                                                                     |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `listFolders(parentRelPath?)`, `createFolder`, `removeFolder` | Один уровень; root store - строка `folders` с `rel_path = ''` и `parent_id IS NULL`, создаётся при открытии                                 |
| `listDocs(folderRelPath?)`, `getByPath`, `getByStableId`      | Метаданные документа; `getByPath`/`getByStableId` возвращают `null`, если строки нет                                                        |
| `createDoc`, `readDocContent`, `saveDocContent`               | Файл пишется атомарно (temp + rename); `stable_id` строки всегда записан во frontmatter                                                     |
| `setDescription`                                              | Меняет только `docs.description` и `updated_at`                                                                                             |
| `moveFolder`, `renameFolder`, `moveDoc`, `renameDoc`          | Файлы и каталоги физически переносятся, затем `rel_path`/`abs_path` поддерева (и `folder_id`, `name` документа) переписываются в транзакции |
| `manifest({ folderRelPath?, limit? })`                        | Рекурсивный список; без `limit` отдаёт все строки, `abs_path` в результат не входит, лимит проверяется (целое ≥ 1)                          |

Пути проверяются до любой записи: абсолютные пути, `~`, буква диска, `..`,
пустые сегменты и NUL отклоняются с `DocsStoreError.code = "invalid_path"`.
Документом считается файл `*.md`. Ошибки store: `invalid_path`,
`invalid_name`, `invalid_limit`, `folder_exists`, `folder_not_found`,
`document_exists`, `document_not_found`, `file_missing`,
`duplicate_stable_id`, `store_unavailable`.

`createDoc` с содержимым, у которого уже есть `stable_id` во frontmatter,
сохраняет этот id (копия документа из другого store не теряет связь); иначе
генерируется UUIDv4. `saveDocContent` пишет id строки, поэтому путь и id
остаются согласованными.

Удаления и перемещения через store не входят в MCP: их делает человек в
файловой системе, реконсилятор (следующая задача) подхватывает результат.

## Лицензия и атрибуция

Формат и правила выше описывают поведение OpenContext
(<https://github.com/0xranx/OpenContext>), коммит
`0649e7134346f6f5038a9b29cc5c824ae6a54f3f`, MIT License,
Copyright (c) 2025 OpenContext.

Upstream `package.json` объявляет `Apache-2.0`, при этом `LICENSE` и `README`
upstream - MIT. Corvis считает формат MIT-лицензированным; текст MIT и это
расхождение фиксируются в `packages/shared/src/thirdPartyLicenses.ts` отдельной
задачей лицензий. Код upstream в этот пакет не попадает: здесь только
спецификация и собственная реализация.
