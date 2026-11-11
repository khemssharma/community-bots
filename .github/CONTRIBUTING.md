# Contributing to community-bots

Thanks for your interest in improving **community-bots**, a collection of automation scripts and bots for social media sites and job portals. Bug reports, fixes, docs and new features are all welcome.

**Stack:** Plain JavaScript · Node.js · Bookmarklets · GitHub Actions

## Ways to contribute

- 🐛 **Report a bug:** [open a bug report](https://github.com/khemssharma/community-bots/issues/new?template=bug_report.yml)
- 💡 **Suggest a feature:** [open a feature request](https://github.com/khemssharma/community-bots/issues/new?template=feature_request.yml)
- 📝 **Improve the docs:** typos, unclear steps and missing examples all count
- 🔧 **Fix an issue:** look for issues labelled `good first issue` or `help wanted`

For anything bigger than a small fix, please **open an issue first**, so we can agree on the approach before you spend time on it.

## Local setup

```bash
git clone https://github.com/<your-username>/community-bots.git
cd community-bots
```

Each folder is independent. For the Node.js GitHub bots:

```bash
cd github-bots
npm install
```

Bookmarklets (`*.bookmarklet`) need no setup: see each folder's README for install steps.

## Project layout

| Path | What lives there |
| --- | --- |
| `github-bots/` | Node.js GitHub follow/unfollow bots (run by GitHub Actions) |
| `instagram-scripts/` | Instagram bookmarklets and guide |
| `x-scripts/` | X (Twitter) scripts |
| `indeed-scripts/` | Job-application helpers |
| `.github/workflows/` | Scheduled Actions that run the bots |

## Making a change

1. **Fork** the repo and create a branch from `main`:
   ```bash
   git checkout -b feat/short-description   # or fix/…, docs/…, refactor/…
   ```
2. Make your change. Keep each PR focused on **one** thing.
3. Run the checks below.
4. Commit using [Conventional Commits](https://www.conventionalcommits.org/):
   ```
   feat: add rematch button
   fix: handle disconnect during game
   docs: clarify .env setup
   ```
5. Push to your fork and open a pull request against `main`. Fill in the PR template.

## Checks before you open a PR

- **Node scripts:** run the script locally against your own account with a small limit first.
- **Bookmarklets:** check the code parses before committing: strip the `javascript:` prefix and run `node --check` on it. Then test it on the real site.
- **Workflows:** run the workflow from your fork (Actions → Run workflow) before opening the PR.

### Continuous integration

Scheduled workflows in `.github/workflows/` run the GitHub bots. If you add or change a workflow, keep secrets in repository secrets and test it from your fork first.

## Project-specific guidelines

- **Never commit tokens, cookies or passwords.** Bots read secrets from environment variables or GitHub Actions secrets.
- **Be gentle with rate limits.** Every script that acts on an account needs randomised delays and must stop when the site starts limiting it. PRs that remove delays won't be merged.
- **Bookmarklets** must be a single line starting with `javascript:`, avoid `#` and `%` characters, and keep progress in `localStorage` so they can resume.
- **Document every new script** in its folder's README: what it does, how to run it, and its limits.
- **Respect each platform's terms.** Scripts are for use on your own account only. No scraping of other people's data and no spam.

## Code style

- Match the style of the code around your change.
- Use clear, descriptive names; avoid unexplained abbreviations.
- Remove debug logs and commented-out code before committing.
- Update the README if your change affects setup or usage.

## Reporting security issues

Please **don't open a public issue** for security vulnerabilities. Contact the maintainer privately through the [GitHub profile](https://github.com/khemssharma) with the details and steps to reproduce.

## Code of conduct

Be respectful and constructive. Harassment, personal attacks and spam aren't tolerated.

## License

This repository doesn't have an open-source license yet. Until one is added, by submitting a contribution you agree that it may be used, modified and distributed as part of this project.
