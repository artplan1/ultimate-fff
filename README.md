# ultimate-fff

Two read-only search tools for [Ultimate](https://github.com/HazAT/ultimate): `grep` searches file contents, `find` finds files by path. [fff](https://github.com/dmtrKovalenko/fff) indexes paths and literal text; ripgrep searches raw regex.

## Install

Clone this into your project's extensions and install its dependency:

```bash
git clone https://github.com/artplan1/ultimate-fff.git .ultimate/extensions/fff
cd .ultimate/extensions/fff && npm install
```

The folder name is the extension's id, so clone it as `fff`. Ultimate loads `.ultimate/extensions/` on its own, so the tools appear without any config change; disabling the extension is `extensions.disable: ["fff"]`.

Install ripgrep (`rg`) on `PATH` in the environment running Ultimate, for example `brew install ripgrep` on macOS. Regex searches require it; literal and file searches do not.

It needs Ultimate with `@earendil-works/pi-durable` 1.5.0, and Node 26 or newer. The native binary supports macOS, Linux and Windows on x64 and arm64; on a platform without one, a search returns the error instead of crashing.

To use it on every project on a machine, clone into `~/.ultimate/extensions/fff` instead.

## The tools

Both search the conversation's working directory.

- `path` takes a file or a directory, relative to the working directory or absolute. Inside the working directory the search reuses its index; outside, that directory is indexed on its own. Paths come back relative to the working directory, and absolute for a search outside it, so every path can be read as it is.
- `limit` bounds the items returned (default 30, at most 100).

### grep

`grep` searches contents line by line; `pattern` is required.

- `pattern` is literal text, unless it uses regex syntax and compiles: then it runs through rg's default engine, without rewriting. An expression that engine rejects (such as lookahead) retries as exact literal text. Content matching uses smart-case: uppercase makes it case-sensitive.
- `glob` narrows the searched files, e.g. `src/**/*.ts`.
- `context` adds lines around each match (default 2, at most 10).

```
grep({ pattern: 'startServer(' })
grep({ pattern: 'TODO|FIXME', path: 'src' })
grep({ pattern: 'createIndex', glob: '**/*.ts', context: 3 })
```

A pattern cannot contain a newline: content search is line by line. A `path` naming a file or a directory the index skips — an ignored one, say — fails with that reason instead of reporting no matches; one that is simply empty reports nothing. Prefer bare identifiers for efficient matching, narrow with `path` or `glob`, and read files when you need more context.

### find

`find` finds files by path; `pattern` is required.

- A pattern that uses glob syntax — `?`, `*`, `[` or `{` — is listed exactly as a glob. `?`, character classes, braces and spaces in a path all work. A glob without a `/` that starts with `*` matches file names at any depth; any other matches the path relative to the working directory, so use `**/` to reach nested files.
- Any other pattern is a fuzzy path match: words find the files whose path contains them.
- `glob` narrows either kind to the paths it matches, so a fuzzy pattern and a glob intersect.

```
find({ pattern: 'workflow runner' })
find({ pattern: 'src', glob: '**/*.ts' })   // fuzzy words, .ts files only
find({ pattern: '**/*.tsx', path: 'extensions' })
find({ pattern: '*', path: 'src/index.ts' })
```

## RegEx and counts

Regex uses rg's default ignore rules, skips binary files and files over 10 MB, and ignores user rg configuration. `glob` still filters results through fff's glob listing. Results stream until one further match is proven and the last visible match has its context; the tool then stops rg. Regex results do not promise the index's order. A missing `rg` fails regex search with an installation hint.

Results say what they know. File counts are exact. For content, the count is the number returned, and "more matches than shown" appears only after the search actually found one further match — never guessed. A full content total would mean scanning every file on every search.

## Index

One native index per searched directory, built on first use and scanned once before searching. A scan that does not finish within 30 seconds fails the call instead of searching a partial index. An index with no calls left is released after five idle minutes, and disabling or reloading the extension releases the rest. A conversation that changes its working directory, or searches outside it, gets an index for each directory it searches.

fff refuses the file-system root and the home directory, since indexing either would watch and index far too much; such a search fails with fff's error, so scope it to a project directory.

Search is read-only. Indexes are created without frecency or history databases and nothing is written to the project or the home directory, so a read-only agent can search safely. The index follows file changes, so files created during a conversation are found without a rescan.

## Measured

On a repository of 826 files, against spawning `rg` for each query:

| query | this extension | `rg` per spawn |
| --- | --- | --- |
| `find`, fuzzy path | 2.3 ms | ~20 ms |
| `find`, glob | 0.4 ms | ~20 ms |
| `grep`, literal | 4.6 ms | ~20 ms |

The first search in a directory pays about 700 ms to build the index. The index and its watcher then use about 68 MB, which is why idle indexes are released.

## Test

`npm test` runs the suite with Node's own runner: it searches a temporary directory, so it needs no dependencies beyond the ones `npm install` brings.
