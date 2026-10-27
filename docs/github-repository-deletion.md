# GitHub repository batch deletion

Open **GitHub accounts → Project repositories → Batch delete repositories**.
Choose one linked account, select repositories, review the server preview,
then enter the displayed confirmation text. Each batch supports up to 100
repositories. Local project records, files and Git history remain intact.

Only repositories already bound to this application's projects and owned by
the selected account are eligible. A repository shared with any unfinished
project is blocked. Projects must be completed, failed or cancelled before
their repository can be selected. Arbitrary account repositories are outside
this interface.

Normal login continues to request `repo`. The separate deletion authorization
requests `repo delete_repo` and binds its callback to the selected numeric
GitHub user ID. Existing credentials are retained if the user grants too few
scopes or signs in as a different account. GitHub additionally requires admin
access; organization policy may still prohibit deletion. See the
[official deletion API](https://docs.github.com/en/rest/repos/repos#delete-a-repository).

The account-scoped endpoints are:

- `POST /api/github/accounts/:accountId/repository-deletion-authorization`
- `POST /api/github/accounts/:accountId/repositories/delete-preview`, with
  `repositories: [{ projectId, owner, name }]`
- `POST /api/github/accounts/:accountId/repositories/delete-batch`, with the
  returned `previewId` and exact `confirmationText`

Previews expire after 15 minutes. The server derives project bindings itself,
checks shared project status again at confirmation, and revalidates GitHub's
numeric repository identity and admin permission before each DELETE. Redirects
are never followed. A same-name replacement is rejected. Only HTTP 204 is
reported as deleted; 404 does not prove successful deletion.

Receipts under `.github-repository-deletions` contain identities and results,
never credentials. Replaying the same preview preserves completed results.
Connection loss or an interrupted in-flight DELETE becomes `unconfirmed` and
is not automatically submitted again. Individual failures do not hide the
outcome of other selected repositories. Credentials stay encrypted on the
server and never enter browser responses.

Regression coverage lives in `github-accounts.test.ts`,
`github-repository-management.test.ts`, `GitHubRepositoryBatchDelete.test.tsx`
and `GitHubAccountManagementPage.test.tsx`. These checks use temporary data and
simulated GitHub responses; they do not delete real repositories.
