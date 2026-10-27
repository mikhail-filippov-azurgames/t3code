# @t3tools/ft3-web

Web-расширение форка. Пакет не является самостоятельной библиотекой: его typecheck включает
исходники `apps/web` и использует алиас `~` для штатных компонентов, сторов и роутера V2.

## Экспорты

- `./panels` — `Ft3Surface`, `ft3SurfaceRegistry` (`board`, `commits`), normalize, content;
- `./board`, `./board-chat`, `./board-header` — страница `/board`, панель чата, действия в шапке;
- `./architect`, `./sidebar` — публикация и пин архитектора, лес делегирования, role badges;
- `./chat`, `./chat-composer`, `./chat-copy` — чипы карточек/коммитов/документов, слот composer'а,
  фильтры копирования;
- `./commits` — граф, дифф коммита и выбор в штатной панели;
- `./delegation`, `./delegation-dialogs` — меню треда, смена провайдера, каскад, диалоги;
- `./usage`, `./kimi`, `./pi`, `./files`, `./settings`, `./settings-search`.

## Швы

Реестр поверхностей (`rightPanelStore`, `RightPanelTabs`, `RightPanelSurfaceContent`), sidebar
(`Sidebar`, `LegacySidebar`, `SidebarThreadRow`), чат (`ChatMarkdown`, `ChatComposer`,
`ChatView`, `ChatHeader`), меню треда, usage, настройки, `index.css`. Полный список — в
[fork-boundary.md](../../docs/internals/fork-boundary.md) в разделах Web extensions,
Architect sidebar, Sidebar, Board, Chat text chips, Usage page, Markdown frontmatter, Меню треда.

## Тесты

`pnpm run test` — два проекта: `ft3-web-unit` и `ft3-web-browser` (Playwright Chromium).
