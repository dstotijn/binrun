# binrun

A Node.js utility for running architecture-specific binaries released via GoReleaser on GitHub.

## Installation

```bash
npm install -g binrun
```

Or run it directly with npx:

```bash
npx binrun [--debug] github.com/username/repo[@version] [args...]
```

## Usage

```bash
binrun [--debug] github.com/dstotijn/some-go-project@v1.0.0 [args...]
```

Where:

- `--debug` is an optional flag to enable debug logging
- `github.com/dstotijn/some-go-project` is the GitHub repository path
- `@v1.0.0` is the optional release version (defaults to latest)
- `[args...]` are any arguments to pass to the binary

## Features

- 🔄 Automatically detects your system architecture and OS
- 📦 Downloads the appropriate binary for your system
- 🗄️ Caches binaries locally for faster subsequent runs
- 🔄 Supports versioned releases
- 🗃️ Handles tar.gz archives common in Goreleaser releases

## How it works

1. Parses the GitHub repository URL and version
2. Queries the GitHub API to find releases
3. Finds the appropriate binary for your operating system and architecture
4. Downloads and caches the binary
5. Executes the binary with any provided arguments

## Supported platforms

- 💻 macOS (Darwin): arm64, x86_64
- 🐧 Linux: arm64, x86_64, i386
- 🪟 Windows: arm64, x86_64, i386

## License

MIT
