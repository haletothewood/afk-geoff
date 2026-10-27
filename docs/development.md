# Developing and releasing AFK Geoff

## Build from source

From an existing clone, use the pnpm version declared in `package.json`:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm typecheck
corepack pnpm test
corepack pnpm test:package
node packages/cli/bin/afk.js --help
```

Use the same Node installation to install native dependencies and run AFK. The private root workspace builds the public `afk-geoff` package in `packages/cli`. `pnpm pack:cli` writes a tarball to `dist-pack/`; the package smoke check installs it into a temporary project and exercises CLI help and smoke initialization.

## Release through a pull request

1. Choose the next version from changes since the latest npm release. Bump the CLI package using package-manager tooling and check lockfile consistency.
2. Update `packages/cli/README.md` for public behavior changes. Keep released and unreleased features explicit.
3. Run frozen install, build, typecheck, all tests and packed-install smoke. Inspect the tarball, including its version, executable and public README.
4. Open a release PR and require green `Verify release` CI. Merge, then require green CI on the exact merged main commit.
5. Create a signed annotated `v<version>` tag on that commit and push it once. Never reuse a previously published version.
6. Monitor `Publish npm package`, then independently confirm the exact version, `latest` dist-tag and repository metadata with `npm view`.

The tag workflow checks main ancestry and the package version, reruns verification on Ubuntu with Node 24 and pnpm 10.20.0, and publishes from `packages/cli`. It uses npm trusted publishing with GitHub OIDC; do not separately run `npm publish`.

Trusted-publisher settings for `afk-geoff`: GitHub owner `haletothewood`, repository `afk-geoff`, workflow `publish-npm.yml`, no environment, npm publish allowed. No long-lived npm token is needed.

If publication fails, query npm before changing a tag. Published versions are immutable: fix forward when a version already exists.
