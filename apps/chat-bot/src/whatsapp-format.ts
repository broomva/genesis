// Markdown -> WhatsApp text (BRO-2267).
//
// THE BUG. The agent writes GitHub-flavoured markdown; `thread.post(chunk)`
// hands WhatsApp a PLAIN STRING, and a plain string is passed through
// VERBATIM. So `## Heading` arrived with its hashes and a GFM table arrived as
// raw `|---|---|` pipes. Measured against the installed adapter, not inferred.
//
// WHY NOT JUST POST `{markdown}`. The adapter DOES convert that shape, and its
// inline handling is right — but `KapsoFormatConverter.nodeToWhatsApp` has no
// `heading` case and no `table` case, so both fall through to a default that
// concatenates children. A table becomes `ab12`: every cell fused, row
// structure destroyed. That is WORSE than the raw pipes we ship today, because
// pipes at least preserve which value sat in which row. Hence our own renderer.
//
// TARGET SYNTAX is taken from the adapter's own mapping, which is the
// authoritative statement of what this channel accepts:
//   *bold*  _italic_  ~strike~  `inline`  ```block```  > quote  label (url)

/** A fenced code block lifted out before any other transform runs.
 *
 *  Protecting these is load-bearing: code is exactly where `**`, `_`, `|` and
 *  `#` appear with no markup meaning, and rewriting them corrupts the one part
 *  of a reply where every character matters. */
interface Vault {
  readonly text: string;
  readonly blocks: string[];
}

// Private Use Area code points, not control characters: no lint rule objects to
// them in a regex, no agent emits them by accident, and they are stripped
// defensively before output regardless.
const CODE_OPEN = "\uE000";
const CODE_CLOSE = "\uE001";
/** Marks text ALREADY destined to be WhatsApp-bold, so the inline pass does not
 *  re-read the asterisks it is about to write. That re-reading WAS the bug:
 *  block conversion emitted `*Title*` and the italic rule rewrote it to
 *  `_Title_`. */
const BOLD_MARK = "\uE002";

function liftCodeBlocks(md: string): Vault {
  const blocks: string[] = [];
  const text = md.replace(/```[\s\S]*?```/g, (m) => {
    blocks.push(m);
    return `${CODE_OPEN}${blocks.length - 1}${CODE_CLOSE}`;
  });
  return { text, blocks };
}

function restoreCodeBlocks(text: string, blocks: string[]): string {
  return text.replace(/\uE000(\d+)\uE001/g, (_m, i) => blocks[Number(i)] ?? "");
}

/** Split a markdown table row into trimmed cells. */
function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());
}

/** Is this the `|---|:--:|` alignment row that follows a table header? */
function isAlignmentRow(line: string): boolean {
  const t = line.trim();
  if (!t.includes("|") || !t.includes("-")) return false;
  return cells(t).every((c) => /^:?-{1,}:?$/.test(c));
}

function isTableRow(line: string): boolean {
  return line.trim().startsWith("|") && line.trim().endsWith("|") && line.includes("|");
}

/** Render one table as labelled blocks rather than columns.
 *
 *  A phone is ~40 characters wide, so a column layout wraps into noise however
 *  it is padded. One block per row, with each cell labelled by its header, is
 *  narrow by construction and loses nothing. The first column leads in bold
 *  because in practice it is the row's name. */
function renderTable(rows: string[][]): string {
  if (rows.length === 0) return "";
  const [header, ...body] = rows;
  if (!header) return "";
  if (body.length === 0) return header.map((h) => `• ${h}`).join("\n");

  return body
    .map((row) => {
      const lead = row[0]?.trim();
      const rest = row
        .slice(1)
        .map((cell, i) => {
          const label = header[i + 1]?.trim();
          const value = cell.trim();
          if (!value) return undefined;
          return label ? `  ${label}: ${value}` : `  ${value}`;
        })
        .filter((l): l is string => Boolean(l));
      // stripInlineEmphasis for the same reason as the heading path: a cell
      // that is ALREADY `**bold**` would otherwise be wrapped again and render
      // as literal `**Main demo**`. Second site of one defect — the shape this
      // repo repeats.
      const head = lead ? `• ${BOLD_MARK}${stripInlineEmphasis(lead)}${BOLD_MARK}` : "•";
      return [head, ...rest].join("\n");
    })
    .join("\n");
}

/** Convert block-level constructs WhatsApp cannot express. */
function convertBlocks(text: string): string {
  const out: string[] = [];
  const lines = text.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    // Table: a row, optionally followed by an alignment row, then more rows.
    if (isTableRow(line) && isAlignmentRow(lines[i + 1] ?? "")) {
      const rows: string[][] = [cells(line)];
      i += 2; // skip header + alignment
      while (i < lines.length && isTableRow(lines[i] ?? "")) {
        rows.push(cells(lines[i] ?? ""));
        i++;
      }
      out.push(renderTable(rows));
      continue;
    }

    // Heading -> bold line. WhatsApp has no headings, but it has emphasis, and
    // dropping the marker without it (which the adapter does) loses the
    // hierarchy entirely.
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const body = heading[2]?.trim() ?? "";
      out.push(body ? `${BOLD_MARK}${stripInlineEmphasis(body)}${BOLD_MARK}` : "");
      i++;
      continue;
    }

    // Bullets: normalise -, * and + to a real bullet character.
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      out.push(`${bullet[1] ?? ""}• ${bullet[2] ?? ""}`);
      i++;
      continue;
    }

    out.push(line);
    i++;
  }
  return out.join("\n");
}

/** Remove emphasis markers from text that is ALREADY being emphasised.
 *
 *  A heading rendered as `*...*` that itself contains `**bold**` would produce
 *  `*a *b* c*`, which WhatsApp renders as broken runs. */
function stripInlineEmphasis(s: string): string {
  return s.replace(/\*\*(.+?)\*\*/g, "$1").replace(/__(.+?)__/g, "$1");
}

/** Convert inline markdown to WhatsApp's inline syntax.
 *
 *  ORDER IS LOAD-BEARING. Markdown's `*x*` is ITALIC while WhatsApp's `*x*` is
 *  BOLD, so the two languages collide on the same character. Double-emphasis is
 *  resolved to a sentinel first, then single-emphasis becomes `_italic_`, and
 *  only then does the sentinel become `*bold*` — otherwise the bold pass eats
 *  one asterisk of each `**` pair and leaves the strays seen on the phone. */
function convertInline(text: string): string {
  return (
    text
      // **bold** / __bold__ -> sentinel
      .replace(/\*\*(.+?)\*\*/gs, `${BOLD_MARK}$1${BOLD_MARK}`)
      .replace(/__(.+?)__/gs, `${BOLD_MARK}$1${BOLD_MARK}`)
      // ~~strike~~ -> ~strike~
      .replace(/~~(.+?)~~/gs, "~$1~")
      // *italic* -> _italic_   (single asterisk only; sentinels are safe)
      .replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/g, "$1_$2_")
      // [label](url) -> label (url)
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1 ($2)")
      // sentinel -> WhatsApp bold, once, after every asterisk rule has run
      .replaceAll(BOLD_MARK, "*")
  );
}

/** Render agent markdown as text WhatsApp will display correctly.
 *
 *  Total and lossless-by-default: anything not recognised passes through
 *  unchanged, because mangling an unrecognised construct is worse than showing
 *  it plainly — which is the whole lesson of the table case. */
export function markdownToWhatsApp(markdown: string): string {
  if (!markdown) return markdown;
  const vault = liftCodeBlocks(markdown);
  const blocks = convertBlocks(vault.text);
  const inline = convertInline(blocks);
  return (
    restoreCodeBlocks(inline, vault.blocks)
      // A leaked sentinel would be invisible garbage on the user's device.
      .replace(/[\uE000-\uE002]/g, "")
      // Collapse the runs of blank lines that block conversion can leave behind.
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd()
  );
}
