# Publishing `@tsx-lvgl/sdk`

The source workspace remains private. Release only the self-contained registry
artifact built by `scripts/pack-sdk.mjs`; publishing `packages/sdk` directly
would omit the vendored framework and its provenance.

## One-time setup

1. Create or claim the npm `@tsx-lvgl` organization and grant the release
   maintainers access.
2. Complete the first manual release below to create `@tsx-lvgl/sdk` on npm.
3. In the new npm package settings, configure GitHub Actions trusted publishing
   for `Remeic/tsx-lvgl`, workflow `publish-sdk.yml`, environment `npm-publish`.
4. Protect the GitHub `npm-publish` environment and require the release
   reviewer(s). Do not add a long-lived npm token to repository secrets.

## Normal release

1. Increment `packages/sdk/package.json` according to SemVer, document the
   user-visible change, and merge the release candidate to `main`.
2. From the clean merge commit, create and push the matching tag:

   ```bash
   git tag sdk-v0.1.0
   git push origin sdk-v0.1.0
   ```

3. Approve the protected `npm-publish` environment. The workflow runs the full
   test and mutation gates, verifies that the tag matches the package version,
   creates the public portable artifact, and publishes it with npm provenance.

## Manual command

Use this for the first release, then let the trusted-publishing workflow handle
subsequent tags. Run it from a clean, tagged checkout with Node 24.19.0 and npm
11.17.0. Authenticate interactively first (including the npm 2FA prompt):

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH
npm login
node scripts/pack-sdk.mjs --registry --out /tmp/tsx-lvgl-sdk-release --json
npm publish /tmp/tsx-lvgl-sdk-release/tsx-lvgl-sdk-0.1.0.tgz --access public
```

The registry packer rejects a dirty checkout. Before publishing, run the
release workflow or at least `npm test` and inspect the packer's JSON output.
