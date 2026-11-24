# GROWI for Railway: the official image, pinned by version and digest,
# plus a small start script (start.sh) and first-boot setup (railway-boot.mjs).
FROM busybox:1.37.0-musl@sha256:f6a95d611e0a8780fabdb2aec43e31275b2720dfefa3e41b16835bfc42454478 AS busybox

FROM growilabs/growi:8.0.11@sha256:d6ca87f092287706a4a22d9992ebdc1c1527b4cb64486aa953918efd1a018ae7

# The upstream image is distroless (Node only). BusyBox gives `railway ssh` a shell.
COPY --from=busybox /bin/busybox /bin/busybox
RUN ["/bin/busybox", "--install", "-s", "/bin"]

COPY start.sh /railway-start.sh
COPY railway-boot.mjs /railway-boot.mjs

ENV PORT=3000
EXPOSE 3000

ENTRYPOINT ["/bin/sh", "/railway-start.sh"]
