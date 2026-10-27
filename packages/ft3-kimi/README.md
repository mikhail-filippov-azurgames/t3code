# @t3tools/ft3-kimi

Обёртка upstream `AcpRegistryDriver` для Kimi Code. `driverKind` остаётся `acpRegistry`,
поэтому новых provider kind и правок web-контракта нет.

## Экспорт

- `./server` — `Ft3KimiDriver`, `isKimiAcpSettings`, `decorateKimiRuntime`,
  `kimiEmptyTurnFailureMessage`, `kimiUsagePayloadToLimits`,
  `parseKimiManagedProviderConfig`, `probeKimiUsageLimits`, `resolveKimiCodeOAuthKey`.

## Что внутри

- `driver.ts` — обёртка registry-драйвера и привязка лимитов к Kimi-инстансу;
- `usageLimits.ts` — OAuth-токен CLI Kimi из его каталога credentials, refresh с записью
  обратно в тот же файл,
  `GET {baseUrl}/usages`, кэш 60 секунд;
- `usage.ts` — чтение `usage.record` из `sessions/**/wire.jsonl`;
- `promptFailure.ts` — пустой успешный `end_turn` превращается в ошибку исчерпанной квоты.

## Швы

`builtInDrivers.ts` (замена драйвера и usage reader), `packages/contracts/src/usage.ts`
(`"kimi"`), `usageProviders.ts`/`UsageLimitsPooled.tsx`, мобильные usage-экраны,
`ProviderInstanceIcon.tsx` (иконка живёт в `ft3-web/kimi`). Строки — в
[fork-boundary.md](../../docs/internals/fork-boundary.md): разделы Kimi.

## Тесты

`pnpm run test`: драйвер, usage/лимиты на моке HTTP и временных credentials, quota failure.
