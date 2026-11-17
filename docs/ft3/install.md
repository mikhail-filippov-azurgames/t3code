# Установка Corvis

Установщики скачивают ветку `corvis/main`, устанавливают зависимости через pnpm и собирают
desktop-приложение. Исходники и собранное приложение остаются в выбранном каталоге.

## Версии

Версия записывается как `2.1.0:0.1.8`: до двоеточия — версия правок Corvis, после — версия
T3, на которой основан Corvis. Версия Corvis растёт только от наших изменений и не
сбрасывается при обновлении T3. В git двоеточие недопустимо, поэтому метка этой версии —
`v2.1.0-0.1.8`.

## Что поставить заранее

- Git. На Windows установите Git for Windows.
- Node.js 26 (точная версия — `engines.node` проекта). Если версия 26+ отличается от
  `engines.node`, установщик выведет предупреждение и продолжит работу.
- На Windows — Microsoft Visual C++ Redistributable (x64). Если его нет, установщик сам
  скачает `vc_redist.x64.exe` с `https://aka.ms/vs/17/release/vc_redist.x64.exe` и поставит
  его без окон. Если установка не удалась, поставьте его вручную по этой ссылке.
- Corepack и pnpm. После установки Corepack выполните команды ниже.
- CLI `claude` и `codex`. Они должны быть доступны приложению в окружении запуска.
  Claude Code ставьте нативным установщиком, а не через npm: npm 11.19+ блокирует его
  postinstall, и `claude` не запускается. Codex ставится через npm.
- Zavod, настроенный по корпоративной инструкции, вместе с помощником `zavod-key`.
  Zavod ищет `claude` и `codex` при запуске. Если CLI поставлены после Zavod,
  перезапустите приложение Zavod, иначе он покажет Claude Code как не установленный.

```sh
corepack enable
corepack install --global pnpm@12.14.0
npm install --global @openai/codex
```

Claude Code на Windows (PowerShell):

```powershell
irm https://claude.ai/install.ps1 | iex
```

Claude Code на macOS и Linux:

```sh
curl -fsSL https://claude.ai/install.sh | bash
```

Откройте новый терминал после установки инструментов. Установщик проверяет наличие
`git`, `node`, `corepack` и `pnpm` перед скачиванием исходников.

## Windows

Выполните в PowerShell. Используйте короткий путь для каталога установки, например
`C:\Corvis`.

```powershell
$installer = Join-Path $env:TEMP 'install-corvis.ps1'
Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/mikhail-filippov-azurgames/t3code/corvis/main/scripts/install-corvis.ps1' -OutFile $installer
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer -InstallDirectory 'C:\Corvis'
```

После сборки запустите ярлык **Corvis** на рабочем столе. Он открывает приложение из
каталога установки. Git использует поддержку длинных путей для этого клона.

## macOS и Linux

Выполните в терминале. Последний аргумент задаёт каталог установки.

```sh
curl --fail --location 'https://raw.githubusercontent.com/mikhail-filippov-azurgames/t3code/corvis/main/scripts/install-corvis.sh' --output /tmp/install-corvis.sh
sh /tmp/install-corvis.sh "$HOME/Corvis"
```

На Linux откройте **Corvis** в меню приложений. Установщик создаёт запись
`~/.local/share/applications/corvis.desktop`.

На macOS откройте скрипт запуска собранного приложения.

```sh
open "$HOME/Corvis/apps/desktop/.electron-runtime/corvis.command"
```

Если выбрали другой каталог установки, подставьте его в команду запуска. Сборка
macOS выполняется без подписи.

Без аргумента каталога оба установщика используют подкаталог `corvis` рядом со
скриптом, если он находится вне временного каталога. При запуске из `%TEMP%`,
`/tmp` или другого системного временного каталога укажите постоянный каталог
установки явно, как в примерах выше.

## Обновление

Повторите команды установки с тем же каталогом. Установщик скачает актуальную ветку
`corvis/main`, выполнит `pnpm install` и `pnpm run build:desktop`, затем обновит ярлык или
скрипт запуска.

Для обновления клон должен быть на ветке `corvis/main`, с чистым рабочим деревом и без
локальных коммитов поверх скачанной ветки. Если вы меняли файлы или
добавляли свои, сохраните их вне каталога установки или через
`git stash --include-untracked` перед повторным запуском.

## Подключение Zavod

Откройте **Settings → Providers** в Corvis и нажмите **Connect Zavod**
(«Подключить Zavod»). Подключение создаёт или переиспользует экземпляры `zavod-claude`
и `zavod-codex`, в том числе когда Claude и Codex уже используют Zavod или настроены
на разные шлюзы. Встроенная маршрутизация использует эти экземпляры. При
неподдерживаемой конфигурации причина отображается рядом с недоступной кнопкой.
Для подключения нужно право управления провайдерами.

Если пара экземпляров Zavod уже создана, раздел показывает её статус и кнопку
**Reconnect** для повторного подключения.

Corvis не хранит ключ Zavod. Claude и Codex получают его через `zavod-key` при
работе с провайдером.
