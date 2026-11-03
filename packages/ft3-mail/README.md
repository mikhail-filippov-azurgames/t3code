# @t3tools/ft3-mail

Хранилище почты TaskTeam: задачи, участники, письма и доставки. Сервис, MCP и UI
живут в следующих срезах; здесь только контракты, SQL-repository и миграция.

## Экспорты

- `./contracts` — browser-safe схемы `effect/Schema`: `MailTask`, `MailMember`,
  `MailLetter`, `MailDelivery`, `MailTimelineEntry`, виды писем и состояния доставки;
- `./repository` — `MailRepository`: создание задачи, участники, идемпотентная запись
  письма, доставки с переходом `pending → delivered → read → answered`, таймлайн и
  purge завершённых задач по сроку хранения;
- `./migrations` — `11_Mail` для журнала `ft3_migrations`.

Идемпотентность: создание задачи — `(created_by_thread_id, client_request_id)`,
письмо — `(task_id, sender_thread_id, client_request_id)` плюс fingerprint payload,
доставка — `(letter_id, recipient)`. Повтор с другим fingerprint возвращает
`MailIdempotencyConflict`.
