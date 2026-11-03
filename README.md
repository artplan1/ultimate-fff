# ultimate-fff

Fast file and content search for [Ultimate](https://github.com/HazAT/ultimate), backed by [fff](https://github.com/dmtrKovalenko/fff). One `search` tool instead of shelling out to `rg`, `grep` or `find` on every query.

## Install

Clone this into your project's extensions and install its dependency:

```bash
git clone https://github.com/artplan1/ultimate-fff.git .ultimate/extensions/search
cd .ultimate/extensions/search && npm install
```

Ultimate loads `.ultimate/extensions/` on its own, so the tool appears without any config change. It needs Ultimate with `@earendil-works/pi-durable` 1.5.0, and Node 26 or newer. The native binary supports macOS, Linux and Windows on x64 and arm64; on a platform without one, a search returns the error instead of crashing.

To use it on every project on a machine, clone into `~/.ultimate/extensions/search` instead.

## The tool

`search` runs over the conversation's working directory.

- `pattern` searches inside files. A pattern that uses regular-expression syntax and compiles is matched as a regular expression; anything else is literal text, taken exactly as written, so spaces and glob characters that do not form a valid expression never become query constraints. Passing both `query` and `pattern` is rejected.
- `glob` limits either search, or lists matching files when it is the only argument. `?`, character classes, braces and spaces in a path all work. A glob without a `/` that starts with `*` matches file names at any depth; any other matches the path relative to the working directory, so use `**/` to reach nested files.
- `context` adds lines around each content match (default 2, at most 10). `limit` bounds the items returned (default 30, at most 100).

A pattern cannot contain a newline, because the matcher searches line by line. A pattern with regex characters that does not compile is matched as literal text instead.

Results say what they know. File counts are exact. For content, the count is the number returned, and "more matches than shown" appears only after the search actually found one further match — never guessed. A full content total would mean scanning every file on every search.

## Index

One native index per working directory, built on first use and scanned once before searching. A scan that does not finish within 30 seconds fails the call instead of searching a partial index. An index with no calls left is released after five idle minutes, and disabling or reloading the extension releases the rest. A conversation that changes its working directory gets its own index.

Search is read-only. Indexes are created without frecency or history databases and nothing is written to the project or the home directory, so a read-only agent can search safely. The index follows file changes, so files created during a conversation are found without a rescan.

## Measured

On a repository of 826 files, against spawning `rg` for each query:

| query | this tool | `rg` per spawn |
| --- | --- | --- |
| fuzzy file search | 2.3 ms | ~20 ms |
| glob | 0.4 ms | ~20 ms |
| content search | 4.6 ms | ~20 ms |

The first search in a directory pays about 700 ms to build the index. The index and its watcher then use about 68 MB, which is why idle indexes are released.
