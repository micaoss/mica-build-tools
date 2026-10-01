# mica-build-tools design

The one implementation of the rules every Mica repository applies when it
builds, publishes and consumes artifacts: the reader of the release lock, the
pin checker, the test vectors, the inputs hash, the package-version guard, the
pool publisher, the Debian packer and the shell lint. A rule changes in one
place, and no repository carries a copy that can lag.

## 1. What this repository owns

- **The rules of the release lock, and their implementation.** A rule
  changes in one commit here, text, vectors and code (section 7):
  - the release lock, the consumer's `locks/`, the source cache and the test
    vectors: [spec/release-lock.md](spec/release-lock.md) (cited below as
    *lock §n*), with `docs/spec/release-lock/vectors/`;
  - package versions: [spec/package-versions.md](spec/package-versions.md)
    (cited as the package-version decision).

  `mica` states no rule of the lock: it tells every repository to run this
  one. It keeps what is the project's: architecture and boards.
- **The build rules, and their implementation**:
  [spec/build-rules.md](spec/build-rules.md) (cited as *RULES §n*, the section
  numbers `mica-build-env:RULES.md` cites) -- releases, images, publishing,
  readers and Debian packages. `mica-build-env` keeps
  what is its own in its `RULES.md`: which images it builds and what each
  holds.
- **One language.** TypeScript on Bun, like `mica-build` and
  `mica-system-base`. No shell beyond the bootstrap (2.2), no Python.
- **No runtime dependency.** The code uses Bun and `node:` built-ins only.
  Development dependencies (TypeScript, ESLint, `@types/bun`) exist in this
  repository alone, so a consumer runs it without an install step and without a
  second lockfile to trust.
- **What it does not own.** Anything one repository does for itself stays
  there: image builds (`mica-build-env`), cargo caches and package producers
  (`mica-core`), the engine build and its cache (`mica-podman`), the root and
  its closure (`mica-system-base`), boards, products, images and verification
  (`mica-build`), the mirror service (`mica-res`), documentation gates (`mica`).

## 2. How a repository consumes it

### 2.1 The pin: `locks/mica-build-tools.pin`

Each consuming repository records the one commit it runs in
`locks/mica-build-tools.pin`, with the other inputs it pins (lock §4.2):

```text
# mica-tools-pin v1
REPOSITORY=mica-build-tools
COMMIT=<40 lowercase hex>
```

The file rules are those of lock §9.2: UTF-8, LF, a
final LF, the header, exactly these two keys in this order, comment lines
allowed after the header. Refusals: `header`, `encoding`, `pin-format`,
`field-value`.

- **A commit, not a release.** The tool has no built artifact; its bytes are
  its source, and a commit is the address of that source. Its releases name
  commits worth pinning: `locks update` pins the commit of the latest one.
- **In `locks/`, beside `locks/pins/` and not in it.** Everything a
  repository pins is in one directory; but a file in `locks/pins/` is a
  `mica-pin v1` paired with a producer's lock (lock §4), and this repository
  publishes no lock, so the pin takes no part in that pairing. `locks check`
  checks it when it is there.
- **Not a `git` row of `locks/upstream.lock`.** That file lists third-party
  inputs (lock §4.1); this repository is not third-party.
- **One pin per repository, moved when the repository chooses**, like its
  `mica-build-env` release (RULES §1). Two repositories may run different
  commits, except where section 7 says a writer waits for its readers.

### 2.2 The bootstrap: `bin/mica-tools`

The only file a consumer copies. It is byte-identical to
`bootstrap/mica-tools` at the pinned commit, and `mica-tools self-check`
refuses a difference (`bootstrap-drift`). It is bash and does
exactly this:

1. Check `locks/mica-build-tools.pin` (2.1).
2. Make `repos/git/mica-build-tools.git`, the bare mirror of lock §5, hold
   `COMMIT`, fetching from `https://github.com/micaoss/mica-build-tools.git`
   when it does not. Under `MICA_OFFLINE=1` nothing is fetched and a miss is
   refused as `offline-miss` naming the pin.
3. Make `repos/mica-build-tools/` a checkout of exactly `COMMIT`, verified
   with `git rev-parse HEAD`, replacing it when it names another commit.
4. Run `bun repos/mica-build-tools/src/cli.ts "$@"` in the caller's working
   directory, with the repository root as `MICA_REPO_ROOT`.

Bun is found in this order, and a caller cannot tell which route it got (the
shape of `mica-build:bin/bun.sh`):

1. `MICA_BUN`, a path to a bun binary;
2. `bun` on `PATH`, only at the exact version this repository declares
   (`packageManager` in `package.json`); another version is refused, not used;
3. the container route: the `mica-build-env:base` image of the consumer's
   `locks/mica-build-env.lock`, by digest, with the tree mounted at its own
   path, run as the caller's user so what it writes stays the caller's.

`mica-build-env` has no `locks/mica-build-env.lock` of its own, so it uses
routes 1 and 2; its CI takes bun from its own `source bun <arch>` row of
`locks/upstream.lock`, verified by sha256.

`bin/mica-tools sync` does steps 1 to 3 and runs nothing, for a TypeScript
consumer's typecheck.

### 2.3 TypeScript consumers import the library

`mica-system-base` and `mica-build` import the same checkout, not
a package: a `tsconfig.json` path alias
`"@mica/build-tools": ["repos/mica-build-tools/src/index.ts"]`, materialized by
`bin/mica-tools sync`. There is no `package.json` dependency on this
repository, because that would be a second pin of the same thing with its own
way to disagree.

## 3. Commands

`mica-tools <group> <command> [arguments]`. Every command prints its result
on stdout and exits 0, or prints `refused <rule>` (the rule names of the owner
that states the rule) or an `error:` line naming the input, and exits 1; a
usage error exits 2. Every command reads only what a pin names and never
follows a "latest" name, except the release lookups that are defined as
"latest" by RULES §1 and the package-version decision, and the two commands
that move pins (`locks move` without a release, `locks update`): what they
follow becomes a pin, a changed file the repository commits, and a build reads
that pin. `locks update --check` says what would move and writes nothing.

[manual.md](manual.md) describes every command: its arguments, what it
prints, what it refuses, the environment it reads and the workflows the
commands make. This section is what each group implements and the contracts
other repositories hold it to.

### 3.1 Locks and pins -- lock §1, §4, §4.1, §7, §9.2; RULES §1, §2

| Commands | Implement |
|---|---|
| `lock check`, `lock rows` | the file rules of lock §1 over one release lock, and its collect mode (lock §9.4) |
| `upstream check`, `upstream rows`, `upstream get` | lock §4.1 over `locks/upstream.lock` |
| `locks check`, `locks verify` | lock §4 over `locks/`, and every pinned lock as its release's asset (RULES §1) |
| `locks move`, `locks update`, `local-lock` | writing a lock and its pin together, from a release or from a checkout's `_out/offline/` (lock §7) |
| `from` | images by digest out of `locks/`, and Dockerfiles that name none directly (RULES §2) |
| `pin check`, `self-check` | the commit pins (2.1, lock §9.2) and the bootstrap copy (2.2) |

### 3.2 The source cache -- lock §5

`repos get`, `repos git` and `repos check`: files by sha256 under
`repos/sha256/`, commits and trees out of the bare mirrors `repos/git/`, a
download mirror (`MICA_MIRROR`) tried before a row's own URL with the hash
checked whichever source served, and `MICA_OFFLINE=1` turning every miss into
`offline-miss`.

### 3.3 Debian packages -- RULES §6; the package-version decision

`version`, `inputs`, `deb pack`, `deb control`, `deb member`, `pool index`,
`pool gate` and `pool guard`.

Every repository packs, hashes and publishes one way.

#### 3.3.1 The inputs declaration and hash

A producer is a directory holding a file `mica-inputs`, which declares the
packages the producer builds and everything that decides their bytes:

```text
# mica-inputs v1
package <name>              a package this producer builds, or the name of its pool items (lock 1.2.7), one line each
path <pathspec>             tracked files, a git pathspec from the repository root (`:(exclude)...` allowed)
source <name>[*]            the source rows of locks/upstream.lock of that name, or with that prefix
git <name>                  the git row of locks/upstream.lock of that name
image <selector>            an image by `from` selector (3.1)
```

Comment lines follow the header; every other line is one of these. The
producer directory itself is always an input. A `path` that matches no tracked
file, and a `source`, `git` or `image` that names no row, are refused: a
declaration that has gone stale says so instead of hashing less. A package is
declared by one producer only.

The manifest is, in this order, each line ending in LF:

1. one line per tracked file, sorted by path as bytes:
   `<sha256> <type> <path>`, the type `-` for a regular file, `x` for an
   executable one and `l` for a symbolic link, whose sha256 is that of
   `link:<target>`;
2. one line per declared row, sorted as bytes: `row <columns>`, the lock row's
   columns joined by one space (a `source` row at `<arch>` is the row of that
   architecture and the `all` row; at `all`, every row of the name), and
   `row image <selector> <reference>` for an image;
3. `arch <arch>`.

The inputs hash is the sha256 of the manifest. The version and
`SOURCE_DATE_EPOCH` are in the control template (3.3.2), which the producer
declares. Neither the build-env images nor this repository's commit are inputs:
a toolchain or packer change that moves bytes is caught by the byte comparison
of `pool guard`, and a tool pin move is not a package change.

RULES §6 states the rule and this section its form.

#### 3.3.2 Packing

`deb pack` is run by a package's
Dockerfile in the build image of the archive's architecture, with this
repository's checkout as a build context:

- The control template declares `Version` literally, with no commit, snapshot
  or dirty stamp, and beside it `Source-Date-Epoch`, bumped together; it
  carries `@ARCH@` in `Architecture`. `SOURCE_DATE_EPOCH` must be the declared
  epoch, and `MICA_DEB_SOURCE_REPO` names the repository.
- The template may not carry `Installed-Size`, `Mica-Source-Repo` or
  `Mica-Source-Commit`; the packer computes `Installed-Size`, writes
  `Mica-Source-Repo` and drops `Source-Date-Epoch`.
- A `${name}` in a relationship field is replaced only by a `--substitute`
  the caller gives (`shlibs:Depends` from its own `dpkg-shlibdeps`); an empty
  or unexpanded one is refused.
- Every mtime is the epoch, the archive is `root:root`, `DEBIAN/md5sums` is
  sorted, maintainer scripts are only `preinst`, `postinst`, `prerm` and
  `postrm`, and the packed payload is compared with the staged tree before the
  archive `<package>_<version>_<arch>.deb` is accepted.

#### 3.3.3 The pool gates

`pool gate` runs the gates of RULES §6 that the archives of the pools answer by
themselves, the same for every repository:

- every archive is named `<Package>_<Version>_<Architecture>.deb`, is its
  pool's architecture or `all`, and carries a version with no commit or dirty
  stamp, a `Mica-Source-Repo` and no `Mica-Source-Commit`;
- no `Replaces`, and no non-directory path shipped by two archives of a pool
  unless each `Conflicts` with the other;
- a non-empty `/usr/share/doc/<package>/copyright` in every archive;
- no `DEBIAN/conffiles`, and maintainer scripts that parse as POSIX sh;
- an `all` archive is the same bytes in every pool that holds it;
- a pool item (lock 1.2.7) is a file `<name>_<version>_<arch>.<type>` of its
  pool's architecture whose version carries no stamp. Nothing is asked of its
  type or its bytes.

Three gates stay with each repository: that every archive maps to a producer
or a pin and an imported archive equals its pin, that enablement links match
the producer's declaration, and that two builds under one `SOURCE_DATE_EPOCH`
are byte-identical. They need what only the repository has -- its producer map
and pins, its enablement declarations, which differ per repository, and its
own build to run twice -- and holding them here would need one producer format
for every repository. The split
is by what a gate reads: the archives alone, here; the repository's own
declarations or build, there.

### 3.4 Registry and releases -- RULES §1, §3, §5; lock §2

`oci manifest` and `oci blob` read by digest, anonymously; `release check`
is the preconditions of RULES §1; `release pool` publishes the pools and
`release attach` the lock, its data assets and `SHA256SUMS`; `release latest`
is the lookup the others share.

A pool manifest is written as JSON indented by two spaces with a final LF,
keys in the order `schemaVersion`, `mediaType`,
`artifactType`, `config`, `layers`, `annotations`; each layer carries
`mediaType`, `digest`, `size` and `annotations` with
`org.opencontainers.image.title` then `mica.inputs`, the layers sorted by
title.

**What a repository publishes next in a pool is an item, not a kind** (lock
1.2.7). Any other file of the pool directory,
`<name>_<version>_<arch>.<type>`, is one layer
(`application/vnd.mica.item.<type>`, annotated like an archive) and one row
`item <type> <name> <arch> <version> <sha256>`, printed after the `package`
rows; `pool guard` holds its version, inputs and bytes and `pool gate` its
name. No command knows a type, so a new one is a file its producer writes and
a row its consumer reads (`lock rows <file> item`), with no change here and
no reader that has to move first. A kind remains what a row of another shape
or a rule between rows needs.

`mica-core`'s core components are items of the types `core.img` and
`core.json` (lock 1.2.6); what a record is belongs to `mica-core`'s gate and
to `mica-build`, which signs it.

The library exposes the OCI client (manifests and blobs read and pushed with
`fetch`) for publishers that write their own artifacts: `mica-system-base`'s
rootfs, `mica-build`'s board components and scoped releases.

### 3.5 Hygiene

`shell-lint`: in a script that sets `pipefail`, a reader on the right of a
pipe that exits before its input ends.

## 4. The library

`src/index.ts` exports what the commands are made of: parsing and checking a
lock, a pin, `locks/upstream.lock` and `locks/`; `from` resolution; the version
stamp; the inputs hash; the OCI client; release lookups. Every command is a
thin wrapper over it, so a TypeScript consumer and a shell consumer run the
same code. A consumer that must read rows it does not check (a mirror that
syncs only third-party rows and accepts other kinds unread) uses the parser
without the checker; checking stays one call.

## 5. Data formats

The files stay in the formats their owners define: a release lock and
`locks/upstream.lock` are tab-separated rows (lock §1, §4.1), a pin is
`KEY=VALUE` lines (lock §4, §9.2, and 2.1 here), for these reasons:

- **One byte form per content.** A lock is hashed (`SHA256SUMS`), pinned by
  that hash and compared row by row (RULES §1); the file rules and the sort
  order make every content one sequence of bytes. JSON needs a canonical form
  on top (RFC 8785) to say the same, and YAML has none: block and flow styles,
  quoting, indentation and aliases are all valid spellings of one document.
- **No implicit types.** Every field is a string checked against its own form.
  YAML resolves `1.10`, `on` or `0755` differently under 1.1 and 1.2, so two
  readers of one file could disagree on its value.
- **One row, one line.** Moving a pin or adding a source is one changed line in
  a diff.
- **Published assets are immutable** (RULES §1). A second format would have to
  be read beside this one for as long as a pinned release carries it.

After parsing, the library returns a checked lock as its rows, each the
columns of its line as strings, and the commands that print rows print them
tab-separated as they are in the file. Typed rows and a `--json` output for CI
are not implemented. JSON is the format of machine data that is neither
hashed, pinned nor compared by row (`evidence.json`); YAML
is the format of the CI workflows.

## 6. Conformance

- **This repository holds the vectors and is their one reader.**
  `docs/spec/release-lock/vectors/` are files of this tree, so no pin names
  them and no test fetches them. The tests read every family (`lock`,
  `upstream`, `pins`, `tools-pin`, `repos`) and assert every row of
  `expected.tsv` and `refusal-sets.tsv`; that every vector on disk is listed;
  and that every refused lock holds to the derivation it declares (lock
  §9.3). There is no subset: this code reads every form every repository
  reads. Consumers carry no vectors.
- **One reader.** What holds a rule is its vector: a rule is added with the
  vector that breaks it, in the same commit.
- **Gates.** `bun run check` is `lint`, `typecheck` and `test`, and a test run
  that ran no test is red. CI runs it with bun from a digest-pinned upstream
  image, not from `mica-build-env`, which consumes this repository.

## 7. How a rule changes

1. A rule changes here, in one commit: the text under `docs/spec/` -- the
   lock, package versions or the build rules -- the vectors that assert it,
   and the code.
2. The commit is released, and each reader moves its
   `locks/mica-build-tools.pin` to it (`locks update`).
3. A writer that emits the new form -- a producer publishing a new row --
   does so only after every repository that reads its lock pins a commit that
   reads it. This is the "readers move before the writer" of lock §1.2.5, one
   pin move per reader.

What a repository publishes next is a value and not a rule, wherever it can
be: an `item`, a `data` or an `image` row (3.4, lock §1.2.7) needs none of
these steps.

## 8. Adopting it

A repository adopts the tools in one change, with no compatibility layer: it
adds `bin/mica-tools` and `locks/mica-build-tools.pin`, routes its Makefile,
CI and scripts through the commands, and carries no implementation or vectors
of its own. A packaging repository also writes a `mica-inputs` for every
producer, declares version and epoch in its control templates (3.3.2) and
packs with `deb pack`.

| Repository | Kept (its own) |
|---|---|
| `mica-build-env` | `build.sh`, `publish-images.sh`, `fetch-archives.sh`, `params.env` and its checks, `from.sh` for the `LOCAL_` tags, writing its own lock rows |
| `mica-core` | package producers, `cache-prune.sh`, `offline.sh` as the entry |
| `mica-podman` | the engine build and its cache, `base-check.sh`, `check-pins.sh` |
| `mica-system-base` | the root, its closure and `pin-inputs`, the rootfs publisher and the Base-specific lock rows |
| `mica-build` | boards, components and their reuse, scoped releases (on the library), offline chain, image, rootfs, verify |

`mica-build-env:RULES.md` points to
`docs/spec/build-rules.md` for the six sections every repository follows and
describes its own images.

## 9. Layout

```text
bootstrap/mica-tools    the bootstrap consumers copy (2.2)
src/cli.ts              the one entry: mica-tools <group> <command>
src/index.ts            the library (section 4)
src/<group>/            locks, repos, deb, pool, oci, release, lint
docs/spec/              the rules this repository owns: the release lock and its vectors, package versions, the build rules
tests/                  unit tests and the vectors conformance test
package.json            packageManager bun@<version>; dev dependencies only
```

`tsconfig.json` sets `exactOptionalPropertyTypes`, the strictest option a
consumer compiles the imported source under (`mica-system-base`),
so `bun run check` here is what a consumer's typecheck will say.
