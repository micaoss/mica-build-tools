# mica-build-tools

The rules every Mica OS repository applies when it builds, publishes and
consumes artifacts, and their one implementation: the release lock with its
test vectors, the rules of package versions and the build rules
(`docs/spec/`). TypeScript on Bun, with no runtime dependency.

The rules of the lock are kept here, beside the code that reads them, so a
rule, its vectors and its implementation are one commit; every repository
pins this one by commit and carries no reader, pin checker, vectors copy,
inputs hash, version guard, pool publisher, Debian packer or shell lint of
its own.

## Using it

A repository keeps two files:

- `locks/mica-build-tools.pin`, the commit it runs, beside its other pinned
  inputs (`docs/spec/release-lock.md` 4.2):

  ```text
  # mica-tools-pin v1
  REPOSITORY=mica-build-tools
  COMMIT=<40 lowercase hex>
  ```

- `bin/mica-tools`, a copy of `bootstrap/mica-tools`: it checks the pin, checks
  the commit out under `repos/mica-build-tools/` (offline with `MICA_OFFLINE=1`
  once cached), and runs it with bun.

```bash
bin/mica-tools locks update --check              # which pinned inputs are behind; changes nothing
bin/mica-tools locks update                      # move every pin to its latest release
bin/mica-tools locks verify
bin/mica-tools from --ref mica-build-env:base
bin/mica-tools repos check
```

[docs/manual.md](docs/manual.md) has the setup, the environment and every
command.

TypeScript repositories import the same checkout through the path alias
`@mica/build-tools`.

## Documents

| Document | What it holds |
|---|---|
| [docs/manual.md](docs/manual.md) | setting a repository up, the environment, every command with its arguments, output and exit status, and the workflows |
| [docs/spec/release-lock.md](docs/spec/release-lock.md) | the release lock, pins, the source cache and the offline build: the format every release is described in, with its vectors |
| [docs/spec/package-versions.md](docs/spec/package-versions.md) | a package is locked by its own version: the rules `pool guard`, `deb pack` and `pool gate` hold |
| [docs/spec/build-rules.md](docs/spec/build-rules.md) | what every repository follows when it releases, pins images, publishes, reads and packs: the rules the commands hold |
| [docs/design.md](docs/design.md) | what this repository owns, how it is consumed, the contracts of packaging and publishing, the data formats, conformance, how a rule changes, and how a repository adopts it |

## Development

```bash
bun install
bun run check      # lint, typecheck, test; a run with no test is red
```

The conformance test reads `docs/spec/release-lock/vectors/`; a rule is
added with the vector that breaks it.

## Status

Every command of `docs/manual.md` is implemented, and every vector
passes. `mica-build-env`, `mica-system-base`, `mica-core`, `mica-podman` and
`mica-build` run it (`docs/design.md` section 8).
