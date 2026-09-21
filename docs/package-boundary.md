# Package boundary

`package.json` defines an explicit `files` allowlist instead of inheriting a
distribution boundary from `.gitignore`. Compiled JavaScript, declarations and
their maps are shipped together with TypeScript sources (including tests).
Source is intentional: maps reference these files, and existing source-oriented
development/test scripts remain available. This is not an artifact-size reduction.

The package also retains `tsconfig.json`, the four existing test/demo scripts and
the package acceptance script, documentation, README, license, security and
contribution guidance. `qwen-loop.config.example.json` is retained as a **legacy**
migration example, not the current mission configuration schema. npm includes
the package manifest needed by the CLI's version lookup.

Incidental root files, local agent settings, runtime state and CI configuration
are outside the boundary. This is **not secret scanning**: a secret accidentally
written into intentionally shipped TypeScript, JavaScript or Markdown can still
be distributed. Review the artifact and its contents before publication.

## Verification

After installing dependencies and building from the repository:

```sh
npm run test:package
```

The gate creates harmless required-file placeholders in a temporary fixture,
copies only the package manifest and optional Git ignore rules, adds synthetic
incidental files, and checks a dry-run inventory for required
inclusions and exclusions. It then packs the real project into a retained
temporary directory, unpacks it, checks source/declaration-map targets, imports
the public module, runs CLI help and runs all four provider-free demo scenarios
from that unpacked artifact.

The unpacked consumer reuses this checkout's installed dependencies through a
symlink/junction. This proves artifact behavior against those dependencies, not
a fresh dependency installation or registry publication. CI first uses `npm ci`
in the source checkout. There are no registry writes or vendor-agent calls.
The separate `npm run test:e2e` gate remains the packed crash/recovery acceptance.

Fixtures are retained for inspection; remove only the exact printed temporary
directory when its evidence is no longer needed. Development setup and locked
rebuild instructions continue to target a Git checkout, not a registry archive.
