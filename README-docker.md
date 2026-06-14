# Building & publishing the hkp-node Docker image

The Docker Hub repository is **`cbastuck/hkp-node`**. The image is built from the
[`Dockerfile`](Dockerfile) in this directory (multi-stage `node:22-alpine`, runs as the
unprivileged `node` user, binds `HOST=0.0.0.0` so published ports reach the process).

There are two ways to publish: **CI (automatic)** and **manual multi-arch build**.

---

## CI — the normal path (automatic)

[`.github/workflows/docker-publish.yml`](.github/workflows/docker-publish.yml) builds
**`linux/amd64,linux/arm64`** and pushes on every push to `main` and on manual dispatch
("Run workflow" in the Actions tab). Auth uses the repo secrets `DOCKERHUB_USERNAME` and
`DOCKERHUB_TOKEN`.

The version is read straight from [`package.json`](package.json). Each run publishes:

- `cbastuck/hkp-node:<version>` (e.g. `1.0.5`)
- `cbastuck/hkp-node:<major.minor>` (e.g. `1.0`)
- `cbastuck/hkp-node:latest`
- `cbastuck/hkp-node:<full-git-sha>`

### Cutting a versioned release via CI

Bump `version` in [`package.json`](package.json), commit, and merge/push to `main`:

```sh
# edit package.json version → 1.0.6
git commit -am "Release 1.0.6"
git push origin main
```

CI then builds multi-arch and publishes `:1.0.6`, `:1.0`, and `:latest`. Pushing more
commits to `main` **without** bumping the version re-publishes (overwrites) the same
`:1.0.6` tag — only `latest` and the git SHA change. Use the manual steps below only if
you need to publish from your machine without CI.

---

## Manual — multi-arch build (arm64 + amd64)

Use this for a versioned release, or when you want to push from your machine. A single
`buildx` invocation builds both architectures and pushes a multi-arch manifest, so the
right image is pulled automatically on Apple Silicon, ARM cloud hosts, and x86 alike.

Run everything from the `hkp-node/` directory.

### 1. Log in to Docker Hub

```sh
docker login
```

### 2. Create a buildx builder (one-time)

The default builder cannot do multi-platform builds. Create one and set it active:

```sh
docker buildx create --name hkp --use --bootstrap
```

(Subsequent builds just need `docker buildx use hkp`.)

### 3. Build all platforms, tag, and push in one step

`buildx` builds and pushes together — there is no separately loaded local image for a
multi-arch build. Tag both the version and `latest`. Replace `1.0.5` with the version in
[`package.json`](package.json) — bump it first if this is a new release, since re-pushing
an existing version overwrites it.

```sh
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t cbastuck/hkp-node:1.0.5 \
  -t cbastuck/hkp-node:latest \
  --push \
  .
```

### 4. Verify the published manifest

Confirm both architectures are present:

```sh
docker buildx imagetools inspect cbastuck/hkp-node:1.0.5
```

You should see entries for `linux/amd64` and `linux/arm64`.

---

## Single-arch local build (for testing only)

To build just your machine's architecture and load it into the local daemon so you can run
it before publishing:

```sh
docker build -t cbastuck/hkp-node:test .
docker run --rm -p 127.0.0.1:8080:8080 -e HOST=0.0.0.0 cbastuck/hkp-node:test
```

This image is **not** multi-arch and should not be pushed as a release tag — use the
`buildx ... --push` flow above for anything that goes to Docker Hub.

---

## Runtime notes

See the "Deployment & network exposure" section of [`README.md`](README.md) for how to
control where the container is reachable (`-p 127.0.0.1:8080:8080` for loopback-only, etc.)
and the auth requirements for non-loopback binds.
