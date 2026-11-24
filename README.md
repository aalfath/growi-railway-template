[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template/growi-1?utm_medium=integration&utm_source=button&utm_campaign=growi)

# GROWI on Railway

This repo packages [GROWI](https://github.com/growilabs/growi), an open-source team wiki written in Markdown (page tree, page history, comments, simultaneous editing), as a one-click Railway template.

## What the template deploys

| Service | Source | What it does |
|---|---|---|
| **GROWI** | this repo, folder `growi/` | GROWI **8.0.11** from the official image `growilabs/growi:8.0.11@sha256:d6ca87f092287706a4a22d9992ebdc1c1527b4cb64486aa953918efd1a018ae7`, plus a small start script. Public HTTPS domain, health check on `/_api/v3/healthcheck`. Keeps no state of its own. |
| **MongoDB** | `mongo:8.0.38@sha256:479e85ced54ffb8a40dade1dcde2da2a9ae858515b9415e9cc54bfb8f0575d01` | Stores pages, revisions, users, settings, sessions and uploaded attachments (GridFS) on a Railway volume at `/data/db`. Runs as a single-node replica set `rs0`, because GROWI 8 uses change streams. Generated password, private network only. |

What the start script (`growi/start.sh`, `growi/railway-boot.mjs`) adds to the upstream image:

- **Admin account on the first boot, sign-up closed.** GROWI normally lets the first visitor run the installer, and its self-registration is open by default. Here, on the first boot only, GROWI runs once on a private port (Railway routes nothing to it), creates the admin from `AUTO_INSTALL_ADMIN_USERNAME` / `AUTO_INSTALL_ADMIN_PASSWORD`, and then sets self-registration to **Closed**, before the public port opens. If the admin can't be created, the service stops instead of opening an uninstalled wiki.
- Waits for MongoDB to accept writes, and takes a lock in MongoDB so two overlapping deploys never install twice.
- Attachments go to MongoDB (`FILE_UPLOAD=mongodb`), so the whole stack needs one volume (Railway's Free plan allows one per project).
- Upstream's anonymous telemetry to `telemetry.growi.org` is off (`OPENTELEMETRY_ENABLED=false`).
- Trusts Railway's proxy ranges for `X-Forwarded-*`, sets the site URL from the Railway domain, and sizes libuv threads from the service's CPUs.
- If GROWI stops unexpectedly, the container exits non-zero, so Railway's restart policy brings it back.
- BusyBox is added to the distroless upstream image so `railway ssh` has a shell.

## Variables

| Service | Variable | Default | Notes |
|---|---|---|---|
| GROWI | `AUTO_INSTALL_ADMIN_USERNAME` | `admin` | Admin user created on the first boot. |
| GROWI | `AUTO_INSTALL_ADMIN_PASSWORD` | generated (24 characters) | Admin password. Read it in the service's Variables tab, sign in, then change it in GROWI (changing the variable later has no effect). |
| GROWI | `PASSWORD_SEED` | generated | Salt for password hashes. **Never change it after the first deploy**, or no one can sign in. |
| GROWI | `SECRET_TOKEN` | generated | Signs session cookies. |
| GROWI | `MONGO_URI` | reference to MongoDB | Private-network connection string (database `growi`). |
| GROWI | `APP_SITE_URL` | `https://${{RAILWAY_PUBLIC_DOMAIN}}` | Public URL used in links. Change it if you add a custom domain. |
| GROWI | `PORT` | `3000` | Port GROWI listens on. |
| MongoDB | `MONGO_INITDB_ROOT_USERNAME` / `MONGO_INITDB_ROOT_PASSWORD` | `mongo` / generated | Database login, private network only. |
| MongoDB | `MONGO_REPLICA_KEY` | generated | Key file for the replica set. |
| MongoDB | `GLIBC_TUNABLES` | `glibc.pthread.rseq=1` | Stops MongoDB 8 crash-looping on newer Linux kernels ([SERVER-121912](https://jira.mongodb.org/browse/SERVER-121912)). |
| MongoDB | `MONGO_URL` | built from the above | Connection string for other services. |

Nothing has to be typed in at deploy time. Any other GROWI setting from [upstream's docs](https://docs.growi.org/en/admin-guide/admin-cookbook/env-vars.html) can be added as a variable on the GROWI service.

## After deploy

1. Open the GROWI service's public URL. You land on the sign-in page.
2. Sign in as `admin` with `AUTO_INSTALL_ADMIN_PASSWORD` (GROWI service → Variables). Change the password under your user settings.
3. Add people under **Admin → User management → Invite**, or reopen sign-up under **Admin → Security → ID/Pass** (Open or Restricted, optionally with an e-mail domain allow-list).
4. Optional: set up mail (**Admin → App → Mail settings**) for invitations and password resets, and single sign-on (LDAP, SAML, OIDC, Google, GitHub) under **Admin → Security**.

## Left out on purpose

- **Elasticsearch** (full-text search): it needs about 1 GB of RAM and a second volume, which doesn't fit Railway's Free plan. Without it GROWI works normally, but the search box returns no results; the page tree, tags and recent changes still work. To add search, deploy Elasticsearch 9 with the `analysis-kuromoji` and `analysis-icu` plugins (see upstream's [growi-docker-compose](https://github.com/growilabs/growi-docker-compose/tree/master/elasticsearch)), then set `ELASTICSEARCH_URI=http://<elasticsearch private domain>:9200/growi` on the GROWI service and rebuild the index under **Admin → Full text search**.
- **PDF converter** (bulk export of pages as PDF): optional; Markdown export works without it.
- **Redis**: optional upstream; sessions are kept in MongoDB, so a redeploy doesn't sign anyone out.

## Memory

Tested with each service limited to 0.5 GB RAM and 1 vCPU (Railway's Free plan): GROWI uses about 230 MB idle and about 290 MB after creating and viewing 40 pages; MongoDB stays under 400 MB (WiredTiger cache capped at 0.25 GB). GROWI's heap is sized from the service's memory limit by the upstream entrypoint, so raising the limit gives it more room automatically.

## Updates

Railway tells everyone who deployed this template when a change lands on this repo's `main` branch, and you choose when to apply it. Every update is listed in [`CHANGELOG.md`](CHANGELOG.md), breaking changes first. GROWI's own database migrations run automatically on start. The MongoDB image is not updated by template updates.

Back up first: `mongodump` from the MongoDB service (or **Admin → Data export** in GROWI).

## Licence

GROWI is MIT-licensed (GROWI, Inc.). This wrapper is MIT as well.
