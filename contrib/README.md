# Submitting to the community plugin list

`awesome-dsh-plugin.yml` in this directory is the exact payload for
[`awesome-dsh-plugin/awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin).
That list is generated: a submission adds **one file**, and the READMEs are
rebuilt from `data/plugins/*.yml` after the pull request merges.

## What the list requires

- `package.json` declares `dsh.bundle` — this repo does (`./cordis.patch.yml`).
- The repository is **at least one day old**; CI checks the creation time, so a
  brand-new repo fails even when everything else is right.
- The repository carries the `dsh-plugin` topic.
- The description states what the plugin does, without marketing, and is checked
  against the code. Ours says "five tools" because the tools row registers exactly
  five, and names DPAPI / Keychain / libsecret because those are the implemented
  backends.
- Only `description.en` is required; `zh` is a courtesy to the maintainers.

## Submission, once the repository is old enough

```bash
# 1. keep the fork current, then add the entry on its default branch
gh repo fork awesome-dsh-plugin/awesome-dsh-plugin --clone=false   # once
gh repo sync <you>/awesome-dsh-plugin --source awesome-dsh-plugin/awesome-dsh-plugin

# 2. write data/plugins/<owner>__<repo>.yml on the fork
CONTENT=$(base64 -w0 contrib/awesome-dsh-plugin.yml)   # -w0 on GNU; Windows: [Convert]::ToBase64String
gh api --method PUT "repos/<you>/awesome-dsh-plugin/contents/data/plugins/<you>__dsh-icloud-calendar.yml" \
  -f message="Add <you>/dsh-icloud-calendar" -f content="$CONTENT" -f branch=main

# 3. open the pull request
gh pr create --repo awesome-dsh-plugin/awesome-dsh-plugin --head <you>:main \
  --title "Add <you>/dsh-icloud-calendar" \
  --body "Adds one entry for an iCloud Calendar (CalDAV) plugin. \`dsh.bundle\` is declared; the repo carries the \`dsh-plugin\` topic."
```

Once the pull request merges, `main` regenerates both READMEs — do not edit them
by hand, and do not touch other entries.
