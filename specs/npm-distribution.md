# npm distribution

## Package and ownership

Publish the existing unified TUI, local Web and Agent runtime as public npm
package `@ljwei-stak/zcode-cli`, initially version `3.16.2`, with command `zcode`.
The source workspace stays private to package managers; it is not the npm
artifact. The repository and upstream attribution remain public and unchanged.

The npm package contains the original verified GitHub runtime archive as
`payload/zcode-runtime.tar.gz`, plus its SHA256/version manifest, an ESM command
and the installer. It includes a pinned `tar@7.5.22` extraction library with its
dependency closure through npm's explicit bundledDependencies mechanism. There
is no GitHub download during npm installation or startup. Keep upstream LICENSE,
NOTICE, third-party notices and provenance with the package and runtime.

The installer owns immutable extracted runtime assets only. It does not own or
migrate Agent sessions, user provider settings, accepted commands or Web state.
The command imports the existing runtime launcher in the same process, retaining
the terminal and original arguments. Only the existing launcher routes a leading
`--web`; other CLI behavior remains upstream.

## Installation, integrity and cache

1. Postinstall attempts package-local `runtime/`; permission failure may fall
   back to the user's cache. A command first reuses a valid package-local runtime.
2. If scripts were disabled or the package directory is read-only, the command
   prepares the runtime in the user's OS cache, using existing standard variables
   such as LOCALAPPDATA and XDG_CACHE_HOME, without adding ZCODE environment flags.
3. Cache layout is `<OS cache root>/zcode-cli/npm/<version>-<first16 SHA256>`.
   Runtime roots contain bin, agent, server and web directly. Completion marker
   `.zcode-npm-runtime.json` records the full digest and version.
4. Verify the embedded archive's SHA256 before extraction. Reject archive paths
   outside the single `zcode/` root, traversal, links and special files; enforce
   bounded compressed and expanded sizes. Use the maintained tar implementation
   with strict checks and ownership preservation disabled.
5. Extract to a private sibling staging directory, normalize directory modes to
   0755 and ordinary files to 0644, and explicitly set executable CLI entries and
   macOS node-pty spawn-helper files to 0755. Windows-produced tar headers do not
   preserve the required executable bits reliably.
6. Check required runtime files, write the marker, then rename into place. A
   concurrent winner is accepted only if the existing target is complete and
   matches the same full digest. Never delete a previously prepared runtime to
   start installation, and never remove a live runtime holding native libraries.
7. Errors must produce a failing install/startup exit code. Digest or extraction
   failure must not execute runtime code or damage an existing complete runtime.

## Publication and verification

Build the npm artifact in ignored `dist/npm/`, preserving the verified payload
bytes. Review npm publish --dry-run's actual packed list, scan publishable files,
and check bin, bundled dependency closure, notices, payload digest and version.
Publish the exact reviewed `.tgz` with public access, then verify registry
metadata/integrity and a registry installation.

Test small fixtures for digest rejection, extraction boundaries, permission
normalization, atomic/concurrent preparation and user-cache fallback. Install the
actual npm tgz into a repository-external prefix containing spaces, testing both
normal and --ignore-scripts installs. Verify the installed command's version and
Agent/Web help; run real TUI/Web smoke through the installed npm entry on Windows
and Linux without model prompts. Existing archive-mode smoke must remain intact.
Report macOS execution separately; executable-mode checks are not macOS runtime
validation.
