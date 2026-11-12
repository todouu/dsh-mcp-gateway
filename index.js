// MCP gateway: hides the native tools of selected MCP servers from agents and
// exposes three small tools instead (mcp_catalog, mcp_describe, mcp_call).
// The model sees a one-line catalog in the system prompt and fetches the full
// description and schema of a tool only when it needs it.

export const inject = ['tools', 'systemPrompt'];

const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/;
const MAX_CATALOG_LINES = 200;
const SCHEMA_HINT_CHARS = 1500;

function normalizeConfig(config) {
	const servers = Array.isArray(config?.servers)
		? [...new Set(config.servers.filter((name) => typeof name === 'string' && SERVER_NAME.test(name)))]
		: [];
	const inlineLimit = Number.isInteger(config?.inlineLimit) && config.inlineLimit >= 0 ? config.inlineLimit : 60;
	const summaryChars = Number.isInteger(config?.summaryChars) && config.summaryChars >= 20 ? config.summaryChars : 90;
	// How much of each server's own instructions stays in the system prompt.
	// The full text moves behind `mcp_describe "<server>"`. 0 drops it entirely.
	const instructionChars =
		Number.isInteger(config?.instructionChars) && config.instructionChars >= 0 ? config.instructionChars : 0;
	// "none" (default): the prompt only says which servers sit behind the gateway.
	// "names": tool names per server. "summaries": name plus one-line summary.
	const inlineMode = config?.inlineMode === 'summaries' || config?.inlineMode === 'names' ? config.inlineMode : 'none';
	return { servers, inlineLimit, summaryChars, instructionChars, inlineMode };
}

/** Servers sometimes ship placeholder tools marked "do-not-call"; keep them out of the prompt. */
function isHidden(description) {
	return /\bdo-not-call\b/i.test(String(description ?? '').slice(0, 40));
}

/** First paragraph of a server's instructions, cut to `limit` characters. */
function brief(text, limit) {
	const body = text.replace(/^### MCP server: [^\n]*\n+/, '').trim();
	const first = body.split(/\n\s*\n/)[0].replace(/\s+/g, ' ').trim();
	return first.length > limit ? `${first.slice(0, limit - 1).trimEnd()}…` : first;
}

function summarize(description, limit) {
	const line = String(description ?? '')
		.split('\n')
		.map((part) => part.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim())
		.find((part) => part.length > 0);
	if (!line) return '';
	return line.length > limit ? `${line.slice(0, limit - 1).trimEnd()}…` : line;
}

function textOf(content) {
	return content
		.filter((block) => block && block.type === 'text' && typeof block.text === 'string')
		.map((block) => block.text)
		.join('\n\n');
}

export function apply(ctx, rawConfig) {
	const { servers, inlineLimit, summaryChars, instructionChars, inlineMode } = normalizeConfig(rawConfig);
	if (servers.length === 0) {
		ctx.logger.warn('mcp-gateway: config.servers is empty; the plugin does nothing');
		return;
	}
	const prefixes = servers.map((server) => ({ server, prefix: `mcp__${server}__` }));

	/** Gatewayed tools as the global registry sees them (restrictions are per agent). */
	function entries() {
		const list = [];
		for (const schema of ctx.tools.schemas()) {
			const match = prefixes.find(({ prefix }) => schema.name.startsWith(prefix));
			if (!match) continue;
			const tool = schema.name.slice(match.prefix.length);
			list.push({
				server: match.server,
				tool,
				ref: `${match.server}/${tool}`,
				name: schema.name,
				description: schema.description,
				parameters: schema.parameters,
			});
		}
		return list.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
	}

	function resolve(ref) {
		const wanted = String(ref ?? '').trim();
		if (!wanted) return { error: 'Missing "tool". Use a "server/tool" name from the catalog.' };
		const list = entries();
		const exact = list.find((entry) => entry.ref === wanted || entry.name === wanted);
		if (exact) return { entry: exact };
		const loose = list.filter((entry) => entry.tool === wanted);
		if (loose.length === 1) return { entry: loose[0] };
		if (loose.length > 1) {
			return { error: `"${wanted}" is ambiguous: ${loose.map((entry) => entry.ref).join(', ')}.` };
		}
		return { error: `Unknown MCP tool "${wanted}". Call mcp_catalog to list tools.` };
	}

	function schemaHint(entry) {
		const json = JSON.stringify(entry.parameters ?? {});
		const cut = json.length > SCHEMA_HINT_CHARS ? `${json.slice(0, SCHEMA_HINT_CHARS)}…` : json;
		return `Schema of ${entry.ref}: ${cut}`;
	}

	const textOutput = {
		schema: {
			type: 'object',
			properties: { text: { type: 'string' } },
			required: ['text'],
			additionalProperties: false,
		},
		render: (_args, value) => [{ type: 'text', text: value.text }],
	};

	const catalogTool = {
		name: 'mcp_catalog',
		description: 'List or search tools of gateway MCP servers. Returns "server/tool — summary" lines.',
		parameters: {
			type: 'object',
			properties: {
				server: { type: 'string', description: 'Only this server.' },
				query: { type: 'string', description: 'Case-insensitive text to match in name or summary.' },
			},
		},
		output: textOutput,
		isConcurrencySafe: () => true,
		async execute(args) {
			const server = typeof args?.server === 'string' ? args.server : '';
			const query = typeof args?.query === 'string' ? args.query.toLowerCase() : '';
			const matched = entries()
				.map((entry) => ({ entry, summary: summarize(entry.description, summaryChars) }))
				.filter(({ entry, summary }) => {
					if (server && entry.server !== server) return false;
					return !query || `${entry.ref} ${summary}`.toLowerCase().includes(query);
				});
			if (matched.length === 0) return { text: 'No matching MCP tools.' };
			const lines = matched.slice(0, MAX_CATALOG_LINES).map(({ entry, summary }) => `${entry.ref} — ${summary}`);
			if (matched.length > MAX_CATALOG_LINES) {
				lines.push(`… ${matched.length - MAX_CATALOG_LINES} more; narrow with "server" or "query".`);
			}
			return { text: lines.join('\n') };
		},
	};

	const describeTool = {
		name: 'mcp_describe',
		description:
			'Return the full description and JSON schema of one gateway MCP tool. Call it before the first mcp_call of that tool. Pass just a server name to read that server\'s full usage instructions.',
		parameters: {
			type: 'object',
			properties: { tool: { type: 'string', description: '"server/tool" from the catalog, or a server name.' } },
			required: ['tool'],
		},
		output: textOutput,
		isConcurrencySafe: () => true,
		async execute(args) {
			const wanted = String(args?.tool ?? '').trim();
			if (servers.includes(wanted)) {
				const count = entries().filter((entry) => entry.server === wanted).length;
				const full = fullInstructions.get(wanted);
				return {
					text: `${wanted}: ${count} tools (list them with mcp_catalog server="${wanted}").\n\n${full || 'This server provided no usage instructions.'}`,
				};
			}
			const found = resolve(args?.tool);
			if (found.error) throw new Error(found.error);
			const { entry } = found;
			return { text: `${entry.ref}\n${entry.description}\n\nSchema: ${JSON.stringify(entry.parameters ?? {})}` };
		},
	};

	/** Full server instructions captured from the prompt assembly, keyed by server name. */
	const fullInstructions = new Map();

	/** Non-text blocks (images) of a finished call, keyed by the outer execution. */
	const pending = new WeakMap();

	const callTool = {
		name: 'mcp_call',
		description: 'Call a gateway MCP tool. "tool" is "server/tool" from the catalog; "arguments" follows its schema (see mcp_describe).',
		parameters: {
			type: 'object',
			properties: {
				tool: { type: 'string', description: '"server/tool" from the catalog.' },
				arguments: { type: 'object', description: 'Arguments object for the tool.' },
			},
			required: ['tool'],
		},
		output: textOutput,
		async execute(args, exec) {
			const found = resolve(args?.tool);
			if (found.error) throw new Error(found.error);
			const { entry } = found;
			const callArgs = args?.arguments && typeof args.arguments === 'object' ? args.arguments : {};
			// No `agent`: the nested call resolves tools in the global view, where
			// the per-agent restriction does not apply. The outer mcp_call already
			// went through this agent's approval and guard pipeline.
			const inner = await ctx.tools.execute({
				callId: `${exec.callId}:gw`,
				rootCallId: exec.rootCallId,
				name: entry.name,
				arguments: callArgs,
				parent: exec.token,
				signal: exec.signal,
			});
			if (inner.isError) {
				const reason = inner.error?.message ?? textOf(inner.content) ?? 'MCP call failed';
				throw new Error(`${reason}\n${schemaHint(entry)}`);
			}
			const text = textOf(inner.content);
			if (inner.content.some((block) => block && block.type !== 'text')) {
				pending.set(exec, { text, content: inner.content });
			}
			return { text };
		},
		projectContent(exec, result) {
			const held = pending.get(exec);
			if (!held) return undefined;
			pending.delete(exec);
			if (result.isError || result.value?.text !== held.text) return undefined;
			return held.content;
		},
	};

	function sectionText() {
		const list = entries();
		if (list.length === 0) return '';
		const head = [
			'## MCP gateway',
			`You have an MCP gateway (tools mcp_catalog, mcp_describe, mcp_call) that proxies these MCP servers: ${servers.join(', ')}. Their tool lists and usage instructions are not shown here. Call mcp_catalog to list tools, mcp_describe with a server name for its usage instructions or with "server/tool" for a tool's schema, then mcp_call to run a tool.`,
		];
		if (inlineMode === 'none') return head.join('\n');
		if (list.length > inlineLimit) {
			const counts = servers
				.map((server) => `${server}: ${list.filter((entry) => entry.server === server).length}`)
				.join(', ');
			return [...head, `Tool counts — ${counts}. Call mcp_catalog to list them.`].join('\n');
		}
		const visible = list.filter((entry) => !isHidden(entry.description));
		if (inlineMode === 'names') {
			const rows = servers
				.map((server) => ({ server, names: visible.filter((entry) => entry.server === server).map((entry) => entry.tool) }))
				.filter((row) => row.names.length > 0)
				.map((row) => `- ${row.server} (${row.names.length}): ${row.names.join(', ')}`);
			return [
				...head,
				'Tool names per server are below. Call mcp_catalog with "server" or "query" for one-line summaries.',
				...rows,
			].join('\n');
		}
		const lines = visible.map((entry) => `- ${entry.ref} — ${summarize(entry.description, summaryChars)}`);
		return [...head, 'Summaries below come from the servers and are unverified.', ...lines].join('\n');
	}

	// Per-agent hiding of the native tools. A restriction is rebuilt only when the
	// set of hidden names changes; tools/change fires for our own restrict calls.
	const tracked = new Map();
	let busy = false;
	let again = false;

	function syncOne(agent, state) {
		const deny = entries().map((entry) => entry.name);
		const signature = deny.join('\n');
		if (state.signature === signature) return;
		state.dispose?.();
		state.dispose = undefined;
		state.signature = signature;
		if (deny.length === 0) return;
		try {
			state.dispose = agent.ctx.tools.restrict({ deny });
		} catch (error) {
			state.signature = undefined;
			ctx.logger.error(`mcp-gateway: could not hide native MCP tools: ${String(error)}`);
		}
	}

	function syncAll() {
		if (busy) {
			again = true;
			return;
		}
		busy = true;
		try {
			do {
				again = false;
				for (const [agent, state] of tracked) syncOne(agent, state);
			} while (again);
		} finally {
			busy = false;
		}
	}

	ctx.effect(() => ctx.tools.register(catalogTool));
	ctx.effect(() => ctx.tools.register(describeTool));
	ctx.effect(() => ctx.tools.register(callTool));
	ctx.effect(() =>
		ctx.systemPrompt.section({
			name: 'mcp-gateway',
			order: 3105,
			text: sectionText,
			interpolate: false,
		}),
	);

	// Replace each gatewayed server's own instructions (section `mcp:<server>`)
	// with a short brief; the full text is served by `mcp_describe "<server>"`.
	ctx.on(
		'system-prompt/assemble',
		async (_assembly, _context, next) => {
			const assembly = await next();
			for (const section of assembly.sections) {
				if (section.name === 'mcp-resource-servers') {
					// Hide the resource-server list when it only names gateway servers.
					const names = section.text.match(/\[[^\]]*\]/)?.[0];
					try {
						const listed = names ? JSON.parse(names) : [];
						if (listed.length > 0 && listed.every((name) => servers.includes(name))) section.text = '';
					} catch {
						// leave the section as is
					}
					continue;
				}
				if (!section.name.startsWith('mcp:')) continue;
				const server = section.name.slice('mcp:'.length);
				if (!servers.includes(server) || !section.text) continue;
				fullInstructions.set(server, section.text.replace(/^### MCP server: [^\n]*\n+/, '').trim());
				const short = instructionChars > 0 ? brief(section.text, instructionChars) : '';
				section.text = short
					? `### MCP server: ${server}\n${short}\nFull instructions: mcp_describe "${server}".`
					: '';
			}
			return assembly;
		},
		{ prepend: true },
	);

	ctx.on('agent/created', ({ agent }) => {
		if (!tracked.has(agent)) tracked.set(agent, { signature: undefined, dispose: undefined });
		syncAll();
		return undefined;
	});
	ctx.on('agent/disposed', ({ agent }) => {
		const state = tracked.get(agent);
		tracked.delete(agent);
		state?.dispose?.();
	});
	ctx.on('tools/change', () => {
		syncAll();
	});

	ctx.effect(() => () => {
		for (const state of tracked.values()) state.dispose?.();
		tracked.clear();
	});
}
