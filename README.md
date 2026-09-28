# SkyViewLab

SkyViewLab is a separated React, Go, and Python research and engineering
workbench platform.

- `web_react/`: React frontend
- `backend_go/`: Go control plane, authentication, authorization, audit, jobs,
  persistence, and worker
- `backend_python/`: isolated scientific-compute service and workbench models
- `infra/`: PostgreSQL, Keycloak, OpenFGA, and observability foundations
- `verification/`: automated tests, acceptance evidence, and local lifecycle
  scripts

## Start locally

Follow [START-WEBSITE.md](START-WEBSITE.md). On a prepared Windows workstation,
the normal startup command is:

```powershell
pwsh -File .\verification\start-local-website.ps1
```

The script restores dependencies when required, builds the Go services, starts
all four local processes, and runs the integration verification before it
reports the site ready at <http://localhost:4182/>.

## Architecture and delivery status

- Backend architecture and production boundaries: [BACKEND.md](BACKEND.md)
- Production rebuild blueprint: [PRODUCTION_REBUILD_BLUEPRINT.md](PRODUCTION_REBUILD_BLUEPRINT.md)
- Migration and delivery progress: [PRODUCTION_REBUILD_PROGRESS.md](PRODUCTION_REBUILD_PROGRESS.md)
- Card-version parity checklist: [CARD_VERSION_PARITY_MIGRATION_CHECKLIST.md](CARD_VERSION_PARITY_MIGRATION_CHECKLIST.md)

Local credentials, databases, logs, generated binaries, dependency directories,
and build output are intentionally excluded from Git.
