# dsh-mcp-gateway

A plugin for DeepSeek Harness that cuts the token cost of large MCP tool sets.

It hides the native tools of the MCP servers you choose and exposes three small tools instead:

- `mcp_catalog` lists or searches tools as `server/tool — summary` lines.
- `mcp_describe` returns the full description and JSON schema of one tool.
- `mcp_call` calls a tool with the given arguments.

The system prompt carries a one-line summary per tool (or only per-server counts when there are more than `inlineLimit` tools). The model fetches a full schema only when it needs one.

## Configuration

Edit `cordis.patch.yml`:

```yaml
- insert:
    - id: mcp-gateway
      name: '@local/mcp-gateway'
      config:
        servers: [server-a, server-b]  # MCP server names to put behind the gateway
        inlineLimit: 60                # above this many tools, show counts instead of a list
        summaryChars: 90               # max length of each tool summary
```

Server names must match `[A-Za-z0-9_-]{1,32}`. Tools are matched by the `mcp__<server>__` prefix.

## License

MIT
