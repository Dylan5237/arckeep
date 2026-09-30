## Summary

Replayable **proofs** for frozen acceptance tests. **No feature/fix/docs product diff.**

- Issue / Phase: #
- Implementation PR:
- SHA under test:

## Branch

`evidence/{issue}-{slug}` — label `pr:evidence`

## Proof table

| Frozen acceptance test | Command / method | Artifact path or URL | Result |
| --- | --- | --- | --- |
| | cwd + command | | pass/fail |

## How to replay

1.
2.

## Redaction

- [ ] Secrets, tokens, PII removed
- [ ] Logs are excerpts, not entire production dumps

## Agent proposal

- [ ] `EVIDENCE READY` posted on the Phase issue
- [ ] Not commenting `PHASE ACCEPT` (disposer only)

## Checklist

- [ ] Diff is evidence-only
- [ ] Does not mix with `feat/`/`fix/` changes
- [ ] Merge of this PR still ≠ Phase PASS
- [ ] Commented `bugbot run` on this PR (body exactly that text) before asking merge
- [ ] Prompted disposer to wait for Bugbot review results before merge judgment
