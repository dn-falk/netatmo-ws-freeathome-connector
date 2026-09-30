# Notes for Claude

- **Increase the version with every change that should reach users**, in the same branch/PR: merging
  a version that has no release yet into `main` publishes the release (see "Releases" in the README).
  - `npm version <x.y.z> --no-git-tag-version` (package.json and package-lock.json)
  - the same `"version"` in `free-at-home-metadata.json` (CI fails if it differs from package.json)
  - patch for fixes and improvements, minor for new features or settings
  - check the latest released tag first (`git ls-remote --tags origin`); one increase per PR
- Before pushing: `npm test`, `npm run build`, `npm run validate`.
