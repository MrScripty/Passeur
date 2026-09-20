# Passeur

Build once:

```sh
npm install
npm run build
```

Configure a project:

```sh
./passeur setup /path/to/project
```

Start its MCP server:

```sh
./passeur start /path/to/project
```

The directory defaults to the current directory. Running `./passeur` for an unconfigured project opens the same setup. Add the printed MCP configuration to Codex. See [setup details](docs/setup.md) for recovery.
