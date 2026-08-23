/** The tenant's Claude file-tool deny rules (BRO-2236).
 *
 *  Its own module, and pure, for one reason: `provision-whatsapp-tenants.ts` runs
 *  ~270 lines of provisioning at import, so nothing in it could be unit-tested
 *  without executing the provisioner. That is exactly how the two defects below
 *  survived in a hand-written list with a green suite.
 *
 *  This list is the WHOLE boundary for the built-in file tools. The sandbox
 *  `denyRead` covers Bash only; Read/Glob/Grep run inside the Claude Code process
 *  and never reach it. */

/** Claude settings globs need an absolute `//` anchor. A single leading slash
 *  anchors at the settings file instead and matches NOTHING — a malformed anchor is
 *  a silently empty deny list, not an error. */
export const anchor = (p: string): string => p.replace(/^\/+/, "");

/** Every file-tool verb that can OBSERVE a path. Read and Grep both return content;
 *  Glob returns names, which is enough to aim the next request. Denying a path for
 *  one verb and not the others is the asymmetry this module exists to prevent — the
 *  previous list denied Read on `.ssh`/`.aws`/`.config`/`.claude`/`*.env` and Grep on
 *  only `broomva/` and `genesis/`, so grepping the operator's keys was never denied. */
export const READ_VERBS = ["Read", "Grep", "Glob"] as const;

/** Paths under the operator's HOME a tenant must never observe.
 *
 *  Still a blocklist, with the weakness the provisioner already names: anything
 *  unnamed stays readable, and a sibling tenant cannot be denied by prefix without
 *  denying the tenant's own directory. That gap stays open for the file-tool channel
 *  and is measured by the eval instead. */
export const PROTECTED_HOME_GLOBS = [
  ".ssh/**",
  ".aws/**",
  ".config/**",
  ".claude/**",
  "broomva/**",
  "genesis/**",
  "*.env",
] as const;

/** Built as a cross-product so the verb columns cannot drift apart, and threaded
 *  through `home` rather than reading the env so a test can prove the rules FOLLOW
 *  it. The sandbox `denyRead` layer is derived from HOME; these used to be literal
 *  `/home/agent`, so pointing `GENESIS_TENANT_HOME` elsewhere left the two layers
 *  guarding different directories. */
export function denyRulesFor(home: string, tenantDir: string): string[] {
  return [
    ...PROTECTED_HOME_GLOBS.flatMap((g) =>
      READ_VERBS.map((verb) => `${verb}(//${anchor(home)}/${g})`),
    ),
    // The tenant may not rewrite its OWN confinement settings.
    `Edit(//${anchor(tenantDir)}/.claude/**)`,
    `Write(//${anchor(tenantDir)}/.claude/**)`,
  ];
}
