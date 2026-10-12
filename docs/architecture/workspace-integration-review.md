# W0–W3 workspace integration review candidate

Review-only composition, 2026-10-12. This branch records the exact tested composition;
individual feature PRs remain the merge/review units. No PR was merged, no deployment
or live migration occurred, and no template image/profile was admitted.

## Source pins

| Slice | Reviewed commit | Feature PR |
| --- | --- | --- |
| W0 shared contracts/additive schema | `d99468e13657df8217655cc67916c8bffb7f181d` | Foundation branch |
| W1 catalog/admin | `d2df786725fbba7d11136bdb8727db1950055fa7` | #180 |
| W2 private instances/bindings | `d2547bcaff4d2faf83e73bf823cfbb07b2a7ca10` | #182 |
| W3 starter image recipes | `68dfa324ea22a79cce0c85cc293efaa76a6ba807` | #179 |

This branch inherits W2/W0 and overlays the exact nine W1 and nine W3 owned files.
Their bytes were compared with the pinned commits. W0 contracts/schema/migrations are
unchanged. Codex runtime, native macOS and W4 browser work remain separate owners.
Migration reservations: W0 0054, Codex 0055, W4 0056; serialize journal/snapshot integration.

## Independent validation

- Full unit suite: 213 files passed, four skipped; 2,536 tests passed, 16 skipped.
- W0 migration/W2 binding/W3 Docker fixture suite: 22 passed, two real-image tests skipped.
- Disposable loopback PostgreSQL: all eight owner-pool/retention tests passed.
- Independent real PostgreSQL with application pool max one: four assignment, reservation/sweep,
  disable/revocation and crash-recovery checks passed. The old binding remains usable until readiness.
- Default production `npm run build`, full typecheck, focused lint and diff checks passed.
- Responsive catalog fixture passed at 320/390/768/1280 pixels, including keyboard submit,
  draft/publication/retirement feedback and no external requests.

An exact-lockfile `npm ci --ignore-scripts` inside this worktree resolves Turbopack's
restriction on dependencies symlinked outside its project root. Package/lock/config
files were not changed. Disposable database, containers and volumes were cleaned up.

## Runtime readiness and UX limits

Canonical profile/seed pairs are `knowledge-work-v1`/`knowledge-work-v1` and
`dotnet-linux-v1`/`dotnet-linux-v1`. Both manifest image refs and daemon profile image refs
remain null; manifest status remains `build_required`. Catalog publication is recipe
visibility, not runtime admission.

Actual image build attempts failed on build-container DNS for Debian/security and
Microsoft feeds. Office conversion and .NET SDK/cache/offline execution in complete
starter images therefore remain unverified. Build the images, record verified immutable
IDs and pass the two real-image tests before admitting profiles; never replace an admitted
v1 image behind its key. Knowledge Work makes headless Office claims only.

Template artifacts have authenticated instance-pinned downloads; their Open preview
is deferred. New legacy results retain their historical URL/Open behavior. Interactive
desktop, remote user input and LibreOffice GUI editing remain deferred. The actual agent
browser runtime/viewer is a separate W4 implementation and review.
