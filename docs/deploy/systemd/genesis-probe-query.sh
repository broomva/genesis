#!/usr/bin/env bash
# The consumer contract: what each loop pass runs to ask "did the ingress break
# while I wasn't looking?" — the question point-in-time checks cannot answer.
SINCE=${1:-1 hour ago}
J=(journalctl --user -u genesis-deploy-probe.service --since "$SINCE" --no-pager)
fails=$("${J[@]}" 2>/dev/null | grep -c 'check(s) FAILED')
runs=$("${J[@]}" 2>/dev/null | grep -cE 'no differential|check\(s\) FAILED')
last=$(journalctl --user -u genesis-deploy-probe.service --no-pager 2>/dev/null \
        | grep -E 'no differential|check\(s\) FAILED' | tail -1 | sed 's/.*]: //')
echo "  window:        since $SINCE"
echo "  probe runs:    $runs"
echo "  failed runs:   $fails"
echo "  last verdict:  ${last:-<none yet>}"
[ "$fails" -gt 0 ] && echo "  → the ingress broke while unobserved; inspect: journalctl --user -u genesis-deploy-probe.service --since '$SINCE'"
exit 0
