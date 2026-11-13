# Adding a plugin to the directory

Anyone can list a plugin. The directory checks who it's from and that its release is what it says;
it doesn't review what the plugin does. Admins see everything a plugin asks for before it runs.

1. **Publish releases on GitHub.** In your plugin's repository, each release carries:
   - `<id>-<version>.zip` (what `scripts/pack.py` makes: `castor-plugin.yaml` at its root),
   - `<id>-<version>.zip.sha256` (`sha256sum` output: the hash, then the file name),
   - `castor-plugin.yaml` and, if you like, `README.md` and `icon.svg|png|webp` (shown while browsing).

   Tag it `v<version>` (or `<prefix><version>` with a `tag_prefix` for a repository holding several
   plugins). The version in the tag, the manifest and the file names must agree. Pre-releases and
   drafts are ignored. Never replace a released file: installed copies are checked against its SHA-256.

2. **Open a pull request** to `directory.json`:
   - Your publisher, once, under `publishers`: an `id` (lowercase and dashes), a `name`, the
     `github` accounts (users or organisations) your plugins' repositories belong to, and
     optionally a `url` and `description`.
   - Your plugin under `plugins`: `id` (the manifest's, and free in the directory), `name`,
     `publisher` (your publisher id, which must also be the manifest's `publisher:`),
     `description`, `repo` (`owner/name`, on one of your publisher's accounts) and `tags`.

3. **CI checks it:** the directory still reads, the id is free, the repository is yours, and the
   newest release downloads, matches its SHA-256 and holds a manifest Castor accepts with your id,
   publisher and version.

After that, new releases need no pull request: Castor finds them, and admins are told an update
is ready.

## Official plugins

They live in `plugins/` here. Change one, bump its `version:`, and merging releases it.
