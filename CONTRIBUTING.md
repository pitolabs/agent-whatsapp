# Contributing

Thanks for stopping by. Issues and pull requests are welcome; small, focused changes land fastest.

## Setup

```bash
git clone git@github.com:pitolabs/agent-whatsapp.git && cd agent-whatsapp
bun install          # also turns the git hooks on (core.hooksPath .githooks)
bun run typecheck && bun test && bun run format:check
```

Bun 1.4 (`packageManager` in `package.json`) and Biome 2.6 pinned in `devDependencies`; Biome runs only through
`scripts/biome.sh`, never from PATH. `bun run format` formats; `bun run build` emits `dist/`. The hooks and the
checks CI runs need [mise](https://mise.jdx.dev) (`brew install mise`): it
installs the gitleaks, jactionlint, zizmor, shellcheck and osv-scanner pinned in `mise.toml`, each checked against
`mise.lock`; `mise run check` runs them all.

## The hooks

- **pre-commit** formats the staged files and refuses a commit whose staged changes carry a secret or personal data
  (`scripts/privacy-scan.sh --staged`: the mise-pinned gitleaks with the rules in `.gitleaks.toml`, plus a private
  blocklist kept outside the repository).
- **pre-push** runs the same scan over every outgoing commit, and requires every author/committer e-mail to be a
  GitHub noreply address: `git config user.email "<id>+<login>@users.noreply.github.com"` (`gh api user --jq .id`).

The scan needs `~/.config/privacy/blocklist.txt` to exist; an empty file is fine for a contributor. Test fixtures must
use fictional identities: a Brazilian-shaped phone number is refused even when made up (use a US `555` number).

## Tests

`bun test` runs everything under `test/` in process: temporary session folders, the real Baileys adapter and Chat SDK
without a socket, a stub `fetch` for speech-to-text, fake timers for the burst queue; no network, no keys. Keep new
tests deterministic and about behaviour a consumer can see.

## Neutral names

Examples, comments and tests use role names (`Clerk`, `sales`, `"do número da loja"`), never the name of a product,
person or place that uses the package. Before a commit:

```bash
git grep -n -i -E '<the private names you know>' -- src test docs README.md
```

## Security

Report a vulnerability privately, as [SECURITY.md](SECURITY.md) says; not in a public issue.

## Releasing

Bump `version` in `package.json`, commit, push, create a GitHub release tagged `vX.Y.Z`; `publish.yml` runs the checks
and publishes to npm through trusted publishing. The first release (0.1.0) is published by hand with a short-lived
token, since npm configures a trusted publisher only on a package that exists.
