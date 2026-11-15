# Releasing Harny

Harny is a VS Code / VSCodium extension. This document covers versioning,
distribution, auto-updates and the release pipeline.

---

## Channels

| Channel                             | Used by                                     | Auto-update |
| ----------------------------------- | ------------------------------------------- | ----------- |
| **VS Code Marketplace** (Microsoft) | VS Code                                     | ✅ native   |
| **Open VSX** (Eclipse)              | **VSCodium**, Gitpod, Theia, code-server, … | ✅ native   |
| **GitHub Releases** (`.vsix`)       | manual install, pinned versions             | ❌ never    |

- Publish to **both galleries**: VS Code and VSCodium check their gallery and
  **update the extension automatically** (setting `extensions.autoUpdate`,
  default `true`). There is no custom updater — publishing _is_ the update
  mechanism.
- **Open VSX is mandatory for VSCodium**: it does not use the Microsoft
  Marketplace for licensing reasons, so an extension published only there cannot
  even be installed on VSCodium.
- A `.vsix` installed by hand **never auto-updates** — it must be reinstalled.

The `.vsix` is **universal** (pure JS, no native modules): one artifact for
Windows, Linux and macOS.

---

## Versioning

- **`package.json.version`** is the source of truth (semver). Harny is **post-1.0**
  (`1.0.0`): the number is a CONTRACT, not a progress bar.
- A **git tag `vX.Y.Z`** triggers the release workflow. Bump with npm so the
  commit and the tag stay in sync:
  ```bash
  npm version patch   # or minor / major
  git push --follow-tags
  ```
- Keep **`CHANGELOG.md`** updated (Keep a Changelog format). VS Code links it
  from the extension page.
- The workflow also sets the version from the tag (`npm version "${TAG#v}"`), so
  the shipped `.vsix` always carries the tag's version.

### What 1.0 promises (and why)

An extension **auto-updates**: `publishing is the update mechanism` (see
Channels). There is no opt-in step, so "pre-1.0, breaking changes are allowed
between minor versions" was never a freedom we could use — a `0.9 → 0.10` break
would have landed on every installed user in silence. Hence, from `1.0.0`:

| Version             | May contain                                                                       |
| ------------------- | --------------------------------------------------------------------------------- |
| **patch** (`1.0.x`) | fixes only — no behaviour change a user must notice                               |
| **minor** (`1.x.0`) | additions: new features, new settings, new fields. **Nothing existing may break** |
| **major** (`2.0.0`) | the ONLY place a break may land (a rename, a removal, a new minimum VS Code)      |

The promise covers the PUBLIC surfaces only: the **settings keys** (`harny.*`),
the **`config.json` shape**, the **stored sessions** (SQLite file, folder
layout) and the **command ids**. Everything inside `src/` — module names, the
host ⇄ webview message protocol, internal APIs — is free to move in any release.

### How each public surface keeps it

- **Stored sessions** — never edited in place by hand: every change is a
  **migration** (`documentation/MIGRATIONS.md`, versioned through `PRAGMA user_version`).
  A downgrade is not supported, so a destructive step needs its own section in
  that document and a note in the changelog.
- **Settings keys** — a key is an API. **Never rename one**: add the new key,
  keep reading the old one as a fallback for a whole minor, say so under
  `Deprecated` in the changelog, and remove the alias only at the next major. The
  same rule for a key whose VALUE changes meaning (`"true"` → `"on"`): accept
  both, announce it, drop it at the major.
- **`config.json`** — the file is edited by hand, so it is read leniently: a
  malformed file or an unknown key is **ignored, never fatal** (pinned in
  `harny-file-config-provider.test.ts`), a missing field falls back to its
  default, and a save from the panel is **lossless** — the keys the UI does not
  manage survive the round-trip. A field that changes meaning follows the
  settings rule.
- **Command ids and views** — contributed in `package.json`; renaming one breaks
  keybindings the user wrote. Add the new id, contribute both, remove at the
  major.

### Pre-release

- **Marketplace**: supports a separate pre-release channel via `--pre-release`.
- **Open VSX**: no pre-release channel — use a semver pre-release version
  (`1.1.0-beta.1`) and publish it like a normal version if you want it there.
  This is the honest way to test a risky minor before it reaches everyone.

---

## One-time setup

### 1. Publishers

- **Marketplace**: create a publisher (`spltek`) at
  <https://marketplace.visualstudio.com/manage> (requires an Azure DevOps
  organization). Generate a **Personal Access Token** with the
  _Marketplace → Manage_ scope.
- **Open VSX**: sign in at <https://open-vsx.org> and **create/claim the
  `spltek` namespace** (Settings → Namespaces; web only, no token). Then, under
  the namespace, register a **Trusted Publisher** for this repository and
  `.github/workflows/release.yml`
  (<https://open-vsx.org/user-settings/trusted-publishers>). CI then publishes
  with a short-lived **OIDC** token — **no access token is stored**. (Namespace
  verification is optional: it only adds a "verified" badge.)

`package.json` must declare `publisher: "spltek"` (it does), plus `repository`,
`license`, `icon` and `engines.vscode`.

### 2. GitHub secrets / Open VSX trusted publishing

- **VS Code Marketplace**: add the `VSCE_PAT` repository secret. The Marketplace
  step is **opt-in**: without the secret it is skipped and the release still
  produces the GitHub Release.
- **Open VSX**: **no secret**. The job requests an OIDC ID token (`id-token:
write`) and `ovsx publish --trusted-publishing` exchanges it for a short-lived
  publishing token. It works only once the Trusted Publisher above is registered
  (repo + workflow file must match).

| Secret     | Value               |
| ---------- | ------------------- |
| `VSCE_PAT` | the Marketplace PAT |

---

## Release flow

1. Update `CHANGELOG.md` (move the items from `[Unreleased]` to the new version).
2. `npm version minor` (or `patch`/`major`) — updates `package.json`, commits and
   creates the tag.
3. `git push --follow-tags`.
4. The **Release** workflow (`.github/workflows/release.yml`) runs on the tag:
   - installs dependencies;
   - **typechecks and tests** (a release must never publish untested code);
   - sets the version from the tag, builds and packages the `.vsix`;
   - creates/updates the **GitHub Release** with the `.vsix`;
   - publishes to the **VS Code Marketplace** (when `VSCE_PAT` is set) and to
     **Open VSX** via **trusted publishing** (OIDC, no secret).
5. Within minutes the galleries index the new version and installed extensions
   update themselves.

You can also run the workflow manually (**Actions → Release → Run workflow**)
against an existing tag.

### Dry run / local package

```bash
npm ci
npm run typecheck && npm test
npm run build
npm run package                 # → harny-<version>.vsix
code --install-extension harny-*.vsix   # test it locally
```

---

## Troubleshooting

| Symptom                                            | Cause / fix                                                                                                   |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `vsce publish` → 401/403                           | bad/expired `VSCE_PAT`, or the publisher in `package.json` does not match the token's publisher               |
| Open VSX → 401/403 or "No OIDC ID token available" | the job lacks `id-token: write`, or no **Trusted Publisher** matches this repo/workflow file (re-register it) |
| Version not visible on the gallery                 | the gallery takes minutes to index; confirm the version is **higher** than the published one                  |
| Extension not offered to a user                    | their VS Code is below `engines.vscode` (`^1.101.0`, required by `node:sqlite`)                               |
| User not auto-updating                             | `extensions.autoUpdate` disabled (user or enterprise policy), or the extension was sideloaded from a `.vsix`  |
| `vsce` complains about a missing file              | `npm run build` first (the shipped runtime is `dist/extension.js`); `.vscodeignore` excludes sources          |

---

## Checklist

- [ ] `CHANGELOG.md` updated
- [ ] version bumped (`npm version …`) and pushed with `--follow-tags`
- [ ] CI green on `main` (the release job also typechecks + tests)
- [ ] `VSCE_PAT` secret present (Open VSX needs **no** secret — its Trusted Publisher is registered on open-vsx.org)
- [ ] GitHub Release created with the `.vsix`
- [ ] version visible on both galleries
