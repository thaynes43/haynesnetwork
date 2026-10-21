# Pre-run checks (no model call), 2026-10-21T13:26:24Z, validity worktree head 08161978
1. src fingerprint (git ls-tree -r HEAD tools/media-repair-harness/src | sha1sum) = 36a08be3d70027533f56d41250edc940053e31df (tree f5cf693e)
2. config hash rebuilt offline = dac813affd7f316ac6f3f707d9a92750ed03924ea22d9ce8cfc523d5e5e686b1
3. MRH_VALIDITY_REQUIRE_ALL=1 tests.test_validity_opus55: 10 tests OK (render equivalence 73/73)
4. pod-local EPUB sha256: derived-damage f6f0c5ef…, pristine-1 e42c77b5…, pristine-0 c28cec78…, derived-title 6a64109c… (all match the receipt)
5. shim sha256 8b54299d0005b981ce4cf4578f22511712b6af3f7ed392cdcfde856f3c414b59; /home/dev/work/mrh-val-shim/claude -> scripts/claude_call_journal.sh
   scrubbed env names: CLAUDE_CONFIG_DIR, HOME, LANG, MRH_CALL_JOURNAL, MRH_CLAUDE_REAL, PATH, PYTHONPATH (env-names.json)
   through the shim in the scrubbed env: claude resolves to the shim; claude --version = 2.1.296 (Claude Code)
   attestation: /etc/claude-code absent; no ~/.claude/projects entry for any mrh-claude-* cwd; CLAUDE_CODE_EFFORT_LEVEL not passed
6. no other claude -p process running
