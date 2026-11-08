# Agent rules

Every repo managed by Propane carries this file, and its `CLAUDE.md` imports it with `@docs/AGENT_RULES.md`. Propane reads the state of your work from GitHub, so these rules are what make the board correct.

1. **Start from an issue.** Your prompt ends with a line `Issue: <issue URL>`. Everything you do belongs to that one issue.
2. **Register yourself first.** Before anything else, edit the issue body: add a line `Agent: <your Claude session URL>` as the last line (replace any existing `Agent:` line). Use the REST API (`gh api repos/{owner}/{repo}/issues/{number} -X PATCH`).
3. **One branch, one PR.** Create the branch `issue-<number>-<short-slug>` from `staging`. Open one pull request into `staging` through the REST API (`gh api repos/{owner}/{repo}/pulls`). The PR body contains the line `Closes #<number>`. GraphQL is blocked in cloud sessions; never use `gh pr create`.
4. **Discuss on the issue.** The issue is where the owner follows and steers the work, so explain yourself there, not only in the PR or your session. Every comment you post on the issue starts with `Agent:`, and its first line is a plain one-sentence status, because the first line of your latest `Agent:` comment is shown on the card. Below that line, write what the owner needs to know. Comment at least:
   - when you start: your plan in a few lines;
   - when you make a decision the issue does not settle: what you chose and why;
   - when you open the PR: what changed, how you verified it, and anything left undone;
   - when you are blocked: see rule 5.

   Whenever you resume, and before each of these comments, read the issue's comments and reply to any from the owner you have not answered.

5. **Ask by label.** When you need an answer from the owner: post an `Agent:` comment whose first line is the question, then add the label `needs-you` to the issue and stop. When you continue, remove the label.
6. **Propose, don't wander.** If you find work outside your issue, do not do it. Open a new issue through the REST API with the label `proposed`, a body that starts with a one-line reason, and a last line `Proposed from #<number>`. Then carry on with your own issue.
7. **Done means green.** Open the PR only when `npm run lint`, `npm run check` and `npm test` pass locally. Write the failing test first for logic in `src/lib/domain/`.
8. **Hunt for bugs before you open the PR.** Once the checks in rule 7 pass, review your branch's whole diff against `staging` for bugs: run the `/code-review` skill at high effort on `origin/staging...HEAD` where it is available; otherwise read every changed line and the functions around it, asking what input, state or timing makes it wrong. Fix every real bug (failing test first for logic, as in rule 7) and rerun the checks. In the PR body and your PR comment on the issue (rule 4), list what the hunt found and what you did with each: fixed, or left with the reason.
9. **Merge into `staging` when CI is green.** Once every check on your PR has passed, merge it into `staging` yourself with a merge commit through the REST API (`gh api repos/{owner}/{repo}/pulls/{number}/merge -X PUT -f merge_method=merge`). If a check fails, fix it on your branch and wait for green again; never merge a red or conflicting PR.
10. **Never touch `main`.** Only the owner's Release button moves `staging` into `main`.
