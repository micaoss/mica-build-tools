# Build rules

What every Mica repository follows when it builds, publishes and consumes
artifacts. This repository implements them, and each repository runs the
commit its `locks/mica-build-tools.pin` names.

The rules sit beside the release lock ([release-lock.md](release-lock.md),
cited as *lock §n*) and the rules of package versions
([package-versions.md](package-versions.md)). A citation of
`mica-build-env:RULES.md` section *n* names section *n* here.
`mica-build-env:RULES.md` holds what is that repository's own: which images it
builds, what each holds and how they are pinned and rebuilt.

## 1. Releases

- A release is tagged with the UTC time it was cut, `YYYYMMDD-HHMM` (for
  example `20260218-1411`), and carries two assets: `<repository>.lock`, a
  `mica-lock v1` written when the release is cut, and `SHA256SUMS` listing
  only it. The exceptions are the lock's: the data assets a lock names (lock
  §1.2.4) and the scoped releases of `mica-build` (lock §1.0).
- A release is cut by hand with `gh release create <YYYYMMDD-HHMM> --target
  <commit of main>`, which creates the tag on GitHub; no tag is created or
  pushed locally. Publishing then runs only in CI: a workflow triggered by
  `release: published` builds from the release's tag, publishes what the
  release names, and attaches the assets to that release. Nothing is
  emulated: an architecture is built natively or cross-compiled. The
  workflow that runs on push and pull request runs the quality gates and
  publishes nothing.
- The tag names a real UTC minute not later than now, the commit it names is
  the checked-out `HEAD`, that commit is on `origin/main`, and the tree is
  clean (`mica-tools release check`).
- A release exists only when everything its lock names is published and
  reads with no credential at the digest its row names. An asset is never
  replaced, and no time-tagged release may be later than the one being
  attached (`mica-tools release attach`).
- Once the assets are attached, the release notes gain the comparison of the
  lock's rows with those of the previous release carrying a lock, kind by
  kind: "<Kind>: unchanged" or "<Kind>: changed", then the rows that differ.
- A consumer records the tag and the sha256 of `SHA256SUMS`. It downloads
  from `https://github.com/micaoss/<repository>/releases/download/<tag>/` and
  refuses the assets unless `SHA256SUMS` hashes to the recorded value and
  `sha256sum -c SHA256SUMS` passes (`mica-tools locks verify`).

The releases of `mica-build-env` bind every repository that builds:

- A release whose images changed (a build-env image, an upstream base image,
  or a toolchain version or hash) is a breaking update: every repository
  must update to it.
- Each repository pins its own `mica-build-env` release, in its own tree.
  Between breaking updates, repositories may be on different releases and
  move to a newer one when they choose.
- One repository builds with one release at a time: its images and pins all
  come from the release it pins.
- Consuming another repository's artifact never requires the environment
  that built it: the artifact is checked against its pin (section 5), not
  against the consumer's build-env.

## 2. Images

- Every base image is pinned as `name:tag@sha256:<64 lowercase hex>`, the
  digest of the multi-architecture index; a tag alone or a malformed digest
  is refused. A Dockerfile names no image directly: it takes its `FROM` as a
  build argument with no default (`mica-tools from`).
- A consumer takes the build-env images and the upstream images from the
  `mica-build-env.lock` of the release it pins; an upstream image is read
  from its original registry at the pinned digest, and Mica does not
  republish it (lock §1.2.1).
- No image installs from a live archive: what an image installs is a
  sha256-pinned archive or an archive snapshot named by its instant.
- Every tag is the release that published it, `<image>.<YYYYMMDD-HHMM>` (for
  example `rust.20260915-0030`), and the lock names that tag. No tag carries
  a hash or a commit. A tag that exists is never re-pointed, and an image
  whose inputs did not change keeps its digest under the new release's tag.

Which images `mica-build-env` builds, what each adds, how their third-party
inputs are pinned in its `locks/upstream.lock` and when one is rebuilt are
`mica-build-env:RULES.md`.

## 3. Publishing

- A repository chooses how it publishes what it builds; an OCI package is not
  required. Any of these is a valid transport:
  - a GitHub release of the repository itself;
  - an HTTP server on the build host or network (for example a local apt
    repository);
  - the repository's own public GHCR package, `ghcr.io/micaoss/<repository>`.
- Whatever the transport:
  - an artifact's name says what it is and what built it:
    `<package>_<version>_<arch>.deb` for a Debian package,
    `<name>_<version>_<arch>.<type>` for a pool item (lock §1.2.7),
    `<repository>-<commit12>.tar.gz` for a source archive;
  - a published name never serves other bytes: nothing is replaced or
    re-pointed, and a changed build gets a new name;
  - the publisher reads back what it published and compares the bytes; a
    release or GHCR package must also read with no credential;
  - the artifact records the repository that built it, and a release records
    the full commit: the `Mica-Source-Repo` control field of a `.deb`, which
    carries no commit (package-versions R3), the release row of the lock, or
    the OCI annotations below.
- When the transport is OCI:
  - a tag says what the artifact is and which release published it:
    `<kind>[.<name>]*.<YYYYMMDD-HHMM>`, the release's tag exactly, never a
    commit or a hash;

    | Kind | Tag | artifactType |
    | --- | --- | --- |
    | image | `mica-build-env:<image>.<release>`, `mica-system-base:rootfs.<release>` | (image index) |
    | source | `<repository>:source.<release>` | `application/vnd.mica.source` |
    | pool | `<repository>:pool.<arch>.<release>`, `mica-build:pool.<board>.<arch>.<release>` | `application/vnd.mica.pool` |
    | board component | `mica-build:<component>.<board>.<release>` (`kernel`, `uboot`, `firmware`) | `application/vnd.mica.board.<component>` |
    | product bundle | `mica-build:image.<product>.<release>`, `mica-build:update.<product>.<release>` | (lock §2) |

  - a manifest other than an image is an OCI image manifest with an empty
    config, annotated with `org.opencontainers.image.revision` (the full
    commit), `org.opencontainers.image.created`,
    `org.opencontainers.image.source`, `mica.source-repo` and
    `mica.source-commit`, except a pool manifest, which carries only
    `mica.source-repo` and `mica.arch`, so an unchanged pool keeps its digest
    across releases; every layer carries `org.opencontainers.image.title`. A
    pool has one `application/vnd.mica.deb` layer per archive and one
    `application/vnd.mica.item.<type>` layer per item; a source artifact has
    exactly one `application/vnd.mica.source.tar+gzip` layer. The full layout
    is lock §2;
  - a token-endpoint refusal reports its own status (401 or 403); 000 means
    the registry could not be reached.

## 4. Source archives

- A source archive is made by `git -c tar.tar.gz.command='gzip -cn' archive
  --format=tar.gz --prefix=<repository>-<commit12>/ <full commit>`, so one
  commit always gives the same bytes.
- Only a clean tree at HEAD is published. A historical commit additionally
  needs its full 40-hex commit id and the expected 64-hex sha256, must be an
  ancestor of HEAD, and is refused before anything is written when its
  archive does not hash to the expected value.
- A consumer pins a producer's release, not an artifact:
  `locks/<repository>.lock` and `locks/pins/<repository>.pin` (`mica-pin v1`,
  lock §4), and what it fetches from that release is named by the rows of
  that lock.

## 5. Readers

- A reader fetches exactly what a pin names and never follows a "latest" name.
- A reader refuses the bytes unless they hash to the pinned sha256, and
  refuses what they claim to be unless it matches the pin: a `.deb`'s control
  fields, a source archive's top directory, an OCI artifact's artifactType,
  `mica.source-repo`, revision, layers and title.
- A reader reads only the location the pin names. A 401, 403, 404, transport
  failure, wrong identity, corrupt content or hash mismatch stops the read;
  there is no fallback to another location. The one exception is a download
  mirror of the source cache (`MICA_MIRROR`, design 3.2): it is tried before a
  row's own URL, and the bytes are held to the row's sha256 whichever served.

## 6. Debian packages

- A package is locked by its own version (package-versions): the version is
  declared literally in the package's control template, with its
  `Source-Date-Epoch` beside it and bumped with it, and carries no commit,
  date, release or `.dirty` stamp (R1, R2). `<VERSION>+git<commit12>[.dirty]-1`,
  what `mica-tools version` prints, is the stamp of a tree -- a composed
  product's, for example -- and never a package's version.
- A producer declares what decides its packages' bytes in a `mica-inputs`
  file; the sha256 of what it declares is the inputs hash, recorded with the
  published archive as `mica.inputs` and nowhere in the lock (R4; design
  3.3.1). Against the previous release (`mica-tools pool guard`): a package
  at a released version carries the same inputs hash and the same bytes, a
  higher version is built, a lower one is refused (R5).
- Packing happens inside the target architecture's image, with
  `SOURCE_DATE_EPOCH` required and equal to the declared epoch. Every mtime
  is set to it, ownership is `root:root`, and `Installed-Size`,
  `DEBIAN/md5sums` and `Mica-Source-Repo` are written by the packer; the
  control template must not carry them, nor `Mica-Source-Commit`, which no
  archive carries (R3; `mica-tools deb pack`, design 3.3.2).
- An imported archive is named by a `package` row of the producer's lock at
  its pin (`package <name> <arch> <version> <sha256>`), and a fetched archive
  must match that row field by field.
- A pool passes these gates. What the archives answer by themselves, the same
  for every repository (`mica-tools pool gate`, design 3.3.3):
  - every archive is named `<Package>_<Version>_<Architecture>.deb`, is its
    pool's architecture or `all`, and carries a version without a stamp, a
    `Mica-Source-Repo` and no `Mica-Source-Commit`;
  - no path is shipped by two archives unless they mutually conflict, and
    `Replaces` is refused;
  - every package ships a non-empty copyright file;
  - there are no conffiles;
  - maintainer scripts parse as POSIX sh;
  - `all` archives are identical across pools;
  - every other file of a pool is an item named
    `<name>_<version>_<arch>.<type>` for its pool's architecture, with a
    version without a stamp.

  And what needs the repository's own declarations or build, which each
  repository gates itself:
  - every archive maps to a producer or a pin, and imported archives equal
    their pins;
  - enablement symlinks match the producer's declaration;
  - two builds under one `SOURCE_DATE_EPOCH` are byte-identical.
