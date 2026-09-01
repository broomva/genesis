// The deployment model, asserted across every document that states it.
//
// BRO-2412 existed because these files described incompatible deployments and
// nothing compared them. The measurement that settled it is committed and
// re-runnable: `scripts/funnel-scope-probe.sh <host> [port]`.
//
// Its discriminator is the BYTE COUNT, not the status. Hono's 404 body is
// "404 Not Found" (13 bytes); tailscaled's Go `http.NotFound` is
// "404 page not found" (19 bytes). A 19-byte 404 means the funnel declined to
// route the path and the request never reached Genesis — which is the scoping
// claim. The script also prints `remote_ip`, because MagicDNS resolves the
// funnel hostname to the TAILNET and a plain curl measures the wrong path
// entirely.

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Every file that tells an operator how to expose this server. */
/** Every tracked file that mentions tailscale — DERIVED, not hand-listed.
 *
 *  The list was three files while ten in the repo mention tailscale, and nothing
 *  asserted it was complete: a root-funnel command added to
 *  `docs/deploy/systemd/README.md` passed every gate because that file was not on
 *  the list. A hand-maintained scope is a hole that widens by omission. */
const INSTRUCTIONS: readonly string[] = Bun.spawnSync(["git", "ls-files"], { cwd: ROOT })
  .stdout.toString()
  .split("\n")
  .map((f) => f.trim())
  // Widened after the derived scan still missed `docs/deploy/systemd/*.service.template`
  // — tracked, already mentioning tailscale, and sitting in the very directory this
  // guard's own comment names. A unit file is where a funnel command idiomatically
  // goes. Dropping the extension filter entirely is NOT the fix: this test file then
  // scans itself and flags its own quoted evasions.
  .filter(
    (f) =>
      /\.(md|mdx|sh|bash|example|yml|yaml|template|service|timer|plist|conf|toml|txt)$/.test(f) ||
      /(^|\/)(Dockerfile|Makefile)$/.test(f),
  )
  .filter((f) => {
    try {
      return /tailscale/i.test(read(f));
    } catch {
      return false;
    }
  })
  .sort();

/** Report the offending LINE, never the whole file. A failure that prints a
 *  24KB source blob is a failure nobody reads. */
const lineWith = (body: string, re: RegExp) => {
  const hit = body.split("\n").findIndex((l) => re.test(l));
  return hit === -1 ? "<absent>" : `${hit + 1}: ${body.split("\n")[hit]?.trim()}`;
};

describe("no shipped instruction tells an operator to funnel the root", () => {
  test("the files under test exist and are non-empty", () => {
    for (const f of INSTRUCTIONS) expect(`${f}:${read(f).length > 0}`).toBe(`${f}:true`);
  });

  for (const f of INSTRUCTIONS) {
    // BEST-EFFORT, and stated as such. A prose check over natural language cannot
    // be made airtight: a sanctioned phrase can always be placed in the same
    // sentence as a live instruction ("Funnel the root: funnelling the root
    // publishes /voice fine." still passes), and every synonym added to the verb
    // set relocates the hole rather than closing it. Twelve evasions were tried;
    // this catches the ones an author writes by accident, not the ones an
    // adversary writes on purpose.
    //
    // THE LOAD-BEARING CHECK IS THE COMMAND ONE BELOW — "every `tailscale
    // serve|funnel` line carries --set-path=/voice" is a closed predicate over
    // the thing an operator actually pastes. Do not read this test as a
    // guarantee; read it as a lint.
    test(`${f} does not instruct publishing the whole port (best-effort lint)`, () => {
      // NORMALISED ACROSS THE WHOLE DOCUMENT, not matched per line. The original
      // defect was hard-wrapped — "Funnel the" / "root." on two lines — so a
      // per-line `\s+` could never span it, and P20 proved the guard would not
      // have caught the very text it was written for.
      //
      // And a SEMANTIC SET, not one phrase: "publish the root", "funnel the
      // whole root" and "serve every route" all survived the single-phrase
      // version.
      // NORMALISED ACROSS THE WHOLE DOCUMENT, not per line. The original defect
      // was hard-wrapped — "Funnel the" / "root." on two lines — so a per-line
      // `\s+` could never span it, and P20 proved the guard would not have caught
      // the very text it was written for.
      //
      // A SEMANTIC SET, because "publish the root" and "funnel the whole root"
      // both survived the single-phrase version. And a POSITIVE ALLOWLIST rather
      // than a "the line contains the word not" hatch, which skipped whole lines
      // and exempted "Do not skip this step: funnel the root".
      //
      // Allowlisting exact sentences rather than trying to tell an instruction
      // from an explanation by shape: any pattern loose enough to permit the
      // warnings this repo legitimately writes is loose enough to permit the
      // instruction it forbids. Adding a sentence here is a deliberate act.
      const SANCTIONED = [
        "Do not funnel the root",
        "Do NOT funnel the root",
        "funnelling the root publishes",
        "Genesis serves /voice/* at the root",
      ];
      const flat = read(f).replace(/\s+/g, " ");
      const verbs = "funnel|funnelling|publish|expose|serve|serves";
      const objects = "the root|the whole root|the whole port|every route|all routes";
      const re = new RegExp(`(${verbs})[^.]{0,40}(${objects})`, "gi");
      const unsanctioned = [...flat.matchAll(re)]
        .map((m) => ({
          text: m[0],
          // THE SENTENCE THE MATCH SITS IN, not a character window. A window is
          // wrong in both directions: extending PAST the match let a sanctioned
          // phrase placed after a live instruction exempt it ("Just publish the
          // root. (Do not funnel the root, obviously.)" passed), and a
          // backward-only window is too short for the repo's own explanatory
          // prose. A sentence is the unit a human writes a claim in, and it is
          // the same rule the retraction check below uses.
          ctx: (() => {
            const before = flat.slice(0, m.index);
            const start = before.lastIndexOf(". ") + 1;
            const after = flat.slice(m.index);
            const end =
              (m.index ?? 0) +
              (after.indexOf(". ") === -1 ? after.length : after.indexOf(". ") + 1);
            return flat.slice(start, end);
          })(),
        }))
        .filter((h) => !SANCTIONED.some((ok) => h.ctx.includes(ok)))
        .map((h) => h.text);
      expect(`${f}: ${unsanctioned.length ? unsanctioned.join(" | ") : "clean"}`).toBe(
        `${f}: clean`,
      );
    });
  }

  test("EVERY tailscale command in an instruction file is /voice-scoped", () => {
    // A CLOSED PREDICATE, which is the point. The prose guard above enumerates
    // synonyms, and P20 got eleven of twelve new phrasings past it — each added
    // synonym relocates the hole rather than closing it. But the instruction an
    // operator actually acts on is a COMMAND, and "every `tailscale serve|funnel`
    // line carries --set-path=/voice" is checkable without guessing wording.
    //
    // The evasion this closes, verbatim from the review:
    //   tailscale funnel --bg --https=443 http://127.0.0.1:8787
    // — a copy-pasteable root funnel that the prose guard could not see.
    for (const f of INSTRUCTIONS) {
      // CONTINUATIONS JOINED FIRST. A shell command wrapped with a trailing `\`
      // is one instruction across two lines, and a per-line scan sees only the
      // half without `--set-path` — which is the SAME hard-wrap blindness that
      // defeated the original prose guard. Third instance in this file; the rule
      // is that any check over source text joins continuations before matching.
      const offenders = read(f)
        .replace(/\\\n\s*/g, " ")
        .split("\n")
        .map((l, i) => [i + 1, l] as const)
        .filter(([, l]) => /tailscale\s+(serve|funnel)\b/.test(l))
        // A line naming the subcommand without a target is prose about it
        // ("`tailscale funnel --help` documents `funnel <target>`"), not an
        // instruction: an instruction names a target to publish.
        .filter(([, l]) => /https?:\/\/|--https=|\b\d{2,5}\b/.test(l))
        // A TOKEN OF THE COMMAND, not a mention anywhere on the line. `!/…/.test(l)`
        // was satisfied by the flag appearing in a trailing comment or in the
        // prose beside it, so both of these passed:
        //   tailscale funnel --bg --https=443 http://…  # --set-path=/voice is optional
        //   run `tailscale funnel --https=443 http://…` rather than `--set-path=/voice`
        // Comments are stripped and the flag must stand alone — `--set-path=/voiceover`
        // is a different flag value and no longer counts.
        .filter(([, l]) => {
          const cmd = l.split("#")[0] ?? "";
          return !/(^|\s)--set-path=\/voice(\s|$)/.test(cmd);
        })
        .map(([n, l]) => `${n}: ${l.trim()}`);
      expect(`${f}: ${offenders.length ? offenders.join(" | ") : "clean"}`).toBe(`${f}: clean`);
    }
  });

  test("both instruction files carry the SAME recipe", () => {
    // `serve` alone is tailnet-only. The provisioning script had the serve line
    // and not the funnel line, so an operator following it published nothing and
    // ElevenLabs — a public service — could not reach the host at all.
    for (const f of ["integrations/elevenlabs/README.md", "scripts/elevenlabs-provision.sh"]) {
      const body = read(f);
      expect(`${f} has --set-path`).toBe(
        `${f}${body.includes("--set-path=/voice") ? " has --set-path" : " MISSING --set-path"}`,
      );
      expect(`${f} has the target prefix`).toBe(
        `${f}${body.includes("http://127.0.0.1:8787/voice") ? " has the target prefix" : " MISSING the target prefix"}`,
      );
      // ONE command. The previous version asserted `/tailscale funnel .*on/`,
      // which ENFORCED a line that is not valid v2 syntax — `funnel <target>`
      // has no on/off form, and the legacy shape is rejected outright. The test
      // was pinning the defect.
      expect(`${f} funnels`).toBe(
        `${f}${/tailscale funnel\b/.test(body) ? " funnels" : " MISSING the funnel command"}`,
      );
      expect(`${f} has no on/off form`).toBe(
        `${f}${/tailscale funnel[^\n]*\bon\b/.test(body) ? " USES the removed on/off form" : " has no on/off form"}`,
      );
    }
  });

  test("the measurement is committed and re-runnable — asserted on the CODE", () => {
    // MATCHED AGAINST THE EXECUTABLE REGION, not the whole file. The first
    // version asserted `toContain("--resolve")` etc. against the entire script —
    // and the script's own comment header explains all three, so P20 gutted every
    // LIVE use (dropped `--resolve` from the curl, replaced `%{remote_ip}` with a
    // literal, changed both `19` comparisons to `99`) and the guard stayed green.
    // A check satisfied by the prose describing it is not a check.
    const code = read("scripts/funnel-scope-probe.sh")
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .join("\n");
    // COUNTED, not merely present. `[ "$bytes" = "19" ]` appears twice in the
    // executable region — once to classify the verdict and once to enforce the
    // expectation — and a `toContain` cannot see ONE of them being removed. A
    // presence check is satisfied by any surviving copy.
    const occurrences = (t: string) => code.split(t).length - 1;
    expect(`--resolve x${occurrences('--resolve "$HOST:$PORT:$PUB"')}`).toBe("--resolve x1");
    expect(`remote_ip x${occurrences("%{remote_ip}")}`).toBe("remote_ip x1");
    // The discriminator: Hono's 404 is 13 bytes, tailscaled's is 19.
    expect(`19-byte check x${occurrences('[ "$bytes" = "19" ]')}`).toBe("19-byte check x2");
    expect(`13-byte check x${occurrences('[ "$bytes" = "13" ]')}`).toBe("13-byte check x1");
    // The arity guard was self-consistent, not externally pinned: deleting every
    // `probe` call AND setting EXPECTED_PROBES=0 printed an empty results table,
    // exited 0, and left this suite green — the exact defect the guard closes,
    // moved up one level of indirection. Both the call sites and the constant are
    // now counted from outside the script.
    expect(`probe calls x${occurrences("\nprobe ")}`).toBe("probe calls x6");
    expect(`arity guard x${occurrences("EXPECTED_PROBES=6")}`).toBe("arity guard x1");
  });
});

describe("no source file offers a mitigation a funnel defeats", () => {
  // SCANNED ACROSS EVERY SOURCE FILE. The first version read `index.ts` alone,
  // and the retracted sentence was still shipping CHARACTER-FOR-CHARACTER in
  // `server.ts` — so one boot of a tokenless deploy printed both halves of the
  // contradiction three lines apart. Fix landed at one site of two.
  const sources = readdirSync(join(ROOT, "apps/api/src"))
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .sort();

  test("there are source files to scan", () => {
    expect(sources.length).toBeGreaterThan(5);
  });

  for (const f of sources) {
    test(`${f} does not say bind-to-localhost is THE mitigation`, () => {
      const body = read(`apps/api/src/${f}`);
      // The retracted sentence, and only that unqualified form. Binding to
      // localhost IS a real control against a tailnet peer or a LAN neighbour —
      // it is only useless against a funnel, which forwards there. A blanket ban
      // would push an operator who is not funnelling toward 0.0.0.0.
      // MATCHED AS A CLAIM, not as one sentence. The first version pinned the
      // exact retracted string — and the same advice was shipping REPHRASED at a
      // third site ("Bind :8787 to localhost/tailnet-only and/or set
      // GENESIS_TOKEN"), printed on the SAME boot, three lines after the
      // corrected warning. A sentence-matcher over a claim that can be reworded
      // is the instrument that already failed in rounds 1 and 2.
      //
      // The forbidden claim: localhost offered as a SUFFICIENT alternative to the
      // token. The sanctioned form — "helps against a tailnet or LAN caller but
      // NOT against a funnel" — does not match, because it does not join the two
      // with or / and-or.
      const patterns = [
        /Bind to localhost only, or set GENESIS_TOKEN/,
        /[Bb]ind[^.]{0,40}localhost[^.]{0,60}(and\/or|or)[^.]{0,30}GENESIS_TOKEN/,
      ];
      const hit = patterns.find((re) => re.test(body));
      expect(`${f}: ${hit ? lineWith(body, hit) : "clean"}`).toBe(`${f}: clean`);
    });
  }

  test("the boot warning names the funnel caveat and the token", () => {
    const warn = read("apps/api/src/index.ts");
    expect(`names the token: ${warn.includes("Set GENESIS_TOKEN")}`).toBe("names the token: true");
    expect(`names the funnel scope: ${warn.includes("scope the funnel to /voice")}`).toBe(
      "names the funnel scope: true",
    );
  });
});

describe("the source's own statement of the model matches the measurement", () => {
  test("server.ts says the funnel publishes the /voice prefix", () => {
    const body = read("apps/api/src/server.ts");
    // Matched as ONE normalised claim rather than a three-line window: the window
    // version passed with the prefix changed to /walkie, because the surrounding
    // lines mention /voice three more times.
    const flat = body.replace(/\s+/g, " ");
    // The comment carries markdown emphasis markers, so the prefix is matched with
    // optional punctuation between — but ONE claim, not a three-line window: the
    // window version passed with the prefix changed to /walkie, because the
    // surrounding lines mention /voice three more times.
    const claim = /Funnel publishes exactly the[^a-z]{0,6}\/voice prefix/;
    expect(
      `server.ts: ${claim.test(flat) ? "states the /voice model" : "DOES NOT state the /voice model"}`,
    ).toBe("server.ts: states the /voice model");
  });

  test("no source still asserts the repo instructs funnelling the root", () => {
    // server.ts argued for a defence-in-depth check on the grounds that "this
    // repo's own shipped instruction says to funnel the root". After this change
    // no instruction does, so that sentence became a fourth incompatible
    // document — asserting a deleted instruction still ships.
    // A RETRACTION has to quote the sentence it retracts, and this file has to
    // quote the shape in order to detect it — so a bare search flags its own
    // explanation.
    //
    // An earlier version of this comment cited `no-local-paths.test.ts` as
    // precedent. That file has never existed in this repo (it is in walkie) — a
    // fabricated precedent offered to justify a design that was itself broken.
    // Deleted rather than replaced.
    //
    // ONE entry, anchored to the SENTENCE. The list held a second phrase,
    // "argued for a", which matched nothing in any scanned source — pure attack
    // surface — and the window was a 160-character look-BACK, so any sentence
    // written after a retraction inherited its exemption. Both were reported
    // fixed in an earlier revision and were not: the edit script failed on a
    // later assertion and wrote nothing.
    const RETRACTION_CONTEXT = ["An earlier version of this paragraph asserted"];
    for (const f of readdirSync(join(ROOT, "apps/api/src")).filter((x) => x.endsWith(".ts"))) {
      if (f === "deployment-claims.test.ts") continue; // quotes the shapes to detect them
      const body = read(`apps/api/src/${f}`).replace(/\s+/g, " ");
      const stale = /(own|repo's)[^.]{0,60}instruction[^.]{0,60}funnel the root/gi;
      const live = [...body.matchAll(stale)].filter((m) => {
        // THE CONTAINING SENTENCE, the same rule the SANCTIONED check uses. A
        // 160-character look-back let a retraction shelter an assertion written
        // after it: "Someone argued for a narrower gate here; it is not enough,
        // because this repo's own shipped instruction says to funnel the root."
        // passed.
        const before = body.slice(0, m.index);
        const sentence = before.slice(before.lastIndexOf(". ") + 1);
        return !RETRACTION_CONTEXT.some((c) => sentence.includes(c));
      });
      expect(`${f}: ${live.length ? "asserts a deleted instruction" : "clean"}`).toBe(
        `${f}: clean`,
      );
    }
  });
});
