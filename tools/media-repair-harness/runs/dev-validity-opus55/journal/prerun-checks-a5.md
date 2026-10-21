# Pre-run checks at 42291dcc (no model call), 2026-10-21T14:14:48Z
1. src fingerprint 36a08be3d70027533f56d41250edc940053e31df; worktree clean
2. config hash dac813affd7f316ac6f3f707d9a92750ed03924ea22d9ce8cfc523d5e5e686b1
3. MRH_VALIDITY_REQUIRE_ALL=1 tests.test_validity_opus55: 14 OK (render equivalence 73/73)
4. pod-local EPUB sha256 f6f0c5ef / e42c77b5 / c28cec78 / 6a64109c: all match
5. shim 7665358141a634e7…; claude -> shim; scrubbed env names CLAUDE_CONFIG_DIR, HOME, LANG, MRH_CALL_JOURNAL, MRH_CLAUDE_REAL, PATH, PYTHONPATH; claude --version via shim 2.1.296 (Claude Code); /etc/claude-code absent; no ~/.claude/projects entry for mrh-claude-*
6. no other claude -p process (ps)
