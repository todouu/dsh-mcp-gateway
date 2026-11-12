# dsh-mcp-gateway

A plugin for DeepSeek Harness that cuts the token cost of large MCP tool sets.

It hides the native tools of the MCP servers you choose and exposes three small tools instead:

- `mcp_catalog` lists or searches tools as `server/tool — summary` lines.
- `mcp_describe` returns the full description and JSON schema of one tool.
- `mcp_call` calls a tool with the given arguments.

The system prompt carries one line per server listing its tool names (or only per-server counts when there are more than `inlineLimit` tools). Each server's own usage instructions are cut to a short brief, and the full text is served by `mcp_describe "<server>"`. The model fetches a full schema or the full instructions only when it needs them.

## Install

Requires DeepSeek Harness (the `dsh` command) and Node.js 20 or later.

Add the package to the profile you use (`web` in this example):

```sh
dsh plugin --profile web add github:todouu/dsh-mcp-gateway
```

`dsh plugin` forwards its arguments to pnpm in the profile directory. The package installs as `dsh-mcp-gateway`, and its `package.json` points DSH at the bundled `cordis.patch.yml`, so the plugin is added to the profile's bundle list. Check that `dsh-mcp-gateway` appears in `dsh.profile.bundles` in the profile's `package.json`, or turn it on in the Plugins page of the Web sidebar. Restart `dsh` afterwards.

To update later, run the same `add` command again. To remove it:

```sh
dsh plugin --profile web remove dsh-mcp-gateway
```

### Install from a local checkout

```sh
git clone https://github.com/todouu/dsh-mcp-gateway
dsh plugin --profile web add link:$PWD/dsh-mcp-gateway
```

## Configuration

The bundled patch ships with placeholder server names, so the plugin does nothing useful until you set your own. Add an override to the profile's `cordis.patch.yml` (by default `~/.dsh/profiles/<profile>/cordis.patch.yml`):

```yaml
- id: mcp-gateway
  name: 'dsh-mcp-gateway'
  config:
    servers: [meta-mcp, datadog]  # MCP server names to put behind the gateway
    inlineLimit: 60                # above this many tools, show counts instead of a list
    summaryChars: 90               # max length of each tool summary (mcp_catalog, and inline when inlineMode is summaries)
    instructionChars: 0            # characters of each server's instructions kept in the prompt; 0 (default) hides them, read via mcp_describe "<server>"
    inlineMode: none               # none (default): prompt only names the proxied servers; names: tool names per server; summaries: name plus one-line summary
```

The server instructions are sent by the MCP server itself and are not hidden by the tool restriction, so the plugin removes their prompt sections itself (and the resource-server list when it only names gateway servers). The model reads them with `mcp_describe "<server>"`. Tools whose description starts with `do-not-call` are left out of the inline list.

Each name in `servers` must equal the `serverName` of an MCP client entry in the same profile, because tools are matched by the `mcp__<server>__` prefix. Names must match `[A-Za-z0-9_-]{1,32}`. If `servers` is empty, the plugin logs a warning and does nothing.

Restart `dsh` after editing. The system prompt then lists the gatewayed tools, and the native MCP tools are hidden from the model.

## License

MIT
