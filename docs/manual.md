# mica-tools manual

How to set the tool up in a repository and what every command takes, prints
and refuses. Why it is built this way, and the parts other repositories hold
it to (the inputs hash, the packing contract, the pool gates), are in
[design.md](design.md); the rules themselves are
[spec/release-lock.md](spec/release-lock.md) (cited as *lock §n*), kept in
this repository with their vectors, and
[spec/build-rules.md](spec/build-rules.md) (*RULES §n*).

## 1. Setting a repository up

A repository keeps two files and one ignored directory.

| Path | What it is |
|---|---|
| `locks/mica-build-tools.pin` | the commit of this tool the repository runs |
| `bin/mica-tools` | a byte-identical copy of `bootstrap/mica-tools` at that commit, executable |
| `repos/` | the source cache: the tool's own checkout and everything fetched by hash; in `.gitignore` |

The pin:

```text
# mica-tools-pin v1
REPOSITORY=mica-build-tools
COMMIT=<40 lowercase hex>
```

UTF-8, LF, a final LF, the header on line 1, exactly these two keys in this
order; comment lines may follow the header.

The first setup copies the bootstrap by hand and writes the pin, from a
release of this repository; after that `locks update` moves both (section
5.1):

```bash
tag=<YYYYMMDD-HHMM>      # a release of https://github.com/micaoss/mica-build-tools/releases
commit=$(git ls-remote https://github.com/micaoss/mica-build-tools.git "refs/tags/${tag}" | cut -f1)
mkdir -p bin locks
curl -fsSL "https://raw.githubusercontent.com/micaoss/mica-build-tools/${commit}/bootstrap/mica-tools" -o bin/mica-tools
chmod 755 bin/mica-tools
printf '# mica-tools-pin v1\nREPOSITORY=mica-build-tools\nCOMMIT=%s\n' "${commit}" > locks/mica-build-tools.pin
echo '/repos/' >> .gitignore
bin/mica-tools self-check
```

### 1.1 What `bin/mica-tools` does

1. Checks the pin.
2. Makes the bare mirror `repos/git/mica-build-tools.git` hold the commit,
   fetching it when it does not, and keeps `refs/pins/<commit>` so that
   `git gc` does not prune it.
3. Makes `repos/mica-build-tools/` a checkout of exactly that commit, replacing
   one that names another commit or carries a change.
4. Runs `bun repos/mica-build-tools/src/cli.ts` with the arguments, in the
   caller's working directory, with `MICA_REPO_ROOT` set to the repository
   root.

`bin/mica-tools sync` does steps 1 to 3 and runs nothing. It needs `git`,
`flock` and one of the bun routes.

### 1.2 Where bun comes from

The first that applies:

1. `MICA_BUN`, a path to a bun binary.
2. `bun` on `PATH`, only at the exact version `package.json` declares in
   `packageManager`; another version is an error, not a fallback.
3. A container: the `mica-build-env` `base` image of the repository's
   `locks/mica-build-env.lock`, by digest, run with `docker` as the caller's
   user with the repository mounted at its own path. The working directory
   must be inside the repository. Only `MICA_REPO_ROOT`, `MICA_OFFLINE`, `CI`
   and `GITHUB_ACTIONS` pass into the container, so a command that needs a
   token or another variable of section 3 runs on route 1 or 2.

### 1.3 TypeScript consumers

A TypeScript repository imports the same checkout through a path alias in its
`tsconfig.json`, and runs `bin/mica-tools sync` before its typecheck:

```json
{ "compilerOptions": { "paths": { "@mica/build-tools": ["repos/mica-build-tools/src/index.ts"] } } }
```

There is no `package.json` dependency on this repository. The source
typechecks under `exactOptionalPropertyTypes`.

## 2. Conventions

```text
mica-tools <group> <command> [arguments]
```

| Exit | Meaning | Printed |
|---|---|---|
| 0 | done | the result on stdout |
| 1 | a rule is broken | `refused <rule>` on stdout, the detail on stderr |
| 1 | any other failure | `error: <message>` on stderr |
| 2 | wrong arguments | `usage: mica-tools <command> ...` on stderr; with no command, every usage line |

- The rule names are those of the owner that states the rule (lock §1.5,
  §4, §5, §9), so a script compares stdout with `refused <rule>`.
- A flag comes before the positional arguments.
- The repository a command works on is `MICA_REPO_ROOT`, which the bootstrap
  sets, or the working directory. A relative path argument is relative to the
  working directory.
- No command follows a "latest" name while building. Those that look one up
  are the release lookups (`release latest`, `pool guard`, the notes of
  `release attach`) and the two that move pins (`locks move` without a
  release, `locks update`), and what those find becomes a pin the repository
  commits.
- Reads from GitHub and the registry are anonymous. Only `release pool` and
  `release attach` write, and they need a token.

## 3. Environment

| Variable | Read by | Meaning |
|---|---|---|
| `MICA_REPO_ROOT` | every command | the repository root; set by the bootstrap |
| `MICA_BUN` | bootstrap | the bun binary to run (1.2) |
| `MICA_TOOLS_URL` | bootstrap, `locks update` | where this tool is fetched from; default `https://github.com/micaoss/mica-build-tools.git` |
| `MICA_OFFLINE` | bootstrap, `repos get`, `repos git`, `repos check` | `1`: nothing is fetched, and a miss is `refused offline-miss` |
| `CI`, `GITHUB_ACTIONS` | `locks check`, `from`, `local-lock` | set: an offline pin is refused (`checkout-in-ci`) |
| `MICA_MIRROR` | `repos get` | a download mirror tried first: `[pool:]<https base>` or `snapshot:<https base>` (4.2) |
| `MICA_FETCH_DEADLINE` | `repos get` | the ceiling of one download in seconds; default 600 |
| `MICA_SOURCE_REPO` | `release *`, `pool guard` | this repository's name; default the last element of `origin`'s URL |
| `MICA_DEB_SOURCE_REPO` | `deb pack` | the repository written as `Mica-Source-Repo`; required |
| `SOURCE_DATE_EPOCH` | `deb pack` | must equal the epoch the control template declares; required |
| `GITHUB_TOKEN`, `GH_TOKEN` | `release check`, `release attach`, `release latest`, `release pool` | the GitHub token, for the API and the registry; never printed |
| `MICA_REGISTRY_TOKEN` | `release pool` | the registry token, before `GITHUB_TOKEN`; needs `write:packages` |
| `MICA_REGISTRY_USER` | `release pool` | the registry user; default `GITHUB_ACTOR`, else `mica` |

For tests against a stand-in, each host has one replaceable base:
`MICA_GITHUB_API` (`https://api.github.com`), `MICA_GITHUB_UPLOADS`
(`https://uploads.github.com`), `MICA_RELEASES_URL`
(`https://github.com/micaoss/{repository}/releases/download/{release}/`) and
`MICA_OCI_REGISTRY` (`https://ghcr.io`).

## 4. Commands

### 4.1 Locks and pins

The files of `locks/` (lock §4):

```text
locks/<input>.lock            a producer's release lock, as published
locks/pins/<input>.pin        the mica-pin v1 that pairs with it
locks/upstream.lock           the repository's own third-party inputs
locks/mica-build-tools.pin    this tool
```

An `<input>` is `<repository>`, or `<repository>.<scope>` for a repository
with scoped releases (`mica-build`).

#### `lock check [--collect] <file>`

Every file rule of lock §1 over one release lock. Prints `valid`, or refuses
at the first rule broken.

With `--collect` it goes on after a broken rule and prints every rule the
file breaks, sorted: `refused <rule> <rule>...`, or `stopped <rule>...` when
a broken rule left nothing further to check. Exit 1 in both cases.

```console
$ bin/mica-tools lock check locks/mica-core.lock
valid
$ bin/mica-tools lock check --collect broken.lock
refused duplicate-key sort-order
```

#### `lock rows <file> <kind>`

The rows of one kind, tab-separated as they are in the file, after the file
passed `lock check`. No row prints nothing and exits 0.

```bash
bin/mica-tools lock rows locks/mica-core.lock package | cut -f2,4
bin/mica-tools lock rows locks/mica-core.lock item | awk -F'\t' '$2 == "sbom"'
```

#### `upstream check [<file>]`

lock §4.1 over `locks/upstream.lock`, or over the file named. Prints `valid`.

#### `upstream rows <image|source|git> [<file>]`

The rows of one kind of `locks/upstream.lock`, tab-separated, after
`upstream check`.

#### `upstream get git <name> url|ref|commit`

#### `upstream get source <name> <amd64|arm64|all> version|sha256|url`

One field of one row of `locks/upstream.lock`. A missing row or field is an
error naming it.

```bash
commit=$(bin/mica-tools upstream get git podman commit)
```

#### `locks check [--ci]`

lock §4 over `locks/`: every lock passes `lock check`, every pin is a
`mica-pin v1`, each lock has its pin and each pin its lock, and their names,
scopes and releases agree; `locks/mica-build-tools.pin` is checked when it is
there. Prints `valid: <input> <release>, ...`. With `--ci`, or with `CI` or
`GITHUB_ACTIONS` set, an offline pin is refused. Reads no network.

#### `locks verify`

`locks check --ci`, then every pinned lock is its release's asset: the
release's `SHA256SUMS`, downloaded anonymously, hashes to the pin, lists
exactly the lock, and the lock served is `locks/<input>.lock` byte for byte
(RULES §1). One line per input:

```text
mica-core 20260928-1520: SHA256SUMS <sha256> lists locks/mica-core.lock, verified
```

#### `locks move <repository>[.<scope>] [<release>]`

Downloads that release's lock and `SHA256SUMS`, verifies them, and writes
`locks/<input>.lock` and `locks/pins/<input>.pin` together; no other file
changes. With no release, the latest release that carries the lock. It also
adds an input the repository did not pin before.

```console
$ bin/mica-tools locks move mica-core 20260928-1520
locks/mica-core.lock and locks/pins/mica-core.pin: mica-core 20260928-1520, SHA256SUMS <sha256>
$ bin/mica-tools locks move mica-build.uefi-x64.basic
```

#### `locks update [--check] [<input>=<release>...]`

Every input pinned in `locks/pins/` moves to its latest release that carries
its lock, and `locks/mica-build-tools.pin` to the commit of this tool's
latest release, with `bin/mica-tools` rewritten from that commit's bootstrap.

- `<input>=<release>` holds that input to the release named instead of the
  latest. `mica-build-tools=` takes a release or a commit of 40 hex.
- Everything is downloaded and verified before anything is written; one
  failure leaves every file as it was.
- An offline pin is left as it is. A repository without
  `locks/mica-build-tools.pin` gets none written.
- The third-party rows of `locks/upstream.lock` do not move: each upstream
  names its versions in its own way.

One line per input in the order of their names, this tool last:

```text
<input> <from> -> <to>
<input> <release> unchanged
<input> offline, left as it is
mica-build-tools <from commit> -> <to commit> (<release>)
```

With `--check` the same is resolved, verified and printed, and nothing under
`locks/` or `bin/` is written (the fetched commit of this tool stays in the
ignored `repos/` cache). Exit 0 when every input is unchanged; exit 1 when
any would move, with the command that moves them:

```console
$ bin/mica-tools locks update --check
mica-build-env 20260928-0159 unchanged
mica-core 20260914-2042 -> 20260928-1520
mica-build-tools <commit> unchanged
error: 1 of 3 inputs would move; mica-tools locks update moves them
$ echo $?
1
```

`--check` with `<input>=<release>` answers whether the pins are exactly what
is named, so a repository that holds an input back can still gate on the
rest.

#### `local-lock <repository>[.<scope>] <checkout>`

lock §7: verifies the `_out/offline/` of a local checkout of a producer --
its `SHA256SUMS`, the lock, that the lock names the checkout's `HEAD`, and
every digest the lock names in the OCI layout -- then writes the lock
unchanged and an offline pin (`RELEASE=offline`, `CHECKOUT=<path>`). Local
work only: refused under CI (`checkout-in-ci`), and an offline pin is never a
release input.

#### `from --ref <selector>`

The digest reference of one image out of `locks/`. A selector is
`<source>:<name>[@<platform>]`:

| Selector | Names |
|---|---|
| `mica-build-env:<image>` | the image's index in `locks/mica-build-env.lock` |
| `mica-build-env:<image>@<amd64\|arm64>` | that platform's image |
| `upstream:<name>[@<platform>]` | a third-party image, from the `upstream` image rows of `locks/mica-build-env.lock` (in `mica-build-env` itself, of `locks/upstream.lock`) |
| `<repository>:<artifact>@<arch>` | an image row of another producer's lock |

Exactly one row must match.

```console
$ bin/mica-tools from --ref mica-build-env:base
ghcr.io/micaoss/mica-build-env:base.20260928-0159@sha256:<hex>
```

#### `from <ARG>=<selector>...`

The `--build-arg` arguments that carry each `FROM` into a Dockerfile, one
word per line:

```bash
mapfile -t args < <(bin/mica-tools from BASE=mica-build-env:base RUST=mica-build-env:rust@amd64)
docker build "${args[@]}" .
```

#### `from --check <dockerfile>...`

RULES §2 over each Dockerfile: it names no image directly. Every `FROM` is a
global build argument declared with no default, a stage named before it, or
`scratch`, and a `# syntax=` directive names its image by digest. Prints
nothing when every file passes.

#### `pin check <file>`

A `mica-tools-pin v1` file (lock §4.2, §9.2). Prints `valid`.

#### `self-check`

The checkout that runs is at the commit `locks/mica-build-tools.pin` names,
and `bin/mica-tools` equals `bootstrap/mica-tools` of that commit; a
difference is `refused bootstrap-drift`. A repository runs it in CI.

### 4.2 The source cache

`repos/` (lock §5) holds what a build reads by hash, so that a second build
and an offline build fetch nothing:

```text
repos/sha256/<sha256>         a downloaded file, named by its hash
repos/git/<name>.git          a bare mirror; refs/pins/<id> keeps what a pin names
repos/mica-build-tools/       this tool's checkout
```

#### `repos get <sha256> <url> <out>`

Copies the file to `<out>` from `repos/sha256/<sha256>`, downloading and
storing it first when it is not there. The hash is checked whichever source
served; a cached file that does not hash to its name is
`refused cache-corrupt`. Prints the source:

```text
cached <sha256>
mirror <url served>
origin <url>
```

`MICA_MIRROR` names a mirror tried before the URL; any mirror failure falls
back to the URL itself.

| `MICA_MIRROR` | A URL is asked for at |
|---|---|
| `<https base>` or `pool:<https base>` | `<base>/pool/<path>` for a URL holding `/pool/<path>`; any other goes to its own |
| `snapshot:<https base>` | `<base>/...` in place of `https://snapshot.debian.org/...`; any other goes to its own |

#### `repos git <url> <commit|tree> <dir>`

Makes `<dir>` the files of the commit or tree named, out of the mirror
`repos/git/<name>.git`, fetching into the mirror first when it holds neither.
The id is verified. Prints nothing.

#### `repos check`

Every `source` and `git` row of `locks/upstream.lock`, and every `upstream`
row of the pinned producer locks, is in `repos/` and hashes right. One line
per row:

```text
source <name> <arch> <sha256>
git <name> <commit>
upstream <input> <name> <arch> <sha256>
```

Run with `MICA_OFFLINE=1` it is the proof that an offline build has
everything.

### 4.3 Debian packages

The three contracts behind these commands -- the `mica-inputs` declaration
and its hash, what `deb pack` takes and writes, and which gates `pool gate`
runs -- are design 3.3.1 to 3.3.3.

#### `version`

`<VERSION>+git<commit12>[.dirty]-1` of the tree, `VERSION` being the
repository's one-line version file. `.dirty` marks a tree with a change no
commit holds.

#### `inputs <producer> <amd64|arm64|all> [--manifest]`

The inputs hash of the producer directory `<producer>` (it holds a
`mica-inputs` file) at that architecture: 64 hex. With `--manifest`, the
lines the hash is taken over, to see what changed between two trees:

```bash
bin/mica-tools inputs debs/agent amd64 --manifest > before
# ... change the tree ...
bin/mica-tools inputs debs/agent amd64 --manifest | diff before -
```

A `path` that matches no tracked file, or a `source`, `git` or `image` that
names no row, is refused. The name of a pool item is declared like a
package, by a `package` line of its producer's `mica-inputs`.

#### `deb pack --root <dir> --control <template> --arch <amd64|arm64|all> --out <dir> [--maintainer-scripts <dir>] [--substitute <name>=<value>...]`

One archive from a staged tree. Prints the path of
`<out>/<package>_<version>_<arch>.deb`.

| Option | Meaning |
|---|---|
| `--root` | the staged tree, the archive's payload; it holds no `DEBIAN/` |
| `--control` | the control template: `Version` and `Source-Date-Epoch` declared literally, `@ARCH@` in `Architecture` |
| `--arch` | the architecture written in place of `@ARCH@` |
| `--out` | where the archive is written |
| `--maintainer-scripts` | a directory holding any of `preinst`, `postinst`, `prerm`, `postrm`; any other file is refused |
| `--substitute` | the value of one `${name}` of a relationship field, such as `shlibs:Depends=<value>`; repeatable |

It needs `dpkg-deb`, `SOURCE_DATE_EPOCH` equal to the template's epoch, and
`MICA_DEB_SOURCE_REPO`. The archive is xz-compressed, every mtime is the
epoch, every owner `root:root`, and the packed payload is compared with the
staged tree before the archive is accepted, so two runs give the same bytes.

#### `deb control <archive> [Field...]`

The control file of an archive, read without dpkg; with field names, the
value of each, one per line, an empty line for a field the archive does not
carry.

```console
$ bin/mica-tools deb control _out/debs/amd64/pool/mica-agent_1.4.0-1_amd64.deb Package Version
mica-agent
1.4.0-1
```

#### `deb member <archive> <path> [<out>]`

One file of an archive's payload, on stdout or written to `<out>` with its
mode. A symbolic link or a missing path is an error. The readers
take `xz`, `gz` and uncompressed members; `zst` is refused.

#### `pool index --arch <amd64|arm64>`

Writes `Packages`, `SHA256SUMS` and `manifest.txt` beside
`_out/debs/<arch>/pool`. `Packages` is byte for byte what
`dpkg-scanpackages --multiversion pool` writes. Prints
`<arch>: <n> package(s)`.

#### `pool gate --arch <amd64|arm64>...`

The gates of RULES §6 that the archives of `_out/debs/<arch>/pool` answer by
themselves (design 3.3.3). Every other file of the pool is an item (lock
§1.2.7): it is named `<name>_<version>_<arch>.<type>` for its pool's
architecture and its version carries no stamp, and nothing is asked of its
type or bytes. Every problem is an `error:` line on stderr, all of them and
not the first only; with none it prints `pass: <n> archive(s) in <arches>`,
an item counted as one. A pool with no archive and no item is an error.

#### `pool guard [--before <tag>] <amd64|arm64> <archive|item>`

One archive built here, or one item, against the latest unscoped release of
this repository that carries its lock, or the latest before `<tag>`. An
archive is compared with the `package` row of its name, an item with the
`item` row of its type and name, which its file name states:

| The archive's version is | Result |
|---|---|
| higher than the released one, or the package is new | `new` |
| the released one, with the same inputs hash and the same bytes | `reused` |
| the released one, with another inputs hash or other bytes | refused: the version must be bumped |
| lower than the released one | refused |

Prints `<arch> <package> <version> new|reused <sha256>`. A repository with
scoped releases guards through the library instead.

### 4.4 Registry and releases

A release tag is `<YYYYMMDD-HHMM>` in UTC, and `<scope>.<YYYYMMDD-HHMM>` for a
repository with scoped releases, the scope being one name or two
(`<board>.<variant>`).

#### `oci manifest <reference>@sha256:<hex>`

The manifest, on stdout, read anonymously by digest from `ghcr.io`, or from
the offline layout of the input's checkout for a `local/` reference. The
bytes are hashed to the digest.

#### `oci blob <name> <sha256> <out>`

One blob of `ghcr.io/micaoss/<name>` (or of the offline layout), streamed to
`<out>` and hashed to its name.

#### `release check <tag>`

The preconditions of RULES §1, before anything is read from a registry or
written anywhere:

1. the tag has the form above and names a real UTC minute not later than now;
2. `refs/tags/<tag>` on GitHub is a commit, not a tag object, and it is
   `HEAD`;
3. `HEAD` is on `origin/main`;
4. the tree is clean.

Prints the commit. `release pool` and `release attach` run it first.

#### `release pool <tag> [--arch <amd64|arm64>...]`

Publishes `_out/debs/<arch>/pool` as `ghcr.io/micaoss/<repository>:pool.<arch>.<tag>`,
one layer per archive and one per item (lock §1.2.7, media type
`application/vnd.mica.item.<type>`), each recording its inputs hash as
`mica.inputs`, and reads it back anonymously (lock §2). With no `--arch`,
every architecture that has a pool. A tag that exists is never pointed
elsewhere. Prints the `pool`, the `package` and the `item` rows for the
repository's lock, tab-separated.

#### `release attach <tag> <lock> [--data <file>...] [--notes <text>]`

Attaches to the published GitHub release, in this order, so that whoever
sees the lock can fetch what it names:

1. the file of every `data` row of the lock, given with `--data`: matched by
   name and hashed to its row, and one that is missing, extra or different
   refuses before anything is written;
2. the lock;
3. `SHA256SUMS`, listing only the lock.

Each is read back anonymously. An asset is never replaced (one already
there with the same bytes is `present`); a release carrying any other asset,
or followed by a later unscoped release, is refused. Unscoped releases only.

The release notes gain the caller's `--notes` text and, for each kind either
lock carries, one line against the previous release that carries the lock --
`<Kind>: unchanged from <previous>.` or `<Kind>: changed from <previous>.` --
then the rows that differ as a diff. A reference is compared by its digest
alone, since its tag names the release.

```bash
gh release create "${tag}" --target "$(git rev-parse HEAD)" --title "${tag}" --notes ''
bin/mica-tools release check "${tag}"
bin/mica-tools release pool "${tag}" > _out/rows
# ... the repository writes _out/<repository>.lock from its rows ...
bin/mica-tools release attach "${tag}" "_out/${repository}.lock" --notes 'What changed.'
```

#### `release latest [--repository <repository>] [--before <tag>] [--asset <name>]`

The latest published release of this repository, or of the one named;
with `--asset`, the latest that carries that asset; with `--before`, the
latest earlier than that tag. Drafts and prereleases do not count. GitHub
serves the anonymous listing from a cache, so a release cut a minute ago may
not show yet.

```console
$ bin/mica-tools release latest --repository mica-core --asset mica-core.lock
20260928-1520
```

### 4.5 Hygiene

#### `shell-lint [<pathspec>...]`

Over the tracked files the pathspecs name (default `*.sh`): in a script that
sets `pipefail`, a reader on the right of a pipe that exits before its input
ends -- `head`, `grep -q`, `grep -m`, a `sed` that quits, an `awk` that
exits, a bare `read` -- makes the pipeline fail exactly when it worked. Each
finding is `error: <file>:<line>: ...` with the form to use instead. A tree
with an unresolved merge is refused. Prints
`clean: <n> file(s) ...` when there is none.

## 5. Workflows

### 5.1 Keeping pins current

```bash
bin/mica-tools locks update --check     # what is behind; changes nothing, exit 1 when something is
bin/mica-tools locks update             # move everything
bin/mica-tools locks update mica-system-base=20260927-0907   # hold one input at a release
bin/mica-tools locks verify && bin/mica-tools self-check
git add locks bin/mica-tools
```

`locks update --check` fits a scheduled CI job or a step before a release:
it fails while an input is behind, and a build never reads anything but the
committed pins either way.

### 5.2 What a repository's CI runs

```bash
bin/mica-tools self-check
bin/mica-tools locks verify
bin/mica-tools upstream check
bin/mica-tools from --check $(git ls-files '*Dockerfile*')
bin/mica-tools shell-lint
```

### 5.3 An offline build

```bash
bin/mica-tools sync                     # online, once: the tool itself
make fetch                              # the repository's own: repos get / repos git for every row
MICA_OFFLINE=1 bin/mica-tools repos check
MICA_OFFLINE=1 make
```

### 5.4 Working against an unreleased producer

```bash
make -C ../mica-core offline
bin/mica-tools local-lock mica-core ../mica-core
# ... build and test ...
bin/mica-tools locks move mica-core     # back to a release before committing
```

### 5.5 Packaging and releasing

```bash
bin/mica-tools inputs debs/agent amd64                 # the hash recorded with the archive
SOURCE_DATE_EPOCH=... MICA_DEB_SOURCE_REPO=mica-core \
  bin/mica-tools deb pack --root stage --control debs/agent/control --arch amd64 --out _out/debs/amd64/pool
bin/mica-tools pool guard amd64 _out/debs/amd64/pool/mica-agent_1.4.0-1_amd64.deb
bin/mica-tools pool index --arch amd64
bin/mica-tools pool gate --arch amd64 --arch arm64
```

then the release of 4.4.

### 5.6 Publishing something new

What a repository publishes beside its archives needs no new row kind, no
change in `mica` and none in this tool, when it is one of these:

| It is | Publish it as | Its consumer reads |
|---|---|---|
| a file that belongs to a package or a component, built with it | a pool item: the file `<name>_<version>_<arch>.<type>` in `_out/debs/<arch>/pool`, `<type>` of the producer's choosing | `lock rows <lock> item`, then the layer with `oci blob` |
| a file of the release that no build reads | a `data` row and `release attach --data` (lock §1.2.4) | the release asset |
| a registry artifact of its own | an `image` row under a name of its own, pushed with the library's `Pusher` | `from --ref` or `oci manifest` |

For a pool item the producer does three things: it names the item in a
`package` line of a `mica-inputs`, writes the file into the pool directory,
and copies the `item` rows `release pool` prints into its lock. `pool guard`
and `pool gate` take the file as they take an archive. What the bytes mean is
agreed between the producer and the consumer of that type, and the consumer
checks what it reads.

```console
$ ls _out/debs/amd64/pool
mica-agent_1.4.0-1_amd64.deb  mica-agent_1.4.0-1_amd64.sbom
$ bin/mica-tools pool guard amd64 _out/debs/amd64/pool/mica-agent_1.4.0-1_amd64.sbom
amd64 mica-agent 1.4.0-1 new <sha256>
$ bin/mica-tools release pool "${tag}"
pool	amd64	ghcr.io/micaoss/<repository>:pool.amd64.<tag>@sha256:<hex>
package	mica-agent	amd64	1.4.0-1	<sha256>
item	sbom	mica-agent	amd64	1.4.0-1	<sha256>
```

A type is a name other than `deb`. A row of another shape,
or a rule between rows, is still a kind: it is specified and implemented
here in one commit, then every reader moves (design section 7).

## 6. The library

`src/index.ts` exports what the commands are made of, so a TypeScript
consumer runs the same code a shell consumer does:

| Command group | Exports |
|---|---|
| `lock`, `upstream` | `checkLock`, `collect`, `checkUpstream`, `gitField`, `sourceField` |
| `locks`, `pin` | `checkLocks`, `checkPins`, `verifyLocks`, `moveLock`, `updateLocks`, `localLock`, `readPin`, `readToolsPin` |
| `from` | `resolveImage`, `buildArgs`, `checkDockerfiles` |
| `repos` | `reposGet`, `reposEnsure`, `checkoutPinned`, `reposCheck`, `mirrorUrl` |
| `deb`, `inputs`, `version` | `pack`, `controlText`, `controlFields`, `payloadMember`, `unxz`, `inputsHash`, `inputsManifest`, `readDeclaration`, `version` |
| `pool` | `writeIndex`, `poolGate`, `poolGuard`, `vercmp`, `poolItems`, `itemOf`, `fileKind` |
| `oci` | `ociManifest`, `ociBlob`, `ociBlobToFile`, `bearer`, `Pusher`, `digestOf` |
| `release` | `releaseCheck`, `releaseTag`, `tagCommit`, `publishPools`, `poolManifest`, `releaseAttach`, `latestRelease` |
| `shell-lint` | `shellLint`, `shellLintText` |

A refusal is thrown as `Refused` (with `rule` and `detail`), any other
failure as `ToolError`.
