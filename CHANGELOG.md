# Changelog

Breaking changes are listed first in each entry.

## 2026-11-24: first release

- GROWI 8.0.11 from the official image `growilabs/growi:8.0.11@sha256:d6ca87f092287706a4a22d9992ebdc1c1527b4cb64486aa953918efd1a018ae7`, with a small start script: waits for MongoDB, creates the admin on a private port on first boot, closes self-registration, then opens the public port.
- Self-registration is set to Closed on the first boot, after the admin is created and before the public port opens.
- Attachments are stored in MongoDB (GridFS); GROWI's telemetry is off.
- Deploy on Railway button for the template code `growi-1`.
- MongoDB 8.0.38 (`mongo:8.0.38@sha256:479e85ced54ffb8a40dade1dcde2da2a9ae858515b9415e9cc54bfb8f0575d01`) as a single-node replica set with a generated password, on a Railway volume.
