/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Integrated Proxy Server Service
 *
 *  When running inside VS Code, this service starts an HTTP proxy server that
 *  exposes the Copilot API as OpenAI/Anthropic-compatible REST endpoints.
 *
 *  Unlike the standalone proxy (proxy-server.ts), this version has full access
 *  to real VS Code services:
 *    - IEnvService: real sessionId, machineId, devDeviceId, editor version
 *    - ICAPIClientService: real AB experiment context headers
 *    - ICopilotTokenManager: real Copilot tokens (no GitHub PAT needed)
 *    - IConfigurationService: real extension configuration
 *    - IInteractionService: real interaction IDs for request correlation
 *    - ILogService: extension logging infrastructure
 *
 *  This means ALL headers match exactly what the real extension sends.
 *--------------------------------------------------------------------------------------------*/

import * as http from 'http';
import { ICopilotTokenManager } from '../../../platform/authentication/common/copilotTokenManager';
import { IInteractionService } from '../../../platform/chat/common/interactionService';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { ICAPIClientService } from '../../../platform/endpoint/common/capiClient';
import { IEnvService } from '../../../platform/env/common/envService';
import { ILogService } from '../../../platform/log/common/logService';
import { Emitter, Event } from '../../../util/vs/base/common/event';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { IProxyServerService } from '../common/proxyServerService';

/**
 * Options for building CAPI headers.
 */
interface HeaderBuildOptions {
	intent?: string;
	interactionType?: string;
	userInitiated?: boolean;
	hasVision?: boolean;
}

export class ProxyServerServiceImpl extends Disposable implements IProxyServerService {
	readonly _serviceBrand: undefined;

	private _server: http.Server | undefined;
	private _port: number | undefined;

	private readonly _onDidChangeState = this._register(new Emitter<boolean>());
	readonly onDidChangeState: Event<boolean> = this._onDidChangeState.event;

	constructor(
		@IEnvService private readonly _envService: IEnvService,
		@ICAPIClientService private readonly _capiClientService: ICAPIClientService,
		@ICopilotTokenManager private readonly _copilotTokenManager: ICopilotTokenManager,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IInteractionService private readonly _interactionService: IInteractionService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
	}

	get isRunning(): boolean {
		return !!this._server?.listening;
	}

	get port(): number | undefined {
		return this._port;
	}

	async buildCapiHeaders(requestId: string, options?: HeaderBuildOptions): Promise<Record<string, string>> {
		const intent = options?.intent ?? 'conversation-panel';
		const interactionType = options?.interactionType ?? intent;

		// Get a valid copilot token
		const copilotToken = await this._copilotTokenManager.getCopilotToken();

		const editorInfo = this._envService.getEditorInfo();
		const pluginInfo = this._envService.getEditorPluginInfo();

		const headers: Record<string, string> = {
			'Authorization': `Bearer ${copilotToken.token}`,
			'Content-Type': 'application/json',
			'Accept': 'application/json',
			'X-Request-Id': requestId,
			'X-GitHub-Api-Version': '2025-05-01',
			// Editor identification headers - real values from VS Code
			// @see src/platform/env/common/envService.ts - getEditorVersionHeaders
			'Editor-Version': editorInfo.format(),
			'Editor-Plugin-Version': pluginInfo.format(),
			// User-Agent from the real fetcher
			'User-Agent': `GitHubCopilotChat/${pluginInfo.version}`,
			'X-VSCode-User-Agent-Library-Version': 'node-fetch',
			// Session & machine tracking - real VS Code identifiers
			// @see src/platform/endpoint/common/capiClient.ts
			'VScode-SessionId': this._envService.sessionId,
			'VScode-MachineId': this._envService.machineId,
			// Request routing & tracking
			// @see src/platform/networking/common/networking.ts - networkRequest
			'OpenAI-Intent': intent,
			'X-Interaction-Type': interactionType,
			'X-Agent-Task-Id': requestId,
			// Real interaction ID from the interaction service
			// @see src/extension/prompt/node/chatMLFetcher.ts
			'X-Interaction-Id': this._interactionService.interactionId,
			'X-Initiator': (options?.userInitiated ?? true) ? 'user' : 'agent',
		};

		// AB experiment context headers - only available when running in VS Code
		// @see src/platform/endpoint/common/capiClient.ts - makeRequest override
		if (this._capiClientService.abExpContext) {
			headers['VScode-ABExpContext'] = this._capiClientService.abExpContext;
			headers['X-Copilot-Client-Exp-Assignment-Context'] = this._capiClientService.abExpContext;
		}

		// Model provider preference from configuration
		// @see src/platform/endpoint/node/chatEndpoint.ts - getExtraHeaders
		const modelProviderPreference = this._configurationService.getConfig(ConfigKey.TeamInternal.ModelProviderPreference);
		if (modelProviderPreference) {
			headers['X-Model-Provider-Preference'] = modelProviderPreference;
		}

		// Vision header
		// @see src/extension/prompt/node/chatMLFetcher.ts
		if (options?.hasVision) {
			headers['Copilot-Vision-Request'] = 'true';
		}

		return headers;
	}

	/**
	 * Get CAPI URL from the current copilot token's endpoints.
	 */
	async getCapiUrl(): Promise<string> {
		const copilotToken = await this._copilotTokenManager.getCopilotToken();
		return copilotToken.endpoints?.api || 'https://api.githubcopilot.com';
	}

	async start(port?: number): Promise<void> {
		if (this._server?.listening) {
			this._logService.warn('[ProxyServer] Server is already running');
			return;
		}

		const resolvedPort = port ?? 18080;

		// Dynamic import of express to avoid bundling issues
		const express = require('express');
		const app = express();

		app.use(express.json({ limit: '50mb' }));

		// CORS
		app.use((_req: any, res: any, next: any) => {
			res.setHeader('Access-Control-Allow-Origin', '*');
			res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
			res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta, anthropic-dangerous-direct-browser-access');
			if (_req.method === 'OPTIONS') {
				res.sendStatus(204);
				return;
			}
			next();
		});

		// Health check
		app.get('/health', (_req: any, res: any) => {
			res.json({
				status: 'ok',
				service: 'copilot-integrated-proxy',
				mode: 'vscode-extension',
				port: resolvedPort,
				sessionId: this._envService.sessionId,
				editorVersion: this._envService.vscodeVersion,
			});
		});

		// Models
		app.get('/v1/models', async (_req: any, res: any) => {
			try {
				const capiUrl = await this.getCapiUrl();
				const requestId = generateUuid();
				const headers = await this.buildCapiHeaders(requestId);

				const response = await fetch(`${capiUrl}/models`, {
					method: 'GET',
					headers,
				});

				if (!response.ok) {
					const text = await response.text().catch(() => '');
					return res.status(response.status).json({
						error: { message: text || `CAPI /models failed: ${response.status}`, type: 'server_error' }
					});
				}

				const data = await response.json() as any;
				res.json(data);
			} catch (e: any) {
				this._logService.error('[ProxyServer /v1/models]', e);
				res.status(500).json({ error: { message: e.message, type: 'server_error' } });
			}
		});

		// Chat completions
		app.post('/v1/chat/completions', async (req: any, res: any) => {
			try {
				const capiUrl = await this.getCapiUrl();
				const requestId = generateUuid();
				const body = req.body;

				// Detect vision content
				const hasVision = body.messages?.some((m: any) =>
					Array.isArray(m.content) && m.content.some((c: any) => c.type === 'image_url' || 'image_url' in c)
				) || false;

				const headers = await this.buildCapiHeaders(requestId, {
					hasVision,
				});

				if (body.stream) {
					headers['Accept'] = 'text/event-stream';
				}

				// Add anthropic-beta for Claude models
				if (this._isClaudeModel(body.model)) {
					const betaFeatures: string[] = [];
					if (body.thinking?.type !== 'adaptive') {
						betaFeatures.push('interleaved-thinking-2025-05-14');
					}
					betaFeatures.push('context-management-2025-06-27');
					if (body.tools?.length > 0) {
						betaFeatures.push('advanced-tool-use-2025-11-20');
					}
					headers['anthropic-beta'] = betaFeatures.join(',');
				}

				// Add stream_options if streaming
				if (body.stream && !body.stream_options) {
					body.stream_options = { include_usage: true };
				}

				const abortController = new AbortController();
				req.on('close', () => abortController.abort());

				const capiResponse = await fetch(`${capiUrl}/chat/completions`, {
					method: 'POST',
					headers,
					body: JSON.stringify(body),
					signal: abortController.signal,
				});

				if (!capiResponse.ok) {
					const text = await capiResponse.text().catch(() => '');
					return res.status(capiResponse.status).json({
						error: { message: text || `CAPI failed: ${capiResponse.status}`, type: 'server_error' }
					});
				}

				if (body.stream && capiResponse.body) {
					res.setHeader('Content-Type', 'text/event-stream');
					res.setHeader('Cache-Control', 'no-cache');
					res.setHeader('Connection', 'keep-alive');
					res.setHeader('X-Accel-Buffering', 'no');

					const reader = (capiResponse.body as any).getReader();
					const decoder = new TextDecoder();
					try {
						while (true) {
							const { done, value } = await reader.read();
							if (done) { break; }
							res.write(decoder.decode(value, { stream: true }));
						}
					} catch (e: any) {
						if (e.name !== 'AbortError') {
							this._logService.error('[ProxyServer streaming]', e);
						}
					} finally {
						res.end();
					}
				} else {
					const result = await capiResponse.json();
					res.json(result);
				}
			} catch (e: any) {
				this._logService.error('[ProxyServer /v1/chat/completions]', e);
				if (res.headersSent) { res.end(); return; }
				res.status(500).json({ error: { message: e.message, type: 'server_error' } });
			}
		});

		// Embeddings
		app.post('/v1/embeddings', async (req: any, res: any) => {
			try {
				const capiUrl = await this.getCapiUrl();
				const requestId = generateUuid();
				const headers = await this.buildCapiHeaders(requestId);

				const capiResponse = await fetch(`${capiUrl}/embeddings`, {
					method: 'POST',
					headers,
					body: JSON.stringify(req.body),
				});

				if (!capiResponse.ok) {
					const text = await capiResponse.text().catch(() => '');
					return res.status(capiResponse.status).json({
						error: { message: text || `CAPI embeddings failed: ${capiResponse.status}`, type: 'server_error' }
					});
				}

				const result = await capiResponse.json();
				res.json(result);
			} catch (e: any) {
				this._logService.error('[ProxyServer /v1/embeddings]', e);
				res.status(500).json({ error: { message: e.message, type: 'server_error' } });
			}
		});

		// Responses API pass-through
		app.post('/v1/responses', async (req: any, res: any) => {
			try {
				const capiUrl = await this.getCapiUrl();
				const requestId = generateUuid();
				const isStream = req.body.stream ?? false;
				const headers = await this.buildCapiHeaders(requestId, {
					intent: 'conversation-panel',
					interactionType: 'conversation-agent',
				});
				headers['Accept'] = isStream ? 'text/event-stream' : 'application/json';

				const capiResponse = await fetch(`${capiUrl}/responses`, {
					method: 'POST',
					headers,
					body: JSON.stringify(req.body),
				});

				if (!capiResponse.ok && !isStream) {
					const text = await capiResponse.text().catch(() => '');
					return res.status(capiResponse.status).json({
						error: { message: text || `Responses API failed: ${capiResponse.status}`, type: 'server_error' }
					});
				}

				if (isStream && capiResponse.body) {
					res.setHeader('Content-Type', 'text/event-stream');
					res.setHeader('Cache-Control', 'no-cache');
					res.setHeader('Connection', 'keep-alive');

					const reader = (capiResponse.body as any).getReader();
					const decoder = new TextDecoder();
					try {
						while (true) {
							const { done, value } = await reader.read();
							if (done) { break; }
							res.write(decoder.decode(value, { stream: true }));
						}
					} finally {
						res.end();
					}
				} else {
					const result = await capiResponse.json();
					res.json(result);
				}
			} catch (e: any) {
				this._logService.error('[ProxyServer /v1/responses]', e);
				if (res.headersSent) { res.end(); return; }
				res.status(500).json({ error: { message: e.message, type: 'server_error' } });
			}
		});

		// Anthropic Messages API
		app.post('/v1/messages', async (req: any, res: any) => {
			try {
				const body = req.body;

				// Validation (Anthropic error format)
				if (!body.model) {
					return res.status(400).json({ type: 'error', error: { type: 'invalid_request_error', message: 'model: field required' } });
				}
				if (!body.max_tokens && body.max_tokens !== 0) {
					return res.status(400).json({ type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens: field required' } });
				}
				if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
					return res.status(400).json({ type: 'error', error: { type: 'invalid_request_error', message: 'messages: field required' } });
				}

				const capiUrl = await this.getCapiUrl();
				const requestId = generateUuid();
				const isStream = body.stream ?? false;

				const headers = await this.buildCapiHeaders(requestId, {
					intent: 'conversation-agent',
					interactionType: 'conversation-agent',
				});
				headers['Accept'] = isStream ? 'text/event-stream' : 'application/json';

				// Anthropic beta features
				// @see src/platform/endpoint/node/chatEndpoint.ts - getExtraHeaders
				const betaFeatures = new Set<string>();
				if (body.thinking?.type !== 'adaptive') {
					betaFeatures.add('interleaved-thinking-2025-05-14');
				}
				betaFeatures.add('context-management-2025-06-27');
				if (body.tools?.length > 0) {
					betaFeatures.add('advanced-tool-use-2025-11-20');
				}
				// Merge client anthropic-beta headers
				const clientBeta = req.headers['anthropic-beta'] as string | undefined;
				if (clientBeta) {
					for (const beta of clientBeta.split(',')) {
						const trimmed = beta.trim();
						if (trimmed) { betaFeatures.add(trimmed); }
					}
				}
				if (betaFeatures.size > 0) {
					headers['anthropic-beta'] = [...betaFeatures].join(',');
				}

				// Auto-adjust max_tokens for thinking
				if (body.thinking?.type === 'enabled' && body.thinking?.budget_tokens) {
					if (body.max_tokens <= body.thinking.budget_tokens) {
						body.max_tokens = body.thinking.budget_tokens + 1;
					}
				}

				const abortController = new AbortController();
				req.on('close', () => abortController.abort());

				const capiResponse = await fetch(`${capiUrl}/v1/messages`, {
					method: 'POST',
					headers,
					body: JSON.stringify(body),
					signal: abortController.signal,
				});

				// Error handling (Anthropic format)
				if (!capiResponse.ok) {
					const text = await capiResponse.text().catch(() => '');
					try {
						const parsed = JSON.parse(text);
						if (parsed.type === 'error' && parsed.error) {
							return res.status(capiResponse.status).json(parsed);
						}
						return res.status(capiResponse.status).json({
							type: 'error',
							error: {
								type: capiResponse.status === 401 ? 'authentication_error'
									: capiResponse.status === 429 ? 'rate_limit_error'
										: capiResponse.status >= 500 ? 'api_error'
											: 'invalid_request_error',
								message: parsed.error?.message || parsed.message || text,
							},
						});
					} catch {
						return res.status(capiResponse.status).json({
							type: 'error',
							error: { type: 'api_error', message: text || `Messages API failed: ${capiResponse.status}` },
						});
					}
				}

				// Streaming
				if (isStream && capiResponse.body) {
					res.setHeader('Content-Type', 'text/event-stream');
					res.setHeader('Cache-Control', 'no-cache');
					res.setHeader('Connection', 'keep-alive');
					res.setHeader('X-Accel-Buffering', 'no');

					const reader = (capiResponse.body as any).getReader();
					const decoder = new TextDecoder();
					try {
						while (true) {
							const { done, value } = await reader.read();
							if (done) { break; }
							res.write(decoder.decode(value, { stream: true }));
						}
					} catch (e: any) {
						if (e.name !== 'AbortError') {
							this._logService.error('[ProxyServer /v1/messages stream]', e);
						}
					} finally {
						res.end();
					}
				} else {
					const result = await capiResponse.json();
					res.json(result);
				}
			} catch (e: any) {
				this._logService.error('[ProxyServer /v1/messages]', e);
				if (res.headersSent) { res.end(); return; }
				res.status(500).json({ type: 'error', error: { type: 'api_error', message: e.message } });
			}
		});

		// Start listening
		return new Promise<void>((resolve, reject) => {
			const server = app.listen(resolvedPort, () => {
				this._server = server;
				this._port = resolvedPort;
				this._logService.info(`[ProxyServer] Integrated proxy running on http://localhost:${resolvedPort}`);
				this._logService.info(`[ProxyServer] Mode: vscode-extension (real headers, real tokens)`);
				this._logService.info(`[ProxyServer] Endpoints: /v1/models, /v1/chat/completions, /v1/embeddings, /v1/responses, /v1/messages`);
				this._onDidChangeState.fire(true);
				resolve();
			});

			server.on('error', (err: any) => {
				this._logService.error('[ProxyServer] Failed to start:', err);
				reject(err);
			});
		});
	}

	async stop(): Promise<void> {
		if (this._server) {
			return new Promise<void>((resolve) => {
				this._server!.close(() => {
					this._logService.info('[ProxyServer] Server stopped');
					this._server = undefined;
					this._port = undefined;
					this._onDidChangeState.fire(false);
					resolve();
				});
			});
		}
	}

	private _isClaudeModel(modelId: string): boolean {
		const lower = modelId.toLowerCase();
		return lower.startsWith('claude') || lower.includes('anthropic');
	}

	override dispose(): void {
		if (this._server) {
			this._server.close();
			this._server = undefined;
		}
		super.dispose();
	}
}
