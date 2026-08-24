---
name: whatsapp-channel
description: >-
  The shape of the channel you are answering through when this workspace is
  reached over WhatsApp. Read it before composing a long reply, before deciding
  to write a report or artifact, and any time you are about to say "I've created
  X" — because what reaches the person is a phone message, not a terminal.
---

# You are answering on WhatsApp

Someone is reading you **on a phone, in a chat app**. Not a terminal, not a
browser. That constrains what arrives, and it is the difference between a useful
answer and one that technically completed.

Everything below is measured against the running integration, not assumed.

## The reply is the deliverable

**You cannot send files. There is no attachment path from here.** A file you
write to disk is real, and the person cannot open it, cannot see it, and has no
way to ask for it.

So a message that ends *"I've generated `out/report.html` — want me to walk you
through it?"* is a dead end. It reads like progress and delivers nothing. This
has actually happened: an agent produced a 10 KB HTML report, announced it, and
the operator had no route to the contents.

What to do instead:

- **Put the answer in the message.** The findings, the numbers, the decision —
  not a pointer to where they live.
- Write the file too if it is genuinely useful to the repo. Just never let it be
  the *only* place the answer exists.
- If the result is inherently large, lead with the part that answers the
  question and offer to go deeper, rather than deferring all of it to an
  artifact.

## Your markdown is rewritten before it is sent

WhatsApp does not speak markdown. Replies are converted, and conversion is lossy
in ways worth writing around:

| You write | They see |
|---|---|
| `**bold**` | `*bold*` (bold) |
| `*italic*` | `_italic_` (italic) |
| `~~strike~~` | `~strike~` |
| `` `code` `` and ``` fences | preserved as monospace |
| `# Heading` | a **bold line** — there are no headings |
| a GFM table | one labelled block per row, not columns |
| `- item` | `• item` |
| `[label](url)` | `label (url)` |

Consequences for how you write:

- **There are no headings.** Structure with short paragraphs and bold lead-ins.
  A six-level outline flattens into undifferentiated bold lines.
- **Tables become vertical.** Each row turns into a bullet with labelled fields,
  because a phone is about forty characters wide and columns wrap into noise. A
  three-column table reads fine. A nine-column one becomes a wall.
- **Prefer prose and short bullets** over elaborate layout. Layout is the thing
  that does not survive.

## Long replies arrive in pieces

A reply longer than about a thousand characters is split into **several separate
messages**, in order. That is a deliberate choice — a single 4000-character
bubble is unreadable on a phone — but it means:

- a very long answer arrives as a stack of notifications
- **length has a real cost here** that it does not have in a terminal
- front-load the conclusion; someone reading on a phone may not reach the end

## You can only reply, and only for 24 hours

WhatsApp permits free-form messages only **within 24 hours of the person's last
message to you**. Outside that window the send fails and *they see nothing*.

- You cannot start a conversation.
- You cannot notify someone later that a long job finished.
- **Do not design anything that depends on reaching them unprompted** — no "I'll
  message you when this completes". If work outlives the turn, say so, and let
  them come back and ask.

## Practical shape of a good reply here

- Lead with the answer. The first line should carry the conclusion.
- Bold the few phrases that matter; do not bold whole sentences.
- Keep code in fences — monospace survives intact and is genuinely readable.
- Prefer three short paragraphs to one long one.
- If you did something with side effects (wrote files, ran a command, changed
  state), say what changed in the message itself.
