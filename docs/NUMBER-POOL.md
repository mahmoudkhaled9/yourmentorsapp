# Number Pool

Numbers uploaded by an administrator wait in a shared pool until an **agent** requests a batch of 5, 10 or 20. Every
number of the batch then belongs to that agent until they record a call result, or a manager above them hands it back.

## Privacy rule (enforced by the API, not by the screens)

> An employee sees their own pool records. Their managers see the records of everyone below them in their own
> reporting tree (`users.parent_id`). Nobody else sees those detailed records.

- The tree is walked from the signed-in user's id (from the token). There is **no role bypass**: two team leaders,
  two managers or two heads of sales never see each other's teams, and an `admin` / `franchise_owner` who is not an
  ancestor in the tree sees **no** employee-level pool record (phones, requirements, batches, history, report rows).
- A `ceo` placed at the top of the tree (every head of sales reports to them) therefore sees the whole company.
- Deactivated people stay in the tree, so their managers keep seeing their history.
- Every list, detail, search, filter, page, report and export applies the scope **in SQL** before returning rows.
  `userId` / `batchId` / `q` query parameters can only narrow what the caller may see. Owner ids in a request body are
  ignored: a batch always belongs to the caller.
- A record outside the caller's tree answers **404** (the same as a missing id), so its existence is not confirmed.
  Inside the tree, an action the caller may not take answers **403** (for example an agent releasing their own batch).
- Administrators get `GET /api/pool/summary` instead: company-wide counts and the list of uploads, with no phone
  numbers, client names or per-agent rows.

This rule applies to the Number Pool only. Leads, Cold Calls, Call History and the existing Reports keep their current
rule (the reporting tree, plus full visibility for `admin` and `franchise_owner`), as the owner decided on 2026-11-16.

## Roles

`ceo` and `head_of_sales` were added (2026-11-16). Like `director`, `sales_manager`, `sales_supervisor` and
`team_leader`, they see their own subtree and may assign inside it. They get no administrator rights. Only `agent`
requests pool batches. Commission is still for agents only.

## Workflow

| Step | Who | Endpoint |
|---|---|---|
| Upload numbers (Upload Data → "Number Pool") | admin, franchise owner | `POST /api/pool/import` `{ fileName, rows: [{ name, phone, fields }] }` |
| See my batch, sizes, results, waiting count | everyone | `GET /api/pool/me` |
| Request a batch (one open batch at a time) | agent | `POST /api/pool/batches` `{ size: 5 \| 10 \| 20 }` |
| Record the call result | the agent holding the number | `POST /api/pool/items/:id/process` `{ outcome, notes }` |
| Hand uncalled numbers back / cancel the batch | a manager above the agent | `POST /api/pool/batches/:id/release` `{ itemIds? }`, `POST /api/pool/batches/:id/cancel` |
| Numbers & history (also the source of the Excel / PDF export) | own + subtree | `GET /api/pool/items?userId&batchId&state&outcome&q&from&to&page&pageSize` (max 5000), `GET /api/pool/items/:id` |
| Batches | own + subtree | `GET /api/pool/batches?userId&status&page&pageSize`, `GET /api/pool/batches/:id` |
| Report per person + totals | own + subtree | `GET /api/pool/report?from&to&userId` |
| Company totals | admin, franchise owner | `GET /api/pool/summary` |

Results: `lead` creates a lead owned by the agent with the uploaded requirements, and `cold_call` creates a cold call.
The other results are `no_answer`, `not_interested` and `wrong_number`. A converted record gets one comment containing
the call note plus every uploaded requirement and extra column. From then on it follows the normal Leads / Cold Calls
rules.

Duplicates are skipped on import when the phone number is already in the pool, in Leads or in Cold Calls. Recognised
columns are read into fields: Destination, Budget (`3M - 5M`, `5,000,000`, `750k`), Property Type, Delivery, Finishing,
Purpose of Purchase, Down Payment and Installments. **Every** column is also kept verbatim, so nothing in the upload
is lost.

## Data (migration `010_number_pool`, tables in `schema.sql`)

- `pool_imports`: one row per upload (file name, uploader, count, time).
- `pool_numbers`: the number, its requirements and original columns, and its current state
  (`available` / `allocated` / `processed`, `user_id`, `batch_id`, `allocated_at`, `processed_at`).
- `pool_batches`: owner (`user_id`), `requested_by` (always the same agent), sizes, `status`, and the
  completed / cancelled times plus who cancelled.
- `pool_batch_items`: the **allocation history**, one row per (batch, number). It is never deleted. Its end is recorded
  once: `ended_at`, `end_reason` (`processed` / `released` / `cancelled`), `ended_by`, `outcome`, `notes`, and the
  lead / cold call it created. Releasing a number returns it to the pool, but the item keeps who had it, when, and who
  took it back.
- The indexes cover ownership and reporting: owner + status, owner + allocation time, batch + open state, and
  available numbers by id. Allocation uses `SELECT … FOR UPDATE` row locks, so two agents can never receive the same
  number.
- Someone who ever held pool numbers cannot be deleted (409 `HAS_POOL_HISTORY`); deactivate them instead.
- Rollback (manual, after a backup): `DROP TABLE pool_batch_items, pool_numbers, pool_batches, pool_imports;` then
  `DELETE FROM schema_migrations WHERE id = '010_number_pool';`

## Tests

- `test/integration/numberPool.test.js` (21 tests) uses a seven-level tree (CEO → heads of sales → director →
  managers → supervisor → team leaders → agents) plus an admin and a franchise owner outside it. It covers all 16
  required permission cases, ownership, requirements, processing, release / cancel history, concurrent requests and
  import rules.
- `test/unit/pool.test.js`: upload column parsing.
- `mentorsfront/e2e/tests/pool.test.mjs`: the agent, teammate, team leader and administrator in a real browser.
