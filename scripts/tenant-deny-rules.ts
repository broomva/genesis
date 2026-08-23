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

/** Every file-tool verb that can MODIFY a path.
 *
 *  Closing the read asymmetry was not enough, and this is the half that turns
 *  disclosure into execution. The list protected the operator's home against
 *  READING and not against WRITING, and the worst paths are worse to write than to
 *  read:
 *
 *   - `~/.claude/**` — user-scope settings merge into EVERY Claude Code session on
 *     the box. A `SessionStart` hook there is arbitrary execution as `agent`, who
 *     holds NOPASSWD:ALL. The file is owned by uid agent, so nothing at the OS layer
 *     stops the write either.
 *   - `~/genesis/**` — the provisioner the operator later runs under sudo.
 *   - `~/.ssh/**`, `~/.aws/**` — appending an authorized_key is as good as reading one.
 *
 *  The tenant's own directory is NOT under any protected glob (tenant dirs live at
 *  RUNTIME_ROOT/<id>, i.e. ~/orchestrator-workspaces/<id>), so denying writes here
 *  costs a tenant nothing it is entitled to. */
export const WRITE_VERBS = ["Edit", "Write", "NotebookEdit"] as const;

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
      [...READ_VERBS, ...WRITE_VERBS].map((verb) => `${verb}(//${anchor(home)}/${g})`),
    ),
    // The tenant may not rewrite its OWN confinement settings.
    `Edit(//${anchor(tenantDir)}/.claude/**)`,
    `Write(//${anchor(tenantDir)}/.claude/**)`,
  ];
}
