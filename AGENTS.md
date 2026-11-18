# AGENTS.md

A public npm package: every push publishes. Setup, hooks and releases are in [CONTRIBUTING.md](CONTRIBUTING.md).

- **Nothing private:** no product, person, place or host name of an app that uses the package, in code, comments,
  tests or docs; role names only (`Clerk`, `sales`). Test numbers are fictional US `555` numbers: the privacy scan
  refuses a Brazilian-shaped number even when it is made up. JIDs (`@s.whatsapp.net`, `@g.us`) are allowed by
  `.gitleaks.toml`; the phone rule still reads their digits.
- **No environment reads in `src/`:** the host passes values in (`sttConfig({ url, token })`); a default name, prefix
  or URL of one host does not belong here.
- **One entry point:** every export goes through `src/index.ts`; no subpath exports.
- **Behaviour the hosts rely on:** the handler's order (receipt on arrival, gate fed in arrival order, files, voice
  notes, pass, stamp, dispatch) and the log lines' shape (`[<log>] ignored message <id>: <reason>`). A change there is
  a minor version at least, with a line in the release notes.
- **Proof before a push:** `bun run format:check && bun run typecheck && bun test && bun run build` and
  `sh scripts/privacy-scan.sh --staged`; the pre-push hook scans every outgoing commit.
- **Release:** bump `version`, push, publish a GitHub release `vX.Y.Z`; `publish.yml` publishes through npm trusted
  publishing.
