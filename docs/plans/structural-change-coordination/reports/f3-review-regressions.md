# F3 development-review regression evidence

These are failures of the new F3 implementation during this same-author review,
not failures reproduced against the committed Passeur baseline. Three cases
were added from the source-observation/authority contract, then corrected.
They pass in the final combined run (f3-test-results.txt).

## Resource authorization race — before correction

```text
TAP version 13
# Subtest: source replacement during resource authorization cannot enroll the stale physical identity
not ok 1 - source replacement during resource authorization cannot enroll the stale physical identity
  ---
  duration_ms: 104.916541
  type: 'test'
  location: '/mnt/data/passeur-work/tests/core/coordination-bound.test.mjs:203:1'
  failureType: 'testCodeFailure'
  error: 'Missing expected rejection.'
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected:
    code: 'COORDINATION_SOURCE_CHANGED'
  operator: 'rejects'
  stack: |-
    async TestContext.<anonymous> (file:///mnt/data/passeur-work/tests/core/coordination-bound.test.mjs:213:3)
    async Test.run (node:internal/test_runner/test:1054:7)
    async startSubtestAfterBootstrap (node:internal/test_runner/harness:296:3)
  ...
1..1
# tests 1
# suites 0
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 165.052248
```

## Opening-worktree lifetime and unrelated unborn work — before correction

```text
TAP version 13
# Subtest: repository inspection remains available after the worktree that opened it is removed
not ok 1 - repository inspection remains available after the worktree that opened it is removed
  ---
  duration_ms: 92.795445
  type: 'test'
  location: '/mnt/data/passeur-work/tests/core/coordination-repository.test.mjs:118:1'
  failureType: 'testCodeFailure'
  error: "ENOENT: no such file or directory, realpath '/tmp/passeur-bound-Zi998I/opening'"
  code: 'ENOENT'
  stack: |-
    async realpath (node:internal/fs/promises:1164:10)
    async directory (file:///mnt/data/passeur-work/.passeur-core/src/coordination/repository.js:186:18)
    async #assertAnchor (file:///mnt/data/passeur-work/.passeur-core/src/coordination/repository.js:45:19)
    async CoordinationRepository.target (file:///mnt/data/passeur-work/.passeur-core/src/coordination/repository.js:157:9)
    async TestContext.<anonymous> (file:///mnt/data/passeur-work/tests/core/coordination-repository.test.mjs:122:16)
    async Test.run (node:internal/test_runner/test:1054:7)
    async startSubtestAfterBootstrap (node:internal/test_runner/harness:296:3)
  ...
# Subtest: an unrelated unborn worktree does not block inspection of established workspaces
not ok 2 - an unrelated unborn worktree does not block inspection of established workspaces
  ---
  duration_ms: 77.845702
  type: 'test'
  location: '/mnt/data/passeur-work/tests/core/coordination-repository.test.mjs:125:1'
  failureType: 'testCodeFailure'
  error: 'A worktree has no identified initial commit'
  code: 'COORDINATION_WORKSPACE_UNAVAILABLE'
  name: 'BridgeError'
  stack: |-
    listing (file:///mnt/data/passeur-work/.passeur-core/src/coordination/repository.js:230:19)
    #entries (file:///mnt/data/passeur-work/.passeur-core/src/coordination/repository.js:51:25)
    async CoordinationRepository.inspect (file:///mnt/data/passeur-work/.passeur-core/src/coordination/repository.js:80:25)
    async TestContext.<anonymous> (file:///mnt/data/passeur-work/tests/core/coordination-repository.test.mjs:128:17)
    async Test.run (node:internal/test_runner/test:1054:7)
    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
  ...
1..2
# tests 2
# suites 0
# pass 0
# fail 2
# cancelled 0
# skipped 0
# todo 0
# duration_ms 231.09305
```

## Corrections

Re-observe the workspace after the resource-authority callback, reject changed
physical identity, and recheck input retention when its HEAD changes. Anchor
repository-only reads to the canonical Git common directory rather than to a
checkout that may disappear. Preserve unborn entries in the inventory, while
refusing an unborn workspace only when it is the selected source. None of
these corrections makes Git/JSON state transactional or fences an editor.
