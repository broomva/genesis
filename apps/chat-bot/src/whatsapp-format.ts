// Markdown -> WhatsApp text (BRO-2267).
//
// THE BUG. The agent writes GitHub-flavoured markdown; `thread.post(chunk)`
// hands WhatsApp a PLAIN STRING, and a plain string is passed through
// VERBATIM. So `## Heading` arrived with its hashes and a GFM table arrived as
// raw `|---|---|` pipes. Measured against the installed adapter, not inferred.
//
// WHY NOT THE ADAPTER'S OWN `{markdown}` PATH. It parses correctly, but
// `KapsoFormatConverter.nodeToWhatsApp` has no `heading` case and no `table`
// case, so both fall to a default that CONCATENATES children. A table becomes
// `ab12`: every cell fused, row structure destroyed — worse than the raw pipes,
// which at least preserve which value sat in which row.
//
// WHY THIS PARSES INSTEAD OF PATTERN-MATCHING. The first cut of this file was a
// regex pipeline, and cross-model review was right to reject it wholesale: a
// regex cannot see that `**literal**` sits inside a code span, that ~~~ and
// longer backtick runs are also fences, that `\*` is escaped, or that `***x***`
// is nested emphasis. Every one of those corrupted output. Parsing resolves
// them all, and needs no sentinels, no vault and no escaping rules of its own.
//
// NOTE WHICH PARSER. NOT the adapter's `toAst`, which parses PLATFORM text —
// WhatsApp text, where `*x*` is BOLD. That is the inverse direction, and
// feeding it markdown silently reads every italic as a bold: `a *b* c`
// round-tripped to `a *b* c` rather than `a _b_ c`. This uses
// mdast-util-from-markdown with the GFM extension, which is what actually
// speaks the language the agent writes.
//
// TARGET SYNTAX comes from the adapter's own mapping, the authoritative
// statement of what this channel accepts:
//   *bold*  _italic_  ~strike~  `inline`  ```block```  > quote  label (url)

import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

/** Minimal mdast shape. Structural rather than importing mdast types: the
 *  parser is an implementation detail of the adapter, and a node we do not
 *  recognise must degrade, never throw. */
interface Node {
  readonly type: string;
  readonly value?: string;
  readonly url?: string;
  readonly alt?: string;
  readonly title?: string;
  readonly label?: string;
  readonly identifier?: string;
  readonly ordered?: boolean;
  readonly start?: number;
  readonly checked?: boolean;
  readonly children?: readonly Node[];
}

function kids(n: Node): readonly Node[] {
  return n.children ?? [];
}

function inlineAll(ns: readonly Node[]): string {
  return ns.map(inline).join("");
}

/** Render inline content. */
function inline(n: Node): string {
  switch (n.type) {
    case "text":
      return n.value ?? "";
    case "inlineCode":
      // The parser having made this its own node is exactly why the regex
      // version was wrong: nothing inside may be reinterpreted as markup.
      return `\`${n.value ?? ""}\``;
    case "strong":
      return `*${inlineAll(kids(n))}*`;
    case "emphasis":
      return `_${inlineAll(kids(n))}_`;
    case "delete":
      return `~${inlineAll(kids(n))}~`;
    case "break":
      return "\n";
    case "link": {
      const label = inlineAll(kids(n));
      const url = n.url ?? "";
      return label && label !== url ? `${label} (${url})` : url;
    }
    case "image":
      return n.url ?? inlineAll(kids(n));
    default:
      return inlineAll(kids(n)) || (n.value ?? "");
  }
}

/** Render inline content WITHOUT emphasis markers.
 *
 *  `*a *b* c*` renders as broken runs on WhatsApp, so a heading or table lead
 *  containing bold must not nest. The first attempt stripped `*` and `_` from
 *  the RENDERED string, which cannot tell a marker this module emitted from an
 *  underscore that is literal content: a heading containing `snake_case_name`
 *  came out as `snakecasename`. Silent data corruption, and worse than the raw
 *  markdown this whole change exists to replace. (P20 BLOCKER.)
 *
 *  Walking the tree instead makes the distinction structural: emphasis nodes
 *  contribute their children and no markers, while text nodes are emitted
 *  verbatim, underscores and all. */
function plain(n: Node): string {
  switch (n.type) {
    case "text":
      return n.value ?? "";
    case "inlineCode":
      return `\`${n.value ?? ""}\``;
    case "strong":
    case "emphasis":
    case "delete":
      return plainAll(kids(n));
    case "link":
      return plainAll(kids(n)) || (n.url ?? "");
    case "break":
      return " ";
    default:
      return plainAll(kids(n)) || (n.value ?? "");
  }
}

function plainAll(ns: readonly Node[]): string {
  return ns.map(plain).join("");
}

/** One table row as a labelled block.
 *
 *  Not columns: a phone is about forty characters wide, so any column layout
 *  wraps into noise however it is padded. One block per row, each cell labelled
 *  by its header, is narrow by construction and loses nothing. A cell with no
 *  header — a ragged row with more cells than columns — is still emitted under
 *  an ordinal label, because dropping data silently is the failure this whole
 *  arc is about. */
function renderRow(header: readonly Node[][], row: readonly Node[][]): string {
  const [lead, ...rest] = row;
  // plainAll, not string surgery: the lead keeps its own underscores while
  // contributing no emphasis markers of its own.
  const leadText = lead ? plainAll(lead).trim() : "";
  // The FIRST column's header is deliberately not emitted: the lead cell is the
  // row's identity, and prefixing every row with `What: ` (the usual name of
  // that column) is redundant noise on a narrow screen. Every other header IS
  // emitted, as the label for its value.
  const head = leadText ? `• *${leadText}*` : "•";
  const lines = rest
    .map((cell, i) => {
      const value = inlineAll(cell).trim();
      if (!value) return undefined;
      const label = header[i + 1] ? plainAll(header[i + 1] as Node[]).trim() : "";
      return label ? `  ${label}: ${value}` : `  ${i + 2}: ${value}`;
    })
    .filter((l): l is string => Boolean(l));
  return [head, ...lines].join("\n");
}

function renderTable(n: Node): string {
  // Cells are kept as NODES, not pre-rendered strings, so the lead and the
  // header labels can be rendered marker-free without string surgery.
  const rows: Node[][][] = kids(n).map((r) => kids(r).map((c) => [...kids(c)]));
  const [header, ...body] = rows;
  if (!header) return "";
  if (body.length === 0) return header.map((h) => `• ${plainAll(h)}`).join("\n");
  return body.map((r) => renderRow(header, r)).join("\n");
}

function renderList(n: Node, depth: number): string {
  const indent = "  ".repeat(depth);
  return kids(n)
    .map((item, i) => {
      // Ordered lists keep their numbers; a bullet would discard the ordering
      // the author meant.
      // `start` matters: a list beginning at 5 must not be renumbered to 1.
      const start = typeof n.start === "number" ? n.start : 1;
      const checkbox = item.checked === true ? "[x] " : item.checked === false ? "[ ] " : "";
      const marker = n.ordered ? `${start + i}.` : "•";
      const parts = kids(item)
        .map((child) =>
          child.type === "list" ? renderList(child, depth + 1) : block(child, depth),
        )
        .filter((p) => p !== "");
      const [first, ...rest] = parts;
      return [`${indent}${marker} ${checkbox}${first ?? ""}`, ...rest].join("\n");
    })
    .join("\n");
}

/** Render a block-level node. */
function block(n: Node, depth = 0): string {
  switch (n.type) {
    case "heading":
      // WhatsApp has no headings but does have emphasis. Dropping the marker
      // without it — which the adapter does — loses the hierarchy entirely.
      return `*${plainAll(kids(n))}*`;
    case "paragraph":
      return inlineAll(kids(n));
    case "code": {
      // A fence must be LONGER than the longest backtick run it contains, or
      // embedded ``` closes it early and the rest of the block escapes as
      // formatted text. (P20 BLOCKER.)
      const body = n.value ?? "";
      const longest = Math.max(0, ...[...body.matchAll(/`+/g)].map((m) => m[0].length));
      const fence = "`".repeat(Math.max(3, longest + 1));
      return `${fence}\n${body}\n${fence}`;
    }
    case "blockquote":
      return kids(n)
        .map((c) => block(c, depth))
        .join("\n\n")
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n");
    case "list":
      return renderList(n, depth);
    case "table":
      return renderTable(n);
    case "thematicBreak":
      return "---";
    case "html":
      // Raw HTML has no WhatsApp equivalent; showing it beats guessing.
      return n.value ?? "";
    default:
      return kids(n).length > 0 ? inlineAll(kids(n)) : (n.value ?? "");
  }
}

/** Render agent markdown as text WhatsApp will display correctly.
 *
 *  Total: a parse failure returns the input unchanged, because shipping the
 *  original beats shipping nothing, and an unrecognised construct is rendered
 *  plainly rather than mangled — the lesson the table case taught. */
export function markdownToWhatsApp(markdown: string): string {
  if (!markdown.trim()) return markdown.trim();
  try {
    // A REAL GFM parser, not the adapter's `toAst`. That one parses PLATFORM
    // text, where `*x*` is bold — the inverse direction — so feeding it
    // markdown silently reads every italic as a bold. Measured: `a *b* c`
    // round-tripped to `a *b* c` instead of `a _b_ c`.
    const ast = fromMarkdown(markdown, {
      extensions: [gfm()],
      mdastExtensions: [gfmFromMarkdown()],
    }) as unknown as Node;
    const out = kids(ast)
      .map((n) => block(n))
      .filter((s) => s !== "")
      .join("\n\n");
    // NO global newline compaction. Blocks are already joined with exactly one
    // blank line, and a global pass would rewrite blank lines INSIDE a fenced
    // block — silently altering code, which is the one place every character
    // matters. (P20 BLOCKER.)
    return out.trimEnd() || markdown.trim();
  } catch {
    return markdown;
  }
}

/** Overhead balanceFences may add to a chunk: a reopening fence plus a closing
 *  one. Callers MUST reserve this below the transport cap, or balancing turns a
 *  maximum-length chunk into an over-length one that WhatsApp rejects — the
 *  reply then vanishes, which is the failure mode this channel is least able to
 *  diagnose. (P20 BLOCKER.) */
export const FENCE_OVERHEAD = 10;

/** Does this text end inside an unclosed fence?
 *
 *  Counts fence LINES rather than ``` substrings: a substring count misreads
 *  ```` (which is one fence, not one-and-a-bit) and counts a ``` that appears
 *  inside inline code. A fence in CommonMark is a run of three or more
 *  backticks or tildes at the start of a line. */
export function endsInsideFence(text: string): boolean {
  const fences = text.split("\n").filter((l) => /^\s{0,3}(`{3,}|~{3,})/.test(l));
  return fences.length % 2 === 1;
}

/** Close an open fence at a chunk boundary and reopen it in the next chunk.
 *
 *  Chunking runs AFTER rendering, so a long fenced block can straddle two
 *  WhatsApp messages. Each message is rendered independently by the client, so
 *  a chunk ending mid-fence shows an unmatched ``` and the chunk after it loses
 *  its monospace entirely. Balancing per chunk keeps both halves readable as
 *  code. Review called this a BLOCKER and was right — I had written the split
 *  off as cosmetic, which is true of a bold run and false of a fence. */
export function balanceFences(chunks: readonly string[]): string[] {
  const out: string[] = [];
  let carryOpen = false;
  for (const chunk of chunks) {
    const opened = carryOpen ? `\`\`\`\n${chunk}` : chunk;
    const stillOpen = endsInsideFence(opened);
    out.push(stillOpen ? `${opened}\n\`\`\`` : opened);
    carryOpen = stillOpen;
  }
  return out;
}
