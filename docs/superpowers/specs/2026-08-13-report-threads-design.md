# Report threads and the Knox Desk

Staff replies must reach the player. The player gets two surfaces for the same tickets: a website page and an in-game window. The in-game window is a modular shell (Knox Desk) that later pages (shop, and so on) plug into.

## Surfaces

| Surface | Role |
|---|---|
| HUD button | Always visible in-game. Unread badge is the sum of every registered page. Click toggles the Desk. |
| Knox Desk | Collapsible in-game window. Left rail from a page registry. Content hole mounts one page at a time. |
| Reports page (in-game) | First registered page. Stacked list → thread → reply. Game-sized hit targets. |
| `/me/reports` | Signed-in website page. Two-pane list + thread, file a new ticket, search. Web layout. |
| `/admin/reports` | Existing queue. Reply **appends** a staff message and may change status. |

`/report Name details` still files the same ticket. No whispers, no `servermsg`, no chat. Report text stays off the server log.

A staff reply does not steal focus. The HUD badge lights. The player opens the Desk when they want.

Staff handle tickets on the website only.

## Modular in-game UI

Three client files, no shop knowledge in the shell:

- `KR_Desk.lua` — palette, registry (`register({ id, label, order, unread, mount, unmount, tick })`), window frame, rail, content hole.
- `KR_DeskHud.lua` — permanent button. Asks the Desk for `unreadTotal()`.
- `KR_DeskReports.lua` — registers `id = "reports"`. Owns ticket widgets and the ticket file channel on the client.

**Extension rule:** a new feature is a new `KR_Desk*.lua` that calls `KR_Desk.register` on load. The HUD and frame are not edited.

Client files cannot read the dedicated server's Lua folder. Ticket data is pushed with `sendServerCommand`, same as `/report`.

## Data

`player_reports` keeps status, subject, original body, accused.

`player_report_messages` is the thread: `author_role` (`player` | `staff`), `author_username`, optional `staff_id`, `body`, `created_at`.

Filing a report (website, `/report`, or Desk) inserts the opening player message. A staff save with a reply body appends a staff message. A player reply appends a player message and, if the ticket was resolved/rejected, sets status back to `investigating`.

`player_last_read_at` on the report. Unread = a staff message newer than that stamp.

The old `resolution` column is backfilled into a staff message and kept as a copy of the latest staff body so older readers do not break.

## Game file channel

- `tickets_outbox.json` — the mod writes player actions (`reply`, `create`, `read`).
- `tickets_inbox.json` — the API writes per-player snapshots (tickets + messages + unread).
- Server Lua (`KR_Tickets.lua`) drains nothing itself except forwarding: client command → outbox; inbox change → `deskInbox` to that player.

The website talks to Postgres over HTTP. The game never talks HTTP.

## Version lock

Lua changes ship as Knox Relay **1.14**. Source, Workshop package, and the running dedicated server must report 1.14 before the work is done (`AGENTS.md`).
