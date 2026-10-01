# Release locks, pins and the offline build

This is the one format every Mica OS release is described in and every
consumer records its inputs with, and the contract for building the chain
without reading a published release. The rules are implemented once, in
`mica-build-tools`, which every repository pins by commit in
`locks/mica-build-tools.pin` (4.2) and runs as `bin/mica-tools`; the
implementation passes every test vector of section 9.

This document is kept in `mica-build-tools` with its vectors
(`docs/spec/release-lock/vectors/`) and the rules of package versions
(`docs/spec/package-versions.md`), beside the one implementation of them. A
rule, its vectors and its implementation change in one commit of this
repository (9.1).

## 1. The release lock: `mica-lock v1`

A release of `<repository>` (tag `<YYYYMMDD-HHMM>`) carries exactly two GitHub
Release assets: `<repository>.lock` and `SHA256SUMS`. `SHA256SUMS` lists
exactly one file, `<repository>.lock`, in `sha256sum` format. There are no
`.deb` or other assets; packages live only in the OCI pools (section 2), and
so do a repository's pool items (1.2.7), `mica-core`'s core components among
them. The exception is `mica-build`'s scoped releases, which carry image files
(1.0).

**Any repository may also carry producer data, each file named by a `data` row
of its own lock.** `SHA256SUMS` still lists exactly one file, the lock, and the
exception list above is unchanged: the chain a consumer follows is
`SHA256SUMS` → lock → the row's sha256 → the file, which is the chain
`mica-build`'s images use (1.2.2). What a `data` asset may be is bounded in
1.2.4.

### 1.0 Scoped releases

One repository releases by scope instead of all at once; every other
repository's release is unscoped:

- `mica-build`, which nothing consumes, releases per board (all its products)
  or per product: the tag is `<scope>.<YYYYMMDD-HHMM>`, a release builds the
  scope's board -- its kernel and U-Boot, reusing an unchanged component by
  digest, and its packages -- and the scope's products, and it carries image
  files beside `mica-build.lock` and `SHA256SUMS`; its lock rows are those of
  1.2.2.

`<scope>` is a board or a product: a board is `[a-z0-9][a-z0-9-]*`, and a
product is its board's name or `<board>.<variant>`, so a scope is
`[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)?` -- `uefi-x64`, `mini-x64`,
`uefi-x64.basic`. A release has no dot, so everything before the last dot of a
scoped tag is the scope. The separator is a dot: a slash in a release row is
refused as `field-value`. A scoped lock carries the rows of the scope's board:
its `pool` row (`pool.<board>.<arch>.<release>`), its `package` rows and one
`board` row per built component -- `kernel` always, `uboot` and `firmware`
where the board publishes them (`board-components`) -- beside the products'
rows (1.2.2). The lock's release row carries the scoped tag (1.2) and OCI tags
carry the scope before the release (1.3); nothing consumes `mica-build`, so no
consumer keeps a scoped input.

### 1.1 File rules

- UTF-8, LF line ends, a final LF, no CR.
- Line 1 is exactly `# mica-lock v1`.
- Later lines starting with `#` are comments. An empty line, a line starting
  with a space and a trailing tab are refused, so the bytes are reproducible.
- Every other line is a row: tab-separated columns, typed by the first column,
  with an exact column count.

### 1.2 Rows

| Kind | Columns | Key | Meaning |
|---|---|---|---|
| `release` | `release <repository> <release> <commit>` | -- | exactly once, the first row; `<release>` is `<YYYYMMDD-HHMM>`, or `<scope>.<YYYYMMDD-HHMM>` for `mica-build` only (1.0), for example `release mica-build uefi-x64.20260915-0300 <commit>`; `<commit>` is 40 lowercase hex; an offline lock (section 6) has `offline` in place of `<YYYYMMDD-HHMM>` (`<scope>.offline` for a scoped repository) |
| `image` | `image <source> <name> <platform> <reference>` | source, name, platform | `<source>` is the producing repository or `upstream` (1.2.1); `<platform>` is `index`, `amd64`, `arm64` or `386` |
| `pool` | `pool <arch> <reference>` | arch | the package pool of one architecture |
| `package` | `package <name> <arch> <version> <sha256>` | name, arch | an archive this repository built: the layer of `pool <arch>` with that digest; an `Architecture: all` archive appears once per architecture with the same sha256; its arch must have a `pool` row |
| `item` | `item <type> <name> <arch> <version> <sha256>` | type, name, arch | one pool item (1.2.7): the layer of `pool <arch>` with that digest, a file of a type the format does not know; `<type>` is a name other than `deb`; its arch must have a `pool` row; published by any repository |
| `board` | `board <board> <component> <arch> <reference>` | board, component | one built component artifact of a board (`mica-build`, 1.2.2); `<component>` is `kernel`, `uboot` or `firmware` (section 2); every board with a row has a `kernel` row (`board-components`) |
| `upstream` | `upstream <name> <arch> <version> <sha256> <url> <roots>` | name, arch | a third-party archive pinned for later stages; `<url>` is https; `<roots>` is the comma-separated, sorted, duplicate-free list of `upstream.pkgs` roots it is pinned for; `mica-system-base` only |
| `apt` | `apt <uri> <suite> <components> <signed-by>` | uri, suite | one Debian source, one row per source (1.2.5); `<components>` space-separated, `<signed-by>` an absolute keyring path; `mica-system-base` only |
| `input` | `input <repository>[.<scope>] <release> <sha256>` | input | one release `mica-build` composed from (1.2.2); `mica-build` only |
| `product` | `product <product> <board> <profile> <generation> <deployment id> <kernel id> <rootfs id>` | product | one product of the release and its signed deployment (1.2.2); `mica-build` only |
| `bundle` | `bundle <product> image\|update <reference>` | product, type | the product's OCI image or update bundle (1.2.2); `mica-build` only |
| `asset` | `asset <product> image\|update <kind> <file> <sha256>` | product, type, kind | one GitHub Release asset and its bundle layer (1.2.2); `mica-build` only |
| `data` | `data <name> <file> <sha256>` | name | one producer-data release asset, published by any repository (1.2.4) |

Values: `<arch>` is `amd64` or `arm64`; names are `[a-z0-9][a-z0-9.+-]*`,
except an `upstream` image name (1.2.1); versions are `[A-Za-z0-9.+~:-]+`;
sha256 values and digests are 64 lowercase hex.

#### 1.2.1 Image sources

The `image` row says where an image comes from, and its name and reference are
the original ones, used as they are, with no rewriting:

- a repository name (`[a-z0-9][a-z0-9-]*`): an image that Mica OS repository
  builds and publishes on `ghcr.io/micaoss/<source>`, and the reference must
  be there (1.3). In a producer's own release lock the source equals the
  release row's repository. `<name>` is the producer's own key, lowercased and
  a name as above: `mica-build-env` names `base`, `c`, `go`, `rust`;
  `mica-system-base` names `rootfs`. A built image names the index and each
  platform manifest:
  `image mica-build-env base amd64 ghcr.io/micaoss/mica-build-env@sha256:<digest>`,
  `image mica-system-base rootfs index ghcr.io/micaoss/mica-system-base:rootfs.<release>@sha256:<digest>`.
- `upstream`: a third-party image. `<name>` is the image exactly as upstream
  spells it, `<path>[:<tag>]` (`debian:trixie-slim`,
  `docker/dockerfile:1-labs`, `registry:3.1.1`). `<reference>` is the original
  reference with its registry host spelled out,
  `<registry>/<path>[:<tag>]@sha256:<digest>`
  (`image upstream debian:trixie-slim 386 docker.io/library/debian:trixie-slim@sha256:<digest>`).
  Every row names the index digest, identical on each platform row, since
  `FROM` and `# syntax=` resolve the platform themselves; the platform column
  states which platforms the release guarantees, one row per platform.
  Upstream images are never republished: an `upstream` reference in
  `ghcr.io/micaoss` or `local` is refused, and an offline lock keeps the
  original reference.

`mica-build-env`'s lock lists the approved third-party images as its
`upstream` rows, taken unchanged from its `locks/upstream.lock` (4.1). Every
other repository takes a third-party image only from those rows of
`locks/mica-build-env.lock` and references it by its original name and
digest, reading it from the upstream registry; an image that is not listed
there is proposed to `mica-build-env`.

#### 1.2.2 The `mica-build` rows

A `mica-build` release lock is
`release mica-build <scope>.<YYYYMMDD-HHMM> <commit>` followed by:

- `pool <arch> <reference>` and `package <name> <arch> <version> <sha256>`:
  the scope's board's pool, `mica-build:pool.<board>.<arch>.<release>`, and
  the archives of its board package and radio packages, built there (an `all`
  archive is a layer of the pool and a row of it); a pool whose packages did
  not change is the published manifest under the new tag (section 2);
- `board <board> <component> <arch> <reference>`: one row per built component
  of the scope's board, `mica-build:<component>.<board>.<release>` -- `kernel`
  always, `uboot` and `firmware` where the board has them; a component whose
  inputs hash equals the one the latest release published is that manifest
  under the new tag;
- `input <repository> <release> <sha256>`: each input release, named as its
  consumer files are (`mica-build-env`, `mica-system-base`, `mica-core`,
  `mica-podman`), with the input's `<YYYYMMDD-HHMM>` and the sha256 of its
  `SHA256SUMS`; an input of this repository would be scoped, and there is
  none (`release-scope`);
- `product <product> <board> <profile> <generation> <deployment id> <kernel id>
  <rootfs id>`: `<product>` has the form of a scope and `<board>` that of a
  board (1.0), `<profile>` is `dev` or `prod`, `<generation>` a positive
  decimal, and the three identities are the 64-hex identities of the signed
  deployment, its kernel and its rootfs;
- `bundle <product> image|update <reference>`: the OCI manifests
  `mica-build:image.<product>.<release>` (a layer per image kind, annotated
  `mica.image-kind`) and `mica-build:update.<product>.<release>` (a layer per
  update kind, annotated `mica.update-kind`, `mica.deployment-id` and
  `mica.generation`);
- `asset <product> image|update <kind> <file> <sha256>`: one release asset,
  whose sha256 equals the digest of its layer in that bundle. An image
  kind's asset is `<file>` = `mica-<product>-<YYYYMMDD-HHMM>.<suffix>.gz`,
  the image compressed with `gzip -n -9` by a pinned build-env image, whose
  layer is annotated `mica.compression=gzip`, `mica.uncompressed-sha256` and
  `mica.uncompressed-size`; image kinds are those of the board's
  `images.tsv`. Update kinds are published uncompressed with the suffix fixed
  by the kind: `full` (`micaupd`), `root` (`root.micaupd`) and `kernel`
  (`kernel.micaupd`), `<file>` = `mica-<product>-<YYYYMMDD-HHMM>.<suffix>`.

A reader checks an asset's `<file>` only for the
`mica-<product>-<YYYYMMDD-HHMM>.` prefix, not for the `.gz` suffix.

Every `bundle` and `asset` names a product with a `product` row
(`bundle-without-product`), every `asset` a `bundle` of its type
(`asset-without-bundle`), and every update bundle has a `full` asset
(`update-full`).

#### 1.2.4 Producer data: the `data` row

A producer that computes something about its **own output** which a consumer
must be able to read reproducibly from a pinned release publishes it as a
release asset named by a `data` row:

```text
data <name> <file> <sha256>
```

`<name>` is the producer's own identifier for the datum and is the row's key;
`<file>` is the asset's file name; `<sha256>` is its digest. Both are
`[a-z0-9][a-z0-9.+-]*`.

**`<file>` is a second uniqueness key, and it has no required relation to
`<name>` or to the repository.** Two `data` rows may not name the same file
even under different names -- that is `data-file`, a separate rule from
`duplicate-key`, which is about `<name>`. A reader that implements only the
row's key accepts a lock this format refuses. In the other direction, nothing
constrains the file's form beyond the charset: it need not contain the
repository, the name, or a suffix. `lock/valid/data-file-form.lock` carries
`data` files named nothing like their keys, so a reader that requires such a
relation fails a vector.

An example's incidental properties are indistinguishable from its required
ones, and a reader generalising from one valid vector cannot tell which is
which. When a reader is found to have invented a rule from a valid vector, the
invention names the fixture that disproves it, and that fixture is added.

The instance the row serves is `mica-system-base`'s list of the paths in its
root that no package owns, each with its writer named
(`mica-system-base-unowned.<arch>.tsv`) -- data a consumer needs and cannot
derive.

**Why a kind of its own rather than a wider `asset` row.** `asset` is
product-shaped -- `asset <product> image|update <kind> <file> <sha256>`, tied
to a `bundle` row by `asset-without-bundle` -- and widening it would give one
kind two column layouts, which `column-count` exists to prevent. The
mechanism is shared; the row is its own.

**What a `data` asset may not be.** Not a package: packages live only in the
pools (section 2). Not an image, archive or anything a device installs: those
are 1.2.2's rows. **Not a build input** -- a build reads pools and lock rows,
never another repository's `data` file -- so no repository's build may come to
depend on one. And not mutable: like every other asset it is fixed at its
release, and a correction is the next release.

**What a consumer may assume about a `data` row it does not understand**: that
the file exists in that release and hashes to that value, that it is needed
for nothing, and that skipping it is always safe. Its meaning belongs to the
producer, not to the format. A reader that does not know the `data` kind
refuses the lock with `kind-unknown`, so readers implement the kind before a
producer they pin publishes it (9.1).

#### 1.2.5 The Debian sources: one `apt` row per source

The `apt` rows are the Debian sources a Base root was resolved from, and the
ones a consumer resolves an unpinned package from:

```text
apt https://snapshot.debian.org/archive/debian-security/<ts> trixie-security main /usr/share/keyrings/debian-archive-keyring.gpg
apt https://snapshot.debian.org/archive/debian/<ts> trixie main /usr/share/keyrings/debian-archive-keyring.gpg
apt https://snapshot.debian.org/archive/debian/<ts> trixie-updates main /usr/share/keyrings/debian-archive-keyring.gpg
```

**One row per source, and the key is the source: `<uri> <suite>`.** A release
and its pockets live at different URIs -- security fixes are in
`debian-security`, the rest in `debian` -- and one deb822 stanza with several
URIs and several suites pairs every URI with every suite, so the sources cannot
share a row. Between point releases a fix exists only in `trixie-security` or
`trixie-updates`; a root resolved from `trixie` alone does not carry it until
the next point release reaches `trixie`.

Two rules hold the rows together, each refused by name:

- **`apt-snapshot`**: every `apt` row's URI ends in a snapshot timestamp
  (`<YYYYMMDD>T<HHMMSS>Z`), and it is the same one. The sources are one moment
  of the archive, or a consumer resolves against a mixture no build ever saw.
- **`apt-suite`**: the suites are one release and its pockets -- every suite is
  that release or `<release>-<pocket>` -- and the release itself is among them.
  Pockets are additions to a release, not a source on their own.

The rows sort by key as bytes, like every kind, so `debian-security` comes
before `debian`. A consumer renders **one deb822 stanza per row** (`Types: deb`,
the row's URI, suite and components, `Signed-By` its keyring path,
`Check-Valid-Until: no`), and resolves from all of them together. One row alone
is still a valid lock: the release with no pocket.

#### 1.2.6 Core components

A core component of `mica-core` is two pool items (1.2.7), and the format
knows nothing more of it than of any item:

| | file and layer title | row |
|---|---|---|
| the image, a squashfs of the component's `/usr` and `/etc` followed by its dm-verity hash tree | `<package>_<version>_<arch>.core.img` | `item core.img <package> <arch> <version> <sha256>` |
| the record, the component's `mica/core/v1` without `id` and `content.signature` | `<package>_<version>_<arch>.core.json` | `item core.json <package> <arch> <version> <sha256>` |

What the record is, that it names its image by length and sha256, and that a
pool holds both are `mica-core`'s to gate as the producer
(`mica-core:scripts/deb/package-gate.sh`) and `mica-build`'s to check as the
consumer that signs the record (`mica-build:src/pool/core-items.ts`).

`core` is no kind: a lock carrying a `core` row is refused as `kind-unknown`.

#### 1.2.7 Pool items: the `item` row

A kind is a change in three places: this text and its vectors, the one
implementation (9.1), and every reader, which refuses a kind it does not know
(`kind-unknown`) and so moves before the writer. **What a repository publishes
next is therefore a value, not a kind**: the format extends by value where an
artifact is a registry artifact (an `image` row under a name of the
producer's) and where it is a release asset (a `data` row, 1.2.4); the `item`
row is the same for a layer of a pool.

```text
item <type> <name> <arch> <version> <sha256>
```

keyed by type, name and architecture. An item is one layer of `pool <arch>`
(section 2), the file `<name>_<version>_<arch>.<type>` of the pool, and
`<sha256>` is its digest. `<type>` is a name (1.2) and is the producer's to
choose, except `deb`, which is an archive's file (`field-value`). Its arch must
have a `pool` row (`item-without-pool`). Any repository with a pool may
publish items.

**What the format holds for an item** is what it holds for a package: the row
is unique by its key, the layer is in the pool at that digest, and the version
guard applies unchanged -- a released `<type> <name> <version>` keeps its
digest, and different bytes need a new version (package-versions R4). The
layer carries `mica.inputs`.

**What it does not hold** is anything about one type: what the bytes are,
which repository may publish it, which other item it needs. Those belong to
the producer and to the consumer that reads the type, which checks what it
reads. A reader that does not consume a type skips its rows, and that is
always safe: the rows name layers and ask nothing of a reader. So a new type
is a file its producer adds and a row its consumer reads, **with no change
here, none in `mica-build-tools`, and no reader that has to move first**.

A kind remains the way to add what no value can say -- a row of another
shape, or a rule between rows.

### 1.3 References

A reference of a `pool`, a `board` or a repository's image is
`ghcr.io/micaoss/<repository>[:<tag>]@sha256:<digest>`, with `<repository>`
the image row's source; `upstream` image references are those of 1.2.1. The
digest is what a reader uses; the tag is informational for a reader and may
be absent, as it is for platform manifests. `<repository>` must equal the
release row's. A reference without `@sha256:` is refused. In an offline lock
the registry is `local` instead of `ghcr.io/micaoss`, and only there.

Tags follow the release: every OCI tag in `ghcr.io/micaoss/<repository>` is
`<kind>[.<name>]*.<YYYYMMDD-HHMM>`, its last part exactly the release tag that
published it (for a scoped release its `<YYYYMMDD-HHMM>` part, with the scope
named before it), and no tag carries a commit or a hash:

- `mica-build-env:base.<release>` (an image index) and
  `mica-build-env:<image>.<arch>.<release>` (a per-architecture build push);
- `<repository>:pool.<arch>.<release>`, and for `mica-build`
  `mica-build:pool.<board>.<arch>.<release>`;
- `mica-build:<component>.<board>.<release>` (`kernel`, `uboot`, `firmware`);
- `mica-system-base:rootfs.<release>`;
- `mica-build:image.<product>.<release>` and
  `mica-build:update.<product>.<release>` (the product bundles of 1.2.2;
  `mica-build` publishes no root on its own);
- `<repository>:source.<release>`.

In an offline OCI layout the last part is `offline` (section 6).

A pool manifest carries only release-independent annotations (section 2), so
a pool whose packages did not change is byte-identical across releases: its
new `pool.<...>.<release>` tag is a new tag on the same digest.

A tool that enumerates release tags matches the scope separator as `[./]`
rather than testing for a `.` prefix, so a tag of either separator is found;
a lock never carries the slash form (`field-value`, 1.0).

### 1.4 Order

Rows are sorted by kind in the table's order (`release`, `image`, `pool`,
`package`, `item`, `board`, `upstream`, `apt`, `input`, `product`, `bundle`,
`asset`, `data`), then by key, compared as bytes. The
same inputs therefore give the same bytes.

### 1.5 Refusal rules

A reader refuses the whole lock at the first rule it breaks. The rule names are
the ones the vectors use:

| Rule | Refused when |
|---|---|
| `header` | line 1 is not `# mica-lock v1` |
| `encoding` | not UTF-8, CR, missing final LF, empty line, leading space, trailing tab |
| `kind-unknown` | the first column is not one of the thirteen kinds |
| `image-source` | an `image` row whose source is neither `upstream` nor a repository name, or a repository other than the release row's |
| `column-count` | a row has the wrong number of columns for its kind |
| `release-row` | no release row, more than one, or not the first row |
| `release-scope` | a scoped release (`<scope>.<release>`) in a lock of any repository but `mica-build`, or an unscoped one in its |
| `field-value` | a value outside its form (release tag, scope, commit, arch, platform, name, component, version, sha256, url, roots, apt, profile, generation, identity, bundle type, update kind, asset file name) |
| `reference-digest` | a reference without `@sha256:<digest>` |
| `reference-registry` | a `pool`, `board` or repository image reference outside `ghcr.io/micaoss/` and `local/`, `local/` in a published lock, or `ghcr.io/micaoss/` in an offline lock |
| `reference-repository` | a `pool` or `board` reference to another repository than the release row's, or a repository image reference to another repository than its source |
| `reference-upstream` | an `upstream` image reference in `ghcr.io/micaoss/` or `local/` |
| `duplicate-key` | two rows of one kind with the same key (two `apt` rows for one source included) |
| `base-only-kind` | an `upstream` or `apt` row in a lock of any repository but `mica-system-base` |
| `apt-snapshot` | an `apt` row whose URI does not end in a snapshot timestamp, or two `apt` rows naming different ones (1.2.5) |
| `apt-suite` | `apt` rows whose suites are not one release and its `<release>-<pocket>` pockets, or without the release itself (1.2.5) |
| `package-without-pool` | a `package` row whose arch has no `pool` row |
| `item-without-pool` | an `item` row whose arch has no `pool` row |
| `build-only-kind` | an `input`, `product`, `bundle` or `asset` row in a lock of any repository but `mica-build` |
| `bundle-without-product` | a `bundle` or `asset` row whose product has no `product` row |
| `asset-without-bundle` | an `asset` row without a `bundle` row of its product and type |
| `update-full` | an update `bundle` without the product's `full` update asset |
| `data-file` | two `data` rows naming the same `<file>` |
| `board-components` | a board with `board` rows and none of them for `kernel` |
| `sort-order` | rows out of the order of 1.4 |

Registry checks come on top, when a lock is published or consumed: every
reference, `upstream` rows included, reads back anonymously at its digest,
and every `package` and every `item` sha256 is a layer of that architecture's
pool.

## 2. OCI layout

Pools, boards and images live in `ghcr.io/micaoss/<repository>`, in the
package of the repository that publishes them.

- **Pool** `pool.<arch>.<release>` (`pool.<board>.<arch>.<release>` in
  `mica-build`, one per board): one OCI image manifest per architecture,
  `artifactType` `application/vnd.mica.pool`, an empty config, one layer per
  archive with `mediaType` `application/vnd.mica.deb` and
  `org.opencontainers.image.title` the archive's file name with its real `+`,
  and `mica.inputs=<sha256>`, the inputs hash of the producer and architecture
  that built the archive, the guard against inputs that changed without a
  version bump (package-versions R4). An `all` archive is a layer of both
  pools. A pool item (1.2.7) is one layer, `mediaType`
  `application/vnd.mica.item.<type>`, titled with its file name and carrying
  `mica.inputs`. The manifest carries only release-independent annotations:
  `mica.source-repo` and `mica.arch`. There is no
  `org.opencontainers.image.version`, `.revision`, `.created` or
  `mica.source-commit` on a pool manifest, so a pool whose packages did not
  change keeps its digest and a release only adds a tag to it. `mica.inputs`
  is not in the lock. Board component manifests keep their own annotations
  (below).
- **Board components** `<component>.<board>.<release>` (`mica-build`): a
  board's built parts are published as separate component artifacts, each an
  OCI image manifest with an empty config and one layer per file:
  - `kernel`, `artifactType` `application/vnd.mica.board.kernel`: a UEFI
    board's `kernel/`, or a FIT board's `kernel/dev/` and `kernel/prod/`
    with the DTB;
  - `uboot` (FIT boards), `application/vnd.mica.board.uboot`: the U-Boot
    binaries, the control dtb, the config and the FIT host tools, kept x86-64
    (`uboot-package/` on s905x5m);
  - `firmware`, `application/vnd.mica.board.firmware`: `firmware.tar` and
    `component-copyright`.

  The board's definition, manifests, flashing formats, outputs and trust
  certificate, and the packers of its non-builtin image kinds, are source of
  the commit a release is cut from and are not published. Annotations:
  `mica.board`, `mica.arch`, `mica.component`, `mica.inputs=<sha256>` (the
  component's input key), the source annotations, and
  `mica.verity-cert-sha256`, required on `kernel` and matching where a
  `uboot` or `firmware` component carries it. A release reuses an unchanged
  component by digest: the same manifest bytes under the new release's tag,
  never a re-pointed tag.
- **Images** (build-env images, the Base rootfs): an OCI index and its
  platform manifests; the lock names both (`image` rows with the repository as
  source, `index`, `amd64`, `arm64`). Third-party images are not published here (1.2.1).
- **Product bundles** (`mica-build`): `image.<product>.<release>`, one OCI
  manifest with one layer per image kind, the `.gz` file of 1.2.2 (title the
  file name, annotations `mica.image-kind`, `mica.compression=gzip`,
  `mica.uncompressed-sha256` and `mica.uncompressed-size`), and `update.<product>.<release>`, one layer per update
  kind (annotations `mica.update-kind`, `mica.deployment-id`,
  `mica.generation`); each layer is also a release asset (1.2.2).

Publishing: a tag that already holds another digest is refused, never
re-pointed. An artifact unchanged since an earlier release is reused by
digest: the new release's tag points at the existing digest, and a rebuild
key is metadata, never part of a tag (`mica-build-env` records its key as the
label `com.mica.build-env.inputs` on every platform image config). Everything is
read back anonymously before the lock is written; the lock and `SHA256SUMS`
are uploaded last.

### 2.1 Deletion and what is owed to a published lock

**A release and the images its lock names are one unit.** Images may be
deleted when the releases naming them are deleted in the same operation, so
nothing is ever left pointing at missing bytes. A published lock that resolves
to nothing looks like a working release until someone tries to reproduce it.

**Protection is owed to any release whose images are still named by a
published lock -- not to the release that is merely recent.** The two
questions are different and decide different things:

| Question | What it decides |
|---|---|
| does anything still **build** against it? | whether a **pin** may be dropped |
| does any published lock still **name its images**? | whether those **images** may be deleted |

The protected set is **computable, not a judgement** -- but computing it takes
one hop, and the hop is part of the rule:

> For each published release, take the **commit its lock names**, read
> `locks/mica-build-env.lock` **at that commit**, and collect the image
> references there. `mica-build-env`'s own release lock is the exception: it
> carries `image` rows directly.

**A consumer release lock carries no build-env `image` rows** -- only its
products. Walking the published locks and collecting image references
literally finds none, derives an **empty** protected set, and concludes that
everything is prunable: a silent wrong answer in the one direction that
destroys data. That is why the hop is written into the rule.

With the hop, a retention policy is stated objectively -- *an image release is
prunable only if no published lock names it and it is mirrored* -- and the
derivation is re-run on every sync rather than kept as a list, so the
protected set moves when a lock moves.

What the mirror of `mica-res` holds is a separate question from what a lock
names. Our package pools and board components are not mirrored: `ghcr` holds
the only copy of every Debian package and board component this workspace
publishes, so they may not be treated as protected by the mirror.

## 3. The Base lock: `mica-system-base.lock`

`mica-system-base` publishes one lock:

- `image mica-system-base rootfs index|amd64|arm64`;
- `pool amd64|arm64`;
- `package` rows for the Base's own packages, per architecture;
- `upstream` rows for the pinned later-stage packages, with their roots;
- the `apt` rows, the Debian sources at one snapshot (1.2.5); a consumer that
  runs apt renders one deb822 stanza per row.

**What a release's green covers.** This section says what a release
**carries**; it says nothing about what its CI verdict **means**. A release's
green says the release job ran. The `ci` run on the commit the release targets
is a **different run**, and nothing connects them. A consumer deciding whether
to pin reads the run of the commit the release targets -- the fourth field of
the `release` row (1.2), which every consumer already reads -- not the
release's own green.

## 4. The consumer: `locks/` and `mica-pin v1`

A consumer keeps its inputs at its root, one lock and one pin per producing
repository it reads, and per scope for a scoped repository (1.0; nothing
consumes `mica-build`, the one scoped repository):

- `locks/<repository>.lock`: that producer's lock asset, unchanged;
- `locks/pins/<repository>.pin`: that input's own record. `locks/pins` is a
  directory, so moving one input never edits a shared file and cannot
  corrupt another input's record;
- for a scoped input, `locks/<repository>.<scope>.lock` and
  `locks/pins/<repository>.<scope>.pin`, one pair per board or product the
  consumer reads (`locks/mica-build.uefi-x64.lock`,
  `locks/pins/mica-build.uefi-x64.pin`, were anything to consume it).

A pin file is, in this order and nothing else:

```text
# mica-pin v1
REPOSITORY=<repository>
RELEASE=<YYYYMMDD-HHMM>
SHA256SUMS=<sha256 of that release's SHA256SUMS>
```

A scoped pin has one more line after `REPOSITORY`, `SCOPE=<scope>`, and its
`RELEASE` is the `<YYYYMMDD-HHMM>` part of the scoped tag:

```text
# mica-pin v1
REPOSITORY=mica-build
SCOPE=uefi-x64
RELEASE=20260915-0300
SHA256SUMS=<sha256 of that release's SHA256SUMS>
```

An offline pin has `RELEASE=offline`, `SHA256SUMS` the sha256 of the
checkout's `_out/offline/SHA256SUMS`, and one more line,
`CHECKOUT=<absolute checkout path>`; `CHECKOUT` appears only on an offline
pin.

Rules:

- the file rules of 1.1 apply (UTF-8, LF, final LF); no comment lines after
  the header;
- `REPOSITORY` equals the file name's repository and the lock's release row;
- `SCOPE` is present exactly for `mica-build`, and equals the file name's
  scope and the scope of the lock's release row;
- `RELEASE` equals the lock's release row without its scope (`offline` for an
  offline lock), and the lock itself passes section 1;
- every `locks/<repository>[.<scope>].lock` of a producer has exactly one pin
  of the same name, and no pin exists without its lock; `locks/upstream.lock`
  (4.1) and `locks/mica-build-tools.pin` (4.2) are not producer inputs and
  take no part in this pairing;
- an offline pin is refused under CI (`CI` or `GITHUB_ACTIONS` set) and in
  every release build.

Moving one input replaces `locks/<repository>.lock` and
`locks/pins/<repository>.pin` together and touches no other file; moving one
board or product replaces exactly its `locks/<repository>.<scope>.lock` and
`locks/pins/<repository>.<scope>.pin`.

| Rule | Refused when |
|---|---|
| `header`, `encoding` | line 1 is not `# mica-pin v1`, or as in 1.5 |
| `pin-format` | a key missing, extra, repeated or out of order, `CHECKOUT` on a pin whose release is not `offline`, or no `CHECKOUT` on one that is |
| `field-value` | repository, scope, release or sha256 out of form, or a `CHECKOUT` path that is not absolute |
| `name-mismatch` | `REPOSITORY` differs from the file name's repository |
| `scope-mismatch` | `SCOPE` (or its absence) differs from the file name's scope, or the lock's release row names another scope |
| `release-scope` | a `SCOPE` on a pin of a repository without scoped releases, or none on a pin of `mica-build` |
| `pin-without-lock` | a pin without its lock of the same name |
| `lock-without-pin` | a lock without its pin of the same name |
| `lock-invalid` | a lock that fails section 1, or whose release row names another repository |
| `release-mismatch` | `RELEASE` differs from the lock's release row without its scope |
| `checkout-in-ci` | an offline pin (`CHECKOUT`) under CI or in a release build |

### 4.1 Third-party inputs: `locks/upstream.lock`

Every repository pins its third-party inputs in one consumer file,
`locks/upstream.lock`. Build parameters that are not pins, such as
`mica-build-env`'s `*_FLOOR_*_MIN` minimum versions, stay in the repository's
own configuration.

It is not a release asset: it has no release row and no pin. It follows the
file rules of 1.1 and the order of 1.4 (kinds in the order below, then key),
with three kinds only:

| Kind | Columns | Key | Meaning |
|---|---|---|---|
| `image` | `image upstream <name> <platform> <reference>` | source, name, platform | a third-party image, the row of 1.2.1; the source is always `upstream` |
| `source` | `source <name> <arch> <version> <sha256> <url>` | name, arch | a downloaded archive (a toolchain, an upstream source tarball, a vendor blob); `<arch>` is `amd64`, `arm64` or `all`; `<url>` is https |
| `git` | `git <name> <url> <ref> <commit>` | name | a git tree pinned by commit (a kernel, U-Boot, an upstream tag); `<ref>` is the tag or branch name, informational; `<commit>` is 40 lowercase hex |

Only `mica-build-env` keeps `image` rows here: they are the list of approved
third-party images its lock carries unchanged (1.2.1); every other repository
takes those images from `locks/mica-build-env.lock`.

`mica-tools repos check` verifies every `source` and `git` row of
`locks/upstream.lock`, and the `upstream` rows a repository takes from a
producer lock, against `repos/`; `mica-tools repos get` and `mica-tools repos
git` take their arguments from these rows.

| Rule | Refused when |
|---|---|
| `header`, `encoding`, `column-count`, `field-value`, `duplicate-key`, `sort-order` | as in 1.5 |
| `upstream-release-row` | the file has a `release` row |
| `kind-unknown` | a kind other than `image`, `source` or `git` |
| `image-source` | an `image` row whose source is not `upstream` (a repository name included) |
| `reference-digest` | an image reference without `@sha256:<digest>` |
| `reference-upstream` | an image reference in `ghcr.io/micaoss/` or `local/` |

### 4.2 The build tools: `locks/mica-build-tools.pin`

Every repository runs the tools that implement this document at one
`mica-build-tools` commit, recorded in `locks/mica-build-tools.pin`:

```text
# mica-tools-pin v1
REPOSITORY=mica-build-tools
COMMIT=<40 lowercase hex>
```

The file rules are those of 9.2: the header, exactly these two keys in this
order, comment lines allowed after the header, `COMMIT` the full commit.
Refusals: `header`, `encoding`, `pin-format`, `field-value`.

It sits in `locks/` because it is an input the repository pins, and beside
`locks/pins/` rather than in it, because `mica-build-tools` publishes no
lock: a file in `locks/pins/` is a `mica-pin v1` with its lock (section 4).
Moving it touches no other file of `locks/`. `bin/mica-tools`, the bootstrap
every repository copies from `mica-build-tools`, reads it before anything
else runs, and `mica-tools locks check` checks it with the rest of `locks/`.

## 5. The source cache: `repos/` and `mica-tools repos`

Every repository has `repos/` at its root, git-ignored:

- `repos/sha256/<hex>`: content-addressed archives (toolchains, Debian
  snapshot archives, podman, netavark and crun tarballs, vendor blobs);
- `repos/git/<name>.git`: bare mirrors where a pin is a commit or tree hash
  (kernel, U-Boot). `bin/mica-tools` keeps its own checkout here too, in
  `repos/git/mica-build-tools.git` and `repos/mica-build-tools/`.

`mica-tools repos` is implemented once, in `mica-build-tools`, and every
repository runs it at the commit its `locks/mica-build-tools.pin` names:

- `repos get <sha256> <url> <out>`: take the archive from
  `repos/sha256/<sha256>`, or download it, verify its sha256, store it, then
  copy it to `<out>`. A cached file that does not hash to its name is refused
  (`cache-corrupt`), never silently re-downloaded. A download may be served
  by the mirror `MICA_MIRROR` names and falls back to the row's URL on any
  mirror failure; the sha256 is checked whichever source served, so a mirror
  adds no input (`mica-build-tools:docs/design.md` 3.2).
- `repos git <url> <commit|tree> <dir>`: check the pinned commit or tree out
  of `repos/git/<name>.git`, fetching into the mirror first when it is
  missing, and verify the checked-out commit or tree hash.
- `repos check`: every `source` and `git` row of `locks/upstream.lock`
  (4.1), and every `upstream` row the repository takes from a producer lock,
  is present in `repos/` and hashes right.
- With `MICA_OFFLINE=1`, a miss is a refusal naming the pin (`offline-miss`)
  and nothing is fetched.

The cache never adds an input: only a pinned sha256, commit or tree enters a
build, and an offline build's output is byte-identical to the online one.
The exception is an artefact whose **local build is not the same build as its
CI build**. The question is asked per artefact, not per repository: does this
build run on the target platform, or on the host with a cross toolchain?

- On the target platform, local and CI differ only by emulation, and
  emulation reproduces: C, make, meson, ninja, data packaging and Rust built
  in a container run on the target platform give the same bytes emulated as
  native.
- On the host with a cross toolchain, while CI builds natively on a runner of
  that architecture, the two halves come out of **different toolchains**.
  `mica-core`'s arm64 packages have this shape: cross-built locally and native
  in CI, they differ in stamps and linker layout, not in machine code. A local
  arm64 archive from an amd64 host is a valid archive and is not the
  published one.

CI is the authority for an architecture's half wherever the two builds
differ. Where they are the same build, a local rebuild is authoritative.
Language dependencies keep their own hashes (`Cargo.lock`, `bun.lock`,
`go.sum`) and are vendored into `repos/`. Base images by digest stay in the
local image store; offline, a missing one is refused.

## 6. `make offline`

Each repository's `make offline` builds its release outputs from `locks/`
into `_out/offline/`:

- `<repository>.lock`: a lock whose release row has `offline` (or
  `<scope>.offline`, one lock per scope built) and the checked-out commit; a
  dirty tree is refused;
- `oci/`: an OCI image layout holding every pool, board and image the lock
  names, by digest;
- `SHA256SUMS` over the lock.

References use the registry name `local`
(`local/<repository>:pool.amd64.offline@sha256:<digest>`) and resolve only
inside that checkout's `_out/offline/oci/`.

## 7. `mica-tools local-lock`

`mica-tools local-lock <repository>[.<scope>] <checkout>` verifies
`<checkout>/_out/offline/SHA256SUMS` and every digest the lock names in the
checkout's OCI layout, writes `locks/<repository>[.<scope>].lock` unchanged
and the offline pin `locks/pins/<repository>[.<scope>].pin`. It is refused under GitHub Actions and in every
release build. Its result is committed on a local branch that is never pushed,
so a composer still binds to a clean commit.

## 8. The workspace driver: `mica-build:src/offline/chain.ts`

The driver builds `mica-build-env`, then `mica-system-base`, then
`mica-core` and `mica-podman` in parallel, then `mica-build`,
over throw-away `git clone --shared` clones of each checkout's `HEAD` under
`<workspace>/.mica-offline/<stamp>/<repository>`. For every input it runs
`mica-tools local-lock` and commits the locks on `offline/<stamp>` in the clone;
every clone's `repos/` reads through to its checkout's `repos/`. It outputs
the product images, a summary of every lock and digest, and every checkout
commit.

## 9. Test vectors

The vectors are `docs/spec/release-lock/vectors/` of this repository. One
implementation reads them, the one beside them (`tests/vectors.test.ts`),
every family and every row; no other repository carries a copy (9.1).

- `expected.tsv`: one row per vector, tab-separated: path (relative to
  `vectors/`), `valid` or `refused`, the rule of 1.5, section 4 or 4.1 (or `-`),
  and the mode (`ci`, `local`, `offline`, or `-`).
- `lock/valid/`: one valid lock per producer shape, covering every row kind:
  `mica-build-env.lock` (`image`: `mica-build-env` rows for the built images,
  `upstream` rows with the original names and index-digest references and a
  `386` row), `mica-core.lock`
  (`pool`, `package`), `mica-core-components.lock` (`pool`, `package` rows
  for the two packages built into the root, `item` rows of the types
  `core.img` and `core.json` for two core components),
  `mica-podman-items.lock` (`pool`, `package`, `item` rows of two types, one
  name under both),
  `mica-system-base.lock` (`image`, `pool`, `package`, `upstream`, three
  `apt` rows for a release and its two pockets, a comment),
  `mica-system-base-data.lock` and `data-file-form.lock` (`data` rows),
  `offline-mica-core.lock` (an offline lock with `local/`
  references), `mica-build.uefi-x64.lock` (a scoped `mica-build` lock: the board's
  `pool`, `package` and `board` rows, `input`, `product`, `bundle`, `asset`
  rows, a `root` update beside `full`), `mica-build.uefi-x64.basic.lock` (a
  product-scoped `mica-build` lock, `<board>.<variant>`).
- `lock/refused/`: one lock per refusal rule of 1.5, each written against a
  valid lock and **declaring which one** in `derived-from.tsv` (9.3); the image refusals are `image-source.lock` (a repository source
  other than the release row's), `image-source-reference.lock`
  (`reference-repository`, a reference outside the source's repository),
  `image-registry.lock` (`reference-registry`),
  `upstream-image-republished.lock` (`reference-upstream`) and
  `upstream-image-without-digest.lock` (`reference-digest`); the scope
  refusals are `scoped-release-not-allowed.lock` and `unscoped-release.lock`
  (`release-scope`), `release-slash.lock` (`field-value`, a
  `<scope>/<release>` release) and `scope-two-dots.lock` (`field-value`, a
  product with two variants); the component refusals are
  `board-component.lock` (`field-value`), `board-duplicate-component.lock`
  (`duplicate-key`) and `board-components.lock` (`board-components`, no
  `kernel` row); the `mica-build` refusals are `build-only-kind.lock`,
  `bundle-without-product.lock`, `asset-without-bundle.lock`, `update-full.lock`
  and `update-kind.lock` (`field-value`, a `firmware` update); the source refusals are `apt-duplicate.lock`
  (`duplicate-key`, one source twice), `apt-snapshot.lock` (a pocket at another
  snapshot) and `apt-suite.lock` (pockets without their release); and
  `core-row.lock` (`kind-unknown`, a `core` row, 1.2.6).
- `pins/valid/` and `pins/refused/`: directories holding a `locks/` content
  (the `.lock` files and `pins/<repository>[.<scope>].pin`); `release`
  (checked in `ci` mode) and `offline-checkout` (in `local` mode) are valid;
  one directory per rule of section 4: `name-mismatch`, `release-mismatch`,
  `pin-without-lock`, `lock-without-pin`, `checkout-in-ci`, plus `header`,
  `key-order` and `checkout-without-offline` (`pin-format`),
  `checkout-relative` (`field-value`), `lock-invalid`, and `scope-not-allowed`
  (`release-scope`). The `scope-mismatch` rule has no vector.
- `upstream/valid/upstream.lock` (`image`, `source` including an `all` row,
  `git`) and `upstream/refused/`: `release-row.lock`
  (`upstream-release-row`), `other-kind.lock` (`kind-unknown`),
  `repository-source.lock` (`image-source`), `image-republished.lock`
  (`reference-upstream`), `image-without-digest.lock` (`reference-digest`),
  `source-without-sha256.lock` (`column-count`), `git-short-commit.lock`
  (`field-value`), `unsorted.lock` (`sort-order`). The valid pins case
  `pins/valid/release` also holds a `locks/upstream.lock` without a pin.
- `tools-pin/valid/` and `tools-pin/refused/`: the commit pin of 9.2.
- `repos/`: the offline side of `repos get`: each directory holds a
  `repos/sha256/` cache and a `request` (sha256, url); `cache-hit` is valid,
  `cache-corrupt` and `offline-miss` are refused, all under `MICA_OFFLINE=1`,
  and `fetch-miss` is refused outside offline mode (`fetch-required`).

Registry checks (section 1.5, last paragraph) and `repos git` have no file
vectors.

`bun run check` reads every vector with the implementation and fails when a
result or rule differs from `expected.tsv`, a collected set from
`refusal-sets.tsv` (9.4), a vector is not listed, or a refused lock does not
hold to the derivation it declares (9.3).

A rule this text states and no vector asserts is not held by anything, so a
rule is added with the vector that breaks it.

### 9.1 One reader of the vectors

- **`mica-build-tools` is the one reader, and holds the vectors.** They are
  files of its own tree, so the text, the vectors and the implementation are
  one commit and cannot lag each other. It asserts every row of
  `expected.tsv` and `refusal-sets.tsv` (9.4), every family. There is no
  subset: it reads every form any repository reads or writes.
- **No other repository carries vectors, a reader or a pin of them.** A
  repository conforms by pinning a `mica-build-tools` commit, in
  `locks/mica-build-tools.pin`. `mica` names this repository and states no
  rule of the lock.
- **A rule changes here**: the text, its vectors and the implementation in
  one commit, then each reader moves its `locks/mica-build-tools.pin`. A
  writer emits a new form only after every repository that reads its lock
  pins a commit that reads it: **readers move before the writer.**

### 9.2 The commit pin: the file rules of `mica-tools-pin v1`

`locks/mica-build-tools.pin` (4.2) is the one file of this form:

```text
# mica-tools-pin v1
REPOSITORY=mica-build-tools
COMMIT=<40 lowercase hex>
```

Exactly those two keys, in that order. **Comment lines (`#`) may follow the
header** and carry nothing the gate acts on: a repository that pins a commit
carrying a known defect names the defect there, above the keys. **A comment
naming a defect is removed in the commit that moves the pin past it** -- a
comment that outlives its defect is the next stale comment. Anything else is
refused. `COMMIT` is the full commit, never a short one: the file is read by
a gate rather than by a person. Refusals, in the vocabulary of 1.5: `header`
(any other header), `encoding` (no final newline, a CR, not UTF-8),
`pin-format` (any other key set or order) and `field-value` (a repository
name or commit outside its form, or a repository other than
`mica-build-tools`). The vectors under `tools-pin/` prove them.

**Do not pin a known defect silently.** Removing the pin does not remove the
artefact -- the copy carries those bytes either way, and unpinned it carries
them unverifiably. So a repository that must pin a commit carrying a known
defect names the defect in the pin file, with what a later reader needs: a
pin is a statement about one commit and never about the newest one, so the
gate will not notice the repair on its own.

A pin move is one edited line, and it costs whatever downstream of it has to
be re-fetched, rebuilt or re-recorded; whether a move is cheap is a count of
what the pin holds up, not of the lines it occupies.

### 9.3 `derived-from.tsv`: which valid vector a refused one is written against

Every refused lock and upstream vector declares its sibling, because the
intent otherwise exists only in whoever wrote the fixture. Rows are
`<refused vector>\t<relation>\t<valid vector>`:

- **`edit-of`** -- a small edit of that vector: **at most two changed lines**,
  and not identical.
- **`reorder-of`** -- exactly that vector's rows in another order, so **order
  is the only rule it can break**. The relation *is* the argument, and the
  gate checks it by sorting both files.
- **`minimal-of`** -- an independently written minimal lock of the same shape,
  so no line bound applies and the sibling names the **shape** rather than the
  source text.

The pairing is declared rather than derived, because pairing by smallest diff
picks the wrong sibling. `bun run check` asserts that every refused lock and
upstream vector has a row and only those do, every sibling is itself a listed
vector, no vector is identical to its sibling, an `edit-of` changes at most
two lines, and a `reorder-of` -- and every vector named `unsorted.lock` --
holds exactly its sibling's rows.

**A refused vector whose row multiset equals a valid vector's can only break an
order rule**, because every other rule in this format is a predicate on a row
or on a set of rows, and both are invariant under permutation. More generally,
for each refused vector, the rules whose predicates its difference from the
declared valid vector can reach bound what it can be refused for; where that
set has one member, the vector is single-rule by inspection. The `minimal-of`
vectors differ by rows, so their reachable set is not a singleton by
inspection, and they need the collect mode (9.4).

**Each refused vector breaks the rule it names, and no incidental defect
beside it.** A fixture that could be refused by two rules can pass for the
wrong reason. Two properties are kept apart:

| | The question it asks | How it is measured | What it misses |
|---|---|---|---|
| **One defect** | does the fixture carry a second, *incidental* defect? | repair the named defect, require `valid` | a single token that breaks two rules |
| **One refusal** | which rules refuse *this* file? | the collect mode | nothing, where it can run |

Some pairs are **inherent**: one token breaks two rules, and no single fixture
can separate them. The record is the pair, in `refusal-sets.tsv`, rather than
a fixture contorted until it tests less:

| Vector | Names | Also breaks | Why they cannot be separated |
|---|---|---|---|
| `lock/refused/release-slash` | `field-value` | `release-scope` | a slash-form release is malformed *and* wrongly scoped by the same token |
| `lock/refused/release-value` | `field-value` | `release-scope` | as above |
| `lock/refused/upstream-image-without-digest` | `reference-digest` | `field-value` | a reference without a digest fails its form test too |
| `upstream/refused/image-without-digest` | `reference-digest` | `field-value` | as above |
| `upstream/refused/release-row` | `upstream-release-row` | `kind-unknown` | a `release` row in an upstream lock is a kind that file may not carry |
| `lock/refused/reference-without-digest` | `reference-digest` | `field-value` | as above |

A coverage rule that counted an inherent pair as a bad fixture would push
somebody to make it test less; the collect mode and `refusal-sets.tsv`
therefore **report rather than refuse**.

### 9.4 `refusal-sets.tsv`: every rule a refused vector breaks

`expected.tsv` names **one** rule per vector, because that is the contract of
a short-circuiting reader: the first-rule behaviour is the table's contract,
not an implementation detail. The collect mode (`lock check --collect`)
answers a different question, and its answers are recorded beside the vectors
in `vectors/refusal-sets.tsv`, so a gate reads them:

```text
<vector>	<set|stopped>	<rules, sorted, space separated>	<valid|unmeasured>
```

- **column 2** is which form the mode returned: a complete set, or a stop;
- **column 3** is the rules it found, sorted -- *sorted*, because discovery
  order is an artefact of the mode's own ordering and nothing should be
  asserted about it;
- **column 4** is whether repairing the named defect was measured, by hand, to
  make the file valid. It is **hand-measured and the gate cannot re-derive
  it**: the repairs are not stored, so the gate checks only that the word is
  one of the two it may be. `unmeasured` is a word this column must be able to
  say -- a column that can only say `valid` records nothing.

The mode reports every rule a file breaks by re-running the checker with each
rule found suppressed. Suppressing a rule to see what fires next is only safe
where the continuation is safe:

- A **structural** refusal -- `header`, `encoding`, `kind-unknown`,
  `column-count`, `release-row` -- makes the rest of the file unreadable, so
  it is reported alone; the mode never mixes a structural refusal with
  semantic ones.
- Suppression is not repair: it leaves the malformed value in place and lets
  the following code read it. A run that raises anything other than a refusal
  **stops** and reports what it had found (`stopped`). A stop truncates rather
  than taints: every refusal raised before it stands.
- The mode **under-reports by construction** and never invents a rule.

`bun run check` re-runs the mode over every refused lock and upstream vector
and compares. It **pins a measurement, it does not prove a property**: a
matching row means today's reader finds what the recorded reader found, and a
mismatching one is a finding either way round -- a vector that starts breaking
a second rule, or stops breaking one it did, turns a silent change into a red
gate. The rows are checked against the refused lock and upstream vectors of
`expected.tsv` in both directions, and the rule `expected.tsv` names must be
in each row's set.
