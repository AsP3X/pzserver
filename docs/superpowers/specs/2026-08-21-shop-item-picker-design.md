# Item picker for the shop catalogue

Adding a shop listing means typing a Project Zomboid item ID into a text box.
`Base.Axe` is easy; the other five thousand are not. There is no autocomplete,
no validation, and no way to discover an ID without leaving the panel — and a
typo produces a listing that takes a player's coins and delivers nothing,
because `additem` fails silently on an ID the server does not know.

So: replace the text box with a button that opens a searchable dialog over
every item the server actually has, modded ones included.

## The catalogue already exists

Knox Relay writes it. `KR_Catalog.export()` runs once at boot, walks
`ScriptManager:getAllItems()`, and writes `Lua/items_catalog.json`.

| Fact | Value |
|---|---|
| Items in the current export | 5,092 |
| File on disk | 762 KB |
| Trimmed to `full_type`, `name`, `category` | 344 KB |
| Same, gzipped over the wire | 75 KB |
| Distinct PZ display categories | 82 |

Modded items need no special handling. `getAllItems()` is the running server's
own registry, so whatever a loaded mod defines is in the file — that is why the
mod reads it from `ScriptManager` at runtime instead of shipping a static list.
The comment at the top of `KR_Catalog.lua` says the dashboard would use this
for item autocomplete and shop entries. Nothing has, until now.

Boot is the right and only time to export. The set of registered items changes
when mods change, and changing mods requires a server restart. There is no
staleness window to close and no refresh button to build.

Neither the Rust API nor the UI reads the file today. Everything below is that
missing half.

## Data path

```
KR_Catalog.export()                  server boot
  → data/zomboid/Lua/items_catalog.json
  → /lua-bridge in web-api           already mounted
  → LuaBridge::items_catalog()       new reader
  → ItemCatalogService               new, mtime-keyed cache
  → GET /api/v1/admin/items          new admin route
  → React Query, session-cached
  → <ItemPickerDialog>               new component
  → ItemFields item_type button      changed
```

No mod change. No new bind mount — `${PZ_DATA_HOST}/Lua` is already mounted
into `web-api`. No new npm dependency.

## Where the search runs

In the browser, over the whole list, fetched once.

The alternative was a server-side `?q=` endpoint returning the top N. It keeps
payloads tiny, but it puts a debounced round trip behind every keystroke and
moves the scorer into Rust, where tuning it against what feels right in the box
is slower. At 75 KB gzipped for the entire catalogue, that trade buys nothing.
One fetch per admin session, then matching is local and instant.

## API

**`pz-bridge/src/catalog.rs`** — `ItemCatalogExport { item_count, items }`,
where each entry carries `full_type`, `name`, and `category`. The mod's
`icon_name` and `texture_icon` are deserialised away; nothing in the panel
renders item art, and two unused fields in the payload would be weight carried
for a feature that does not exist.

`LuaBridge::items_catalog()` delegates to the existing `read_export`, so it
inherits the established contract: a missing file and a zero-byte file both
read as `None` rather than as an error. That matters here — `data-init` writes
zero-byte placeholders over missing exports, and a fresh server has not booted
the mod yet.

**`pz-api/src/services/items.rs`** — `ItemCatalogService`, holding the bridge
and a `tokio::sync::RwLock<Option<Cached>>`, shaped after `StatusService` and
`Arc`'d into `AppState` the same way.

The cache is keyed on the file's **mtime**, not a TTL. `StatusService` uses a
TTL because server status changes on its own; this file changes only at boot.
So: stat the file, compare against the cached mtime, and on a match return an
`Arc<[ItemCatalogEntry]>` clone without re-reading or re-parsing 762 KB. A stat
per request is cheap; parsing three quarters of a megabyte per request is not.

**`GET /api/v1/admin/items`** in `routes/admin.rs`, behind the `AdminUser`
extractor like its neighbours. Returns `{ "items": [...] }`.

A missing catalogue returns `200` with an empty array, never a 5xx. The panel
must stay usable when the game server is cold, and "the catalogue has not been
written yet" is a state to render, not a failure to report.

## The dialog

New `components/ui/item-picker.tsx`, exporting `ItemPickerDialog`.

It is its own native `<dialog>` rather than a `ConfirmDialog`. `ConfirmDialog`
puts its content in a `description` slot above a confirm/cancel footer, which
is the wrong shape for a live-filtering list: the confirm button has nothing to
confirm, and the body needs to be a flex column with its own scroll region.

Nesting is legal and works. The add-listing dialog is itself a modal
`<dialog>`; the top layer is a stack, so the picker opens above it, and a
`cancel` event from Escape fires only on the topmost dialog. The outer form
does not close behind it. Verify in the browser rather than trusting the spec.

Top to bottom: an autofocused search input, a scrollable result list, and a
pinned manual-entry row.

Each result row shows the display name, the `full_type` in mono, and the PZ
category as a tag. Clicking a row selects and closes.

An empty query lists the first 100 items by name under a `5,092 items — type to
search` hint, so the dialog is never blank on open. Matches render capped at
100 as well; nobody scrolls past a hundred results, and rendering five thousand
rows to prove a point costs frames.

Keyboard is not optional at this size. ↑/↓ move the highlight, Enter picks the
highlighted row, Escape closes. The highlight resets to the first row whenever
the query changes.

When the catalogue is empty the list area explains that it is written when the
server boots with Knox Relay. The manual-entry row is present regardless, so
this state informs rather than blocks.

### Manual entry

A `use this ID` row pinned under the results, accepting any string and applying
it as `item_type` directly.

It exists so the picker can never lock staff out — not only in the empty-
catalogue case, but also when adding a listing for a mod that is queued for
installation but not yet loaded. Replacing a free-text field with a constrained
one always needs the escape hatch, or the constrained one becomes the bug.

## In the form

`ItemFields` is shared by the add-listing dialog and the edit form, so changing
it once covers both, which is what we want: the same field should not behave
differently depending on which form it is in.

The `item_type` `<Field>` becomes a button in the same field chrome and under
the same `economy.item_type` label, so the form does not go lopsided. The
button shows the display name resolved from the catalogue plus the raw ID in
mono; it falls back to the bare ID when the catalogue does not know it, and to
a placeholder when the value is blank.

The quest editor has the same raw-ID field. It is out of scope here. The picker
is built as a standalone component so that adding it there later is a two-line
change.

### Prefill

On select, set `item_type` — always — and set `name` to the item's display name
**only when `name` is currently blank**, in the same patch.

That conditional is the whole point. On a new listing the name field is empty,
so picking Fire Axe fills in "Fire Axe" and saves a retype. On an edit the name
is already whatever staff chose to call it, possibly deliberately not the
vanilla name, and picking a different item must not overwrite it.

Category is deliberately **not** prefilled. The catalogue has 82 PZ display
categories against the shop's seven, the mapping would be guesswork, and modded
categories would not map at all. A wrong category silently applied is worse
than a category the admin picks.

## Matching

A small scorer in `lib/`, roughly forty lines, no dependency. `web/ui` has
twelve runtime dependencies and no fuzzy-search library; adding one to rank
five thousand short strings would not pay for itself.

Case-insensitive, matched against both the display name and the `full_type`.
Scoring, best first:

1. Exact `full_type` match
2. Query is a prefix of the display name
3. Every query token appears as a substring, in either field
4. Query characters appear in order as a subsequence

Ties break on shorter display name, so `Axe` outranks `Axe Handle` for `axe`.
Both `fireax` and `base.ax` must find the Fire Axe — the first through the
subsequence rule, the second through the token rule against `full_type`.

## Translations

New keys go in **`en.json` and `de.json`**.

CLAUDE.md says the second locale is Georgian (`ka.json`). The repository ships
German. The instruction is stale; the files are the truth. Worth correcting in
CLAUDE.md separately, not as part of this change.

## Testing

Rust, inline `#[cfg(test)] mod tests` using the existing `bridge_with(file,
contents)` fixture:

- a missing file reads as `None`
- a zero-byte file reads as `None`
- a valid export parses to the expected entries
- unknown fields in the export are ignored, so a future mod version that adds
  a field does not break the reader
- a second read with an unchanged mtime does not re-parse
- a read after the mtime changes returns the new contents

The scorer's ranking is worth testing, but `web/ui` has no test runner and this
change does not justify introducing one. The dialog and the ranking get
verified in the browser preview instead: search behaviour, keyboard navigation,
nested-Escape, the prefill conditional on both forms, and the empty-catalogue
state.

## Out of scope

The quest editor's item field, item icons in the picker, category prefill, an
on-demand catalogue refresh, and any change to Knox Relay.
