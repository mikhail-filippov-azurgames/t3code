# @t3tools/ft3-mail

Хранилище почты TaskTeam: задачи, участники, раунды, письма, доставки, пробуждения и
обратная связь по классификации писем. Сервис `MailService` (задача, участники с маршрутом,
письма по матрице) есть; доставка и запуск участников, MCP и UI живут в следующих срезах.

## Экспорты

- `./contracts` — browser-safe схемы `effect/Schema`: `MailTask`, `MailMember`, `MailRound`,
  `MailLetter`, `MailDelivery`, `MailWake`, `MailKindFeedback`, `MailTimelineEntry`, виды
  писем, раундов и состояния доставки;
- `./repository` — `MailRepository`: создание задачи, участники, идемпотентное открытие и
  закрытие раунда, идемпотентная запись письма, доставки с переходом
  `pending → delivered → read → answered`, идемпотентная запись пробуждения, обратная связь
  классификатора и её перенос в поля письма, таймлайн и purge завершённых задач по сроку
  хранения;
- `./migrations` — `11_Mail` для журнала `ft3_migrations`;
- `./service` — `MailService`: создание задачи с участниками и маршрутом, отправка письма по
  матрице, закрытие задачи; `mailKindAllowed` — матрица видов;
- `./delegationLaunch` — `mailDelegationLaunchLayer`: при включённой почте каждая делегируемая
  роль запускается как участник (`mail_required`);
- `./documentsWrite` — `documentsWriteFactsLayer`: факты права записи документов участника;
- `./server` — серверные слои почты (маршрут, usage, evidence карточки); собирает ft3-host.

Идемпотентность: создание задачи — `(created_by_thread_id, client_request_id)`,
раунд — `(task_id, round_number)`, письмо — `(task_id, sender_thread_id, client_request_id)`
плюс fingerprint payload, доставка — `(letter_id, recipient)`, пробуждение —
`idempotency_key`, обратная связь — `letter_id`. Повтор письма или создания задачи с другим
fingerprint возвращает `MailIdempotencyConflict`.

## Матрица адресов и видов

Сервер проверяет её при каждой отправке. Код — `mailKindAllowed` в `src/service.ts`; при
расхождении верен код, таблица описывает его.

| Отправитель                  | Адресат                                                         | Допустимые виды                                   | Отказ                                                                            |
| ---------------------------- | --------------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------- |
| lead                         | `human`                                                         | любой                                             | —                                                                                |
| lead                         | `role:<роль>[/<специализация>]` объявленного в задаче участника | request, answer, question, info                   | `address_denied` (нет участника), `kind_denied` (другой вид)                     |
| lead                         | `lead`, `role:lead`, роль без объявленного участника            | —                                                 | `address_denied`, `invalid_role`                                                 |
| участник (кроме `architect`) | `lead`                                                          | answer, question, blocked, info                   | `kind_denied` (request, approve, changes); `address_denied` (любой другой адрес) |
| участник `architect`         | `lead`                                                          | answer, question, blocked, info, approve, changes | `address_denied` (любой другой адрес)                                            |
| system                       | `lead`                                                          | blocked, info                                     | отправляет задача 22                                                             |

`request` шлёт только lead: участник не диспетчеризует работу. `approve` и `changes` — ответы
консультанта на ревью, поэтому только роль `architect`.
