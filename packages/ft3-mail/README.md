# @t3tools/ft3-mail

Хранилище почты TaskTeam: задачи, участники, раунды, письма, доставки, пробуждения и
обратная связь по классификации писем. Сервис, MCP и UI живут в следующих срезах; здесь
только контракты, SQL-repository и миграция.

## Экспорты

- `./contracts` — browser-safe схемы `effect/Schema`: `MailTask`, `MailMember`, `MailRound`,
  `MailLetter`, `MailDelivery`, `MailWake`, `MailKindFeedback`, `MailTimelineEntry`, виды
  писем, раундов и состояния доставки;
- `./repository` — `MailRepository`: создание задачи, участники, идемпотентное открытие и
  закрытие раунда, идемпотентная запись письма, доставки с переходом
  `pending → delivered → read → answered`, идемпотентная запись пробуждения, обратная связь
  классификатора и её перенос в поля письма, таймлайн и purge завершённых задач по сроку
  хранения;
- `./migrations` — `11_Mail` для журнала `ft3_migrations`.

Идемпотентность: создание задачи — `(created_by_thread_id, client_request_id)`,
раунд — `(task_id, round_number)`, письмо — `(task_id, sender_thread_id, client_request_id)`
плюс fingerprint payload, доставка — `(letter_id, recipient)`, пробуждение —
`idempotency_key`, обратная связь — `letter_id`. Повтор письма или создания задачи с другим
fingerprint возвращает `MailIdempotencyConflict`.
