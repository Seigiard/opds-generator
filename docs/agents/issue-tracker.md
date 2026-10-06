# Issue tracker: GitHub

Issues and specs live in GitHub Issues for `Seigiard/opds-generator`.
Use the `gh` CLI for all tracker operations.

## Conventions

Run commands inside this clone, where `gh` infers the repository from
`origin`. Outside this clone, pass `--repo Seigiard/opds-generator`.

- Create: `gh issue create --title "..." --body-file <path>`
- Read: `gh issue view <number> --json number,title,body,labels,comments`
- List: `gh issue list --state open --json number,title,body,labels`
  with the label filters required by the task.
- Comment: `gh issue comment <number> --body-file <path>`
- Add labels: `gh issue edit <number> --add-label "..."`
- Remove labels: `gh issue edit <number> --remove-label "..."`
- Close: `gh issue close <number> --comment "..."`

When a skill says "publish to the issue tracker", create a GitHub issue.
When it says "fetch the relevant ticket", read the issue and its comments.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## Wayfinding operations

Used by `/wayfinder`. The map is one issue with child issues as tickets.

- Map: use the `wayfinder:map` label and keep Notes, Decisions-so-far,
  and Fog in its body.
- Child: link it as a GitHub sub-issue through `gh api`. If sub-issues
  are unavailable, use a task list in the map and `Part of #<map>`
  in the child. Use a `wayfinder:<type>` label:
  `research`, `prototype`, `grilling`, or `task`.
- Blocking: use native GitHub issue dependencies:
  `gh api --method POST repos/Seigiard/opds-generator/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`.
  Fetch the database ID with
  `gh api repos/Seigiard/opds-generator/issues/<blocker> --jq .id`.
  If dependencies are unavailable, put `Blocked by: #<n>, #<n>`
  at the top of the child body.
- Frontier: inspect open children in map order. Select the first
  unassigned ticket whose blockers are all closed. With native
  dependencies, `issue_dependencies_summary.blocked_by` counts
  open blockers.
- Claim: `gh issue edit <number> --add-assignee @me`.
- Resolve: comment with the answer, close the child, and append
  a summary and link to the map's Decisions-so-far.
