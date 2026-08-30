# TrueForge Adaptive Kernel patch

The complete patched TrueForge monorepo is vendored at [`trueforge/`](../trueforge), so this repository is self-contained and does not require a sibling checkout or a published `npx` package. `trueforge-adaptive-kernel.patch` is retained as a portable recovery and provenance artifact: it reproduces the vendored kernel changes against the exact upstream base, including new files, generated OpenAPI updates, tests, benchmark fixtures, and changesets.

The refreshed patch also includes:

- host-owned executable Brave `web_search`, bounded provider I/O, secret-free capability reporting, and visible UI status;
- durable backend-enforced `/model`, `/effort`, `/goal`, `/plan`, `/context`, `/task`, `/request`, and `/completion` controls;
- an accessible composer slash palette and clearable active-control chips for draft and named agents;
- bounded configured-model routing for dynamic subagents without widening parent tool or sandbox authority; and
- Windows-safe ESM loading for SQLite and PostgreSQL migrations.

## Patch identity

- Upstream base commit: `a3a13956e99c2f90cca37b48c324812ad03b493a`
- Patch SHA-256: `EED16D5B8458A5BCA0CC3BE7FC4E5B52CBF863911B7EBD5DBB9297F0EB9E0B2B`
- Patch size: 619,789 bytes
- Clean-base `git apply --check --whitespace=error-all`: passed

## Check or apply

From this repository on Windows PowerShell:

```powershell
# Validate only (default; does not modify the target)
.\scripts\apply-trueforge-kernel-patch.ps1 \
  -TrueForgePath "C:\path\to\trueforge"

# Apply after validation
.\scripts\apply-trueforge-kernel-patch.ps1 \
  -TrueForgePath "C:\path\to\trueforge" \
  -Apply
```

The target checkout must be clean and at the exact base commit. The script fails closed if the remote, commit, working tree, checksum, or `git apply --check` does not match.

After applying, run the validation commands documented in the project report. No commit or push is performed by the script.

## Current-repository layer

The `src/runtime/kernel/` implementation in this hackathon repository is the client-side adaptive layer used by Licence to Patch. It provides Zod-owned task contracts, working-state projection, context planning, tool selection, delegation checks, and false-completion blocking at the SDK required-action boundary. It complements—but does not replace—the core patch above, because client code cannot intercept an operation the server core already allowed.
