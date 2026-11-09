# Yuanta settlement calendar

Status: Current

Yuanta overseas (複委託) trades settle against the foreign-currency deposit on Taiwan business days: a buy one business day after the trade, a sell two. Yuanta Trade's stock report has no settlement-date column, so the App computes the date from the Taiwan government office calendar (行政院人事行政總處 政府行政機關辦公日曆表). Only an exact calendar decides which trades net into one bank debit. Matching debits inside a date window was tried in [#406](https://github.com/WangWilly/OctopusBeak/pull/406) and paired trades with the wrong debit.

The calendar lives in the generated block of `src/ledger/canonical/yuanta-foreign-settlement-calendar.ts`. Each year lists its weekday closures, its weekend make-up workdays (補行上班), and the SHA-256 of the DGPA file it came from. When a settlement walk reaches a day after the covered years, the whole investment relation resolution call fails with `YuantaSettlementCalendarNotCoveredError`, and the workflow run reports a `relation-failed` diagnostic. The call rolls back, so no investment funding relation in its scope changes until the next year is added. That covers every settlement group of the call's source connection, or of every connection when the call names none, including `source-linked-account` groups that do not use this calendar. A trade whose walk reaches a day before the coverage is not an error: its group is reported as `no-admission` with reason `settlement-calendar-not-covered`.

## When

`yuanta-foreign-settlement-calendar-expiry.check.ts` fails once fewer than 120 days of coverage remain. It runs in the PR Tests unit lane, and the `Settlement calendar expiry` workflow runs it on main and every Monday. DGPA usually publishes the next year's calendar in May or June, about three months before the 120-day mark in early September, so add the year as soon as it is published.

## Add a year

1. On <https://www.dgpa.gov.tw/>, open 民眾 > 辦公日曆表 and select 「中華民國 N 年政府行政機關辦公日曆表」, where N = year − 1911. Copy the link of the `.xlsx` attachment (「N年辦公日曆表.xlsx」). Do not use the PDF, ODS, or GIF version.
2. Run the generator with the Gregorian year and the link or a downloaded copy:

   ```bash
   npm run generate:yuanta-settlement-calendar -- 2028 "<.xlsx URL or path>"
   ```

   It prints the number of weekday closures and make-up workdays and rewrites only that year's entry.
3. Compare the printed closures with the holiday list in the DGPA announcement text on the same page. Check every observed day (補假) and make-up workday (補行上班) against it.
4. Add the file as `scripts/fixtures/dgpa/dgpa-N.xlsx`, then add it to the reproduction check in `scripts/generate-yuanta-settlement-calendar.check.mjs`.
5. Run the checks, then open a pull request:

   ```bash
   node --test scripts/generate-yuanta-settlement-calendar.check.mjs
   ```

   ```bash
   node --no-warnings --experimental-strip-types --test src/ledger/canonical/yuanta-foreign-settlement-calendar.check.ts src/ledger/canonical/yuanta-foreign-settlement-calendar-expiry.check.ts
   ```

`yuanta/foreign-settlement/calendar-v2` is a label in the module, not a value stored with relations. Every resolution recomputes settlement dates, so a regenerated year changes only the resolutions that follow. If DGPA revises a year that is already covered, run the generator for that year again. A relation already observed under a moved date is not withdrawn automatically, because its old settlement group no longer comes up. Name the moved dates in the pull request and check the relations that settled on them.

## When the generator refuses the file

The generator stops with `GovernmentCalendarLayoutError` instead of writing a partial year. It refuses a sheet when:

- the file is not a zip package, has an encrypted entry, uses compression other than stored or deflate, or fails a checksum;
- the package has more or fewer than one worksheet, or no styles;
- the title year differs from the requested year;
- it does not find four quarter blocks, or the blocks do not hold three months in the same columns;
- a month label is wrong, a day is missing or duplicated, or a day sits outside its weekday's column;
- the Sundays do not share one fill, or are unfilled;
- any day has a fill other than the Sunday day-off fill or none;
- fewer than 200 weekdays are open.

A refusal means the DGPA layout changed. Read the sheet, update the parser in `scripts/generate-yuanta-settlement-calendar.mjs`, and add the new shape to its check. Do not edit the generated block by hand.
