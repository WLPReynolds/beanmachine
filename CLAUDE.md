# Lotto Lab

PWA with statistics for UK Lotto and EuroMillions, served by GitHub Pages at https://lottolab.slightlygood.app.
The full background is in the project brief (claude.ai project "Oddly Lotto Lab").

## Layout
- `index.html`: markup and CSS, and it loads `src/app.js?v=<version>`.
- `src/app.js`: the whole app. This is a classic script, not a module. Top-level names are global, and it keeps `'use strict'`.
- `sw.js`: the service worker. It's network-first, and precaches the shell, including `src/app.js`.
- `manifest.json`, the icons, and `CNAME` (the custom domain; **keep it**).
- `test/`: `node:test` + jsdom tests. `helpers.js` loads the app in demo mode.
- `scripts/bump.js`: bumps the version.
- The Cloudflare Worker (`lotto-worker.js`) is **not** in this repo. It's deployed by pasting it into the dashboard.

## Workflow
- Work on a branch. Run `npm install` once, then `npm test`.
- Bump the version with `npm run bump` (patch), or `npm run bump -- minor|major|x.y.z`. This updates
  package.json, `APP_VERSION` in src/app.js, `CACHE` in sw.js, and the `?v=` on the script tag in index.html.
  A test fails if they disagree.
- Ask before pushing, and again before merging. Open PRs with `gh api repos/WLPReynolds/lotto-lab/pulls`
  (`gh pr create` fails in these sessions). Run `git fetch origin` after pushing.
- Merging to `main` deploys, via GitHub Pages.
