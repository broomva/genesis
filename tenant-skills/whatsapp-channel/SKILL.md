---
name: whatsapp-channel
description: >-
  What the WhatsApp channel does to your reply, and what it cannot carry. Read
  before composing a long answer, and before deciding that a file is the
  deliverable — what reaches the person is a chat message, not a terminal.
---

# The WhatsApp channel

Facts about what happens to a reply between you and the person reading it. All
of it is measured against the running integration; none of it is advice.

## You cannot send files

`PostableThread` exposes `post(string | AsyncIterable<string>)` and nothing
else. There is no attachment path from this workspace.

A file you write to disk is real and the person cannot open it. So a reply whose
substance lives in `out/report.html` delivers nothing — **the message is the only
thing that arrives.** Write the file if it is useful to the repo; just never let
it be the only place the answer exists.

## Your markdown is rewritten

The reply is parsed as GitHub-flavoured markdown and re-rendered into WhatsApp's
own syntax. Verified conversions:

| You write | They receive |
|---|---|
| `**bold**` | `*bold*` |
| `*italic*` | `_italic_` |
| `***both***` | `_*both*_` |
| `~~strike~~` | `~strike~` |
| `` `code` `` | unchanged |
| ```` ```lang ```` fence | fence kept, **the language identifier is dropped** |
| `# Heading` (any level) | a bold line — there are no headings |
| `- item` | `• item` |
| `1. item` | numbering kept, including a list that starts at 5 |
| `- [x] done` | `• [x] done` — the checkbox stays literal text |
| `> quote` | unchanged, WhatsApp uses the same syntax |
| `[label](url)` | `label (url)` |
| `[url](url)` | collapses to the bare url |
| `![alt](url)` | **the bare url — alt text is lost** |
| a GFM table | see below |

Anything not recognised passes through **unchanged** rather than being mangled.

### Tables specifically

A table becomes one block per row, not columns:

- the **first column** becomes a bold lead and its header is **not** shown — the
  lead is the row's identity
- every other cell is labelled with its column header
- an **empty cell is omitted entirely**, label and all
- a row with more cells than headers labels the extras by position
- a header-only table (no body rows) becomes a plain bullet list of the headers

This is why a wide table reads poorly here: every column becomes another labelled
line under every row.

## Long replies are split

`CHUNK_TARGET` is 1000 characters; the hard transport cap is **4096**, above
which a message is rejected outright. The rendered path reserves ten characters
for fence balancing, so the effective split is ~990.

A longer reply is therefore delivered as **several separate messages**, in order,
each one a separate notification. If a fenced code block spans a split, the fence
is closed and reopened so both halves stay monospace.

## You can only reply, and only for 24 hours

Free-form messages are permitted only within **24 hours of the person's last
message to you** (Meta error `131047`, category `reengagementWindow`). Outside
that window the send fails and **they see nothing**.

- There is no path that starts a conversation: every dispatch begins from an
  inbound message.
- Within an active turn you can take as long as you need — a long-running job's
  result is posted when it finishes.
- What you cannot do is reach them **after the turn ends**. Work that outlives
  the turn has no callback path, so nothing may be designed around notifying
  them later.
