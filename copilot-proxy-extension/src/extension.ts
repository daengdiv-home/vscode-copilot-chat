import * as vscode from 'vscode';
import * as http from 'http';

let server: http.Server | undefined;
let outputChannel: vscode.OutputChannel;

// ============ Proxy Server using vscode.lm API ============

function log(msg: string): void {
	const ts = new Date().toISOString().substring(11, 23);
	outputChannel.appendLine(`[${ts}] ${msg}`);
}

async function handleChatCompletions(
	req: http.IncomingMessage,
	res: http.ServerResponse,
): Promise<void> {
	let body = '';
	await new Promise<void>((resolve) => {
		req.on('data', chunk => { body += chunk; });
		req.on('end', resolve);
	});

	let parsed: any;
	try {
		parsed = JSON.parse(body);
	} catch {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: { message: 'Invalid JSON body' } }));
		return;
	}

	const modelId = parsed.model || 'gpt-4o';
	const messages: Array<{ role: string; content: string }> = parsed.messages || [];
	const stream = parsed.stream === true;

	log(`Request: model=${modelId}, messages=${messages.length}, stream=${stream}`);

	// Select model via vscode.lm API
	let models = await vscode.lm.selectChatModels({ family: modelId });
	if (models.length === 0) {
		// Try matching by id or name
		const allModels = await vscode.lm.selectChatModels();
		const match = allModels.find(m =>
			m.id.includes(modelId) || m.family === modelId || m.name.toLowerCase().includes(modelId.toLowerCase())
		);
		if (!match) {
			const available = allModels.map(m => `${m.family || m.id}`).join(', ');
			res.writeHead(404, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({
				error: { message: `Model "${modelId}" not found. Available: ${available}` }
			}));
			return;
		}
		models = [match];
	}

	const model = models[0];
	log(`Using model: ${model.id} (family=${model.family})`);

	// Convert messages to vscode.LanguageModelChatMessage format
	const vsMessages: vscode.LanguageModelChatMessage[] = messages.map(msg => {
		switch (msg.role) {
			case 'system':
				return vscode.LanguageModelChatMessage.User(`[System]: ${msg.content}`);
			case 'assistant':
				return vscode.LanguageModelChatMessage.Assistant(msg.content);
			default:
				return vscode.LanguageModelChatMessage.User(msg.content);
		}
	});

	try {
		const response = await model.sendRequest(vsMessages, {}, new vscode.CancellationTokenSource().token);

		if (stream) {
			res.writeHead(200, {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache',
				'Connection': 'keep-alive',
				'Access-Control-Allow-Origin': '*',
			});

			const id = `chatcmpl-${Date.now()}`;
			let totalChunks = 0;

			for await (const chunk of response.text) {
				totalChunks++;
				const data = {
					id,
					object: 'chat.completion.chunk',
					created: Math.floor(Date.now() / 1000),
					model: modelId,
					choices: [{
						index: 0,
						delta: { content: chunk },
						finish_reason: null,
					}],
				};
				res.write(`data: ${JSON.stringify(data)}\n\n`);
			}

			const finalData = {
				id,
				object: 'chat.completion.chunk',
				created: Math.floor(Date.now() / 1000),
				model: modelId,
				choices: [{
					index: 0,
					delta: {},
					finish_reason: 'stop',
				}],
			};
			res.write(`data: ${JSON.stringify(finalData)}\n\n`);
			res.write('data: [DONE]\n\n');
			res.end();
			log(`Streamed ${totalChunks} chunks`);
		} else {
			let fullContent = '';
			for await (const chunk of response.text) {
				fullContent += chunk;
			}

			const result = {
				id: `chatcmpl-${Date.now()}`,
				object: 'chat.completion',
				created: Math.floor(Date.now() / 1000),
				model: modelId,
				choices: [{
					index: 0,
					message: { role: 'assistant', content: fullContent },
					finish_reason: 'stop',
				}],
				usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
			};

			res.writeHead(200, {
				'Content-Type': 'application/json',
				'Access-Control-Allow-Origin': '*',
			});
			res.end(JSON.stringify(result));
			log(`Response: ${fullContent.length} chars`);
		}
	} catch (e: any) {
		log(`LM Error: ${e.message}`);
		const status = e.code === 'NoPermissions' ? 403 : 500;
		res.writeHead(status, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: { message: e.message } }));
	}
}

async function handleModels(res: http.ServerResponse): Promise<void> {
	const models = await vscode.lm.selectChatModels();
	const data = models.map(m => ({
		id: m.family || m.id,
		object: 'model',
		owned_by: m.vendor || 'copilot',
		name: m.name,
		family: m.family,
	}));

	res.writeHead(200, {
		'Content-Type': 'application/json',
		'Access-Control-Allow-Origin': '*',
	});
	res.end(JSON.stringify({ object: 'list', data }));
}

function createServer(port: number): http.Server {
	return http.createServer(async (req, res) => {
		const url = req.url || '/';
		const method = req.method || 'GET';

		if (method === 'OPTIONS') {
			res.writeHead(200, {
				'Access-Control-Allow-Origin': '*',
				'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
				'Access-Control-Allow-Headers': 'Content-Type, Authorization',
			});
			res.end();
			return;
		}

		log(`${method} ${url}`);

		try {
			if (url === '/health') {
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ status: 'ok', port }));
			} else if (url === '/v1/models' && method === 'GET') {
				await handleModels(res);
			} else if (url === '/v1/chat/completions' && method === 'POST') {
				await handleChatCompletions(req, res);
			} else {
				res.writeHead(404, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: { message: `Unknown: ${method} ${url}` } }));
			}
		} catch (e: any) {
			log(`Error: ${e.message}`);
			res.writeHead(500, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: { message: e.message } }));
		}
	});
}

// ============ Extension Lifecycle ============

function getPort(): number {
	return vscode.workspace.getConfiguration('copilot-proxy').get<number>('port', 18080);
}

async function startProxy(): Promise<void> {
	if (server) {
		vscode.window.showInformationMessage(`Copilot Proxy already running on port ${getPort()}`);
		return;
	}

	const models = await vscode.lm.selectChatModels();
	if (models.length === 0) {
		vscode.window.showErrorMessage('No language models available. Make sure GitHub Copilot is active and signed in.');
		return;
	}
	log(`Available models: ${models.map(m => m.family || m.id).join(', ')}`);

	const port = getPort();
	server = createServer(port);

	return new Promise((resolve, reject) => {
		server!.listen(port, '127.0.0.1', () => {
			log(`Proxy started on http://localhost:${port}`);
			vscode.window.showInformationMessage(
				`Copilot Proxy on http://localhost:${port} — OpenAI SDK: base_url="http://localhost:${port}/v1"`
			);
			resolve();
		});
		server!.on('error', (e: any) => {
			vscode.window.showErrorMessage(`Failed to start proxy: ${e.message}`);
			server = undefined;
			reject(e);
		});
	});
}

function stopProxy(): void {
	if (server) {
		server.close();
		server = undefined;
		log('Proxy stopped');
		vscode.window.showInformationMessage('Copilot Proxy stopped');
	}
}

export function activate(context: vscode.ExtensionContext): void {
	outputChannel = vscode.window.createOutputChannel('Copilot Proxy');

	context.subscriptions.push(
		vscode.commands.registerCommand('copilot-proxy.start', () => startProxy()),
		vscode.commands.registerCommand('copilot-proxy.stop', () => stopProxy()),
		vscode.commands.registerCommand('copilot-proxy.status', () => {
			if (server) {
				vscode.window.showInformationMessage(`Copilot Proxy running on port ${getPort()}`);
			} else {
				vscode.window.showInformationMessage('Copilot Proxy is not running');
			}
		}),
		outputChannel,
	);

	const autoStart = vscode.workspace.getConfiguration('copilot-proxy').get<boolean>('autoStart', false);
	if (autoStart) {
		setTimeout(() => startProxy(), 5000);
	}

	log('Copilot Proxy extension activated (vscode.lm API)');
}

export function deactivate(): void {
	stopProxy();
}
