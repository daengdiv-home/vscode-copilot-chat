/*---------------------------------------------------------------------------------------------
 *  OpenAI & Anthropic Compatible API Routes
 *
 *  Implements both the OpenAI and Anthropic API surfaces using the GitHub
 *  Copilot API (CAPI) backend. Each route translates between client format
 *  and CAPI format, reusing the same request/response patterns as the
 *  original extension's networking layer.
 *
 *  References to original extension code:
 *    - Model listing: src/platform/endpoint/node/modelMetadataFetcher.ts
 *    - Chat request flow: src/extension/prompt/node/chatMLFetcher.ts
 *    - SSE stream processing: src/platform/networking/node/stream.ts
 *    - Request body: src/platform/networking/common/networking.ts
 *    - Response types: src/platform/networking/common/openai.ts
 *    - Messages API: src/platform/endpoint/node/messagesApi.ts
 *--------------------------------------------------------------------------------------------*/

import { Response as ExpressResponse, Request, Router } from 'express';
import { CopilotTokenProvider } from './proxy-auth';
import {
	buildCapiChatBody,
	buildCapiEmbeddingsBody,
	buildMessagesApiBody,
	convertMessagesResponseToCompletions,
	fetchChatCompletion,
	fetchEmbeddings,
	fetchMessagesApi,
	fetchModels,
	isClaudeModel,
	MessagesStreamConverter,
	parseAnthropicSSE,
	streamChatCompletion,
	toOpenAIModel,
} from './proxy-capi';

import type {
	OpenAIChatCompletionRequest,
	OpenAIEmbeddingRequest,
} from './proxy-capi';

export const proxyRouter = Router();
const tokenProvider = CopilotTokenProvider.getInstance();

// Models cache with TTL
let modelsCache: { data: any[]; fetchedAt: number } | undefined;
const MODELS_CACHE_TTL = 10 * 60 * 1000; // 10 minutes, same as extension

/*---------------------------------------------------------------------------------------------
 *  GET /v1/models - List available models
 *
 *  Returns models in OpenAI format. Fetches from CAPI /models endpoint using the
 *  same flow as ModelMetadataFetcher._fetchModels()
 *  @see src/platform/endpoint/node/modelMetadataFetcher.ts
 *--------------------------------------------------------------------------------------------*/
proxyRouter.get('/models', async (req: Request, res: ExpressResponse) => {
	try {
		const { token, capiUrl } = await tokenProvider.resolveCapiAuth(req);

		// Check cache
		if (modelsCache && (Date.now() - modelsCache.fetchedAt) < MODELS_CACHE_TTL) {
			return res.json({
				object: 'list',
				data: modelsCache.data,
			});
		}

		const models = await fetchModels(capiUrl, token);
		const openaiModels = models.map(toOpenAIModel);

		// Update cache
		modelsCache = { data: openaiModels, fetchedAt: Date.now() };

		res.json({
			object: 'list',
			data: openaiModels,
		});
	} catch (e: any) {
		console.error('[/v1/models]', e.message);
		res.status(500).json({
			error: { message: e.message, type: 'server_error', code: 'model_fetch_error' }
		});
	}
});

/*---------------------------------------------------------------------------------------------
 *  GET /v1/models/:model - Get model info
 *--------------------------------------------------------------------------------------------*/
proxyRouter.get('/models/:model', async (req: Request, res: ExpressResponse) => {
	try {
		const { token, capiUrl } = await tokenProvider.resolveCapiAuth(req);
		const modelId = req.params.model;

		// Check cache first
		if (modelsCache && (Date.now() - modelsCache.fetchedAt) < MODELS_CACHE_TTL) {
			const found = modelsCache.data.find((m: any) => m.id === modelId);
			if (found) {
				return res.json(found);
			}
		}

		// Fetch fresh
		const models = await fetchModels(capiUrl, token);
		const model = models.find(m => m.id === modelId);

		if (!model) {
			return res.status(404).json({
				error: { message: `Model '${modelId}' not found`, type: 'invalid_request_error', code: 'model_not_found' }
			});
		}

		res.json(toOpenAIModel(model));
	} catch (e: any) {
		console.error('[/v1/models/:model]', e.message);
		res.status(500).json({
			error: { message: e.message, type: 'server_error', code: 'model_fetch_error' }
		});
	}
});

/*---------------------------------------------------------------------------------------------
 *  POST /v1/chat/completions - Chat completions (streaming & non-streaming)
 *
 *  Translates OpenAI chat completion requests to CAPI format and forwards them.
 *
 *  For streaming: Pipes the CAPI SSE stream directly back to the client.
 *  The CAPI SSE format is already OpenAI-compatible since it uses the same
 *  SSE protocol (data: { ... } lines terminated by [DONE]).
 *
 *  @see src/extension/prompt/node/chatMLFetcher.ts - fetchMany()
 *  @see src/platform/networking/node/stream.ts - SSEProcessor
 *  @see src/platform/endpoint/node/chatEndpoint.ts - createRequestBody()
 *--------------------------------------------------------------------------------------------*/
proxyRouter.post('/chat/completions', async (req: Request, res: ExpressResponse) => {
	try {
		const { token, capiUrl } = await tokenProvider.resolveCapiAuth(req);
		const request = req.body as OpenAIChatCompletionRequest;

		if (!request.model) {
			return res.status(400).json({
				error: { message: 'model is required', type: 'invalid_request_error', code: 'missing_model' }
			});
		}

		if (!request.messages || !Array.isArray(request.messages) || request.messages.length === 0) {
			return res.status(400).json({
				error: { message: 'messages is required and must be a non-empty array', type: 'invalid_request_error', code: 'missing_messages' }
			});
		}

		const capiBody = buildCapiChatBody(request);

		// Determine if we should route via Messages API
		// CAPI's /chat/completions doesn't return thinking content or tool_calls for Claude,
		// so for Claude models with thinking_budget or tools, we route through the
		// /v1/messages endpoint (Anthropic Messages API) and convert back to OpenAI format.
		// @see src/platform/endpoint/node/chatEndpoint.ts - customizeCapiBody()
		// @see src/platform/endpoint/node/messagesApi.ts - createMessagesRequestBody()
		const thinkingBudget = capiBody.thinking_budget as number | undefined;
		const claudeWithThinking = thinkingBudget && thinkingBudget > 0 && isClaudeModel(request.model);
		const claudeWithTools = isClaudeModel(request.model) && request.tools && request.tools.length > 0;
		const useMessagesApi = claudeWithThinking || claudeWithTools;

		// AbortController to cancel upstream on client disconnect
		const abortController = new AbortController();
		req.on('close', () => abortController.abort());

		if (useMessagesApi) {
			const effectiveBudget = thinkingBudget && thinkingBudget > 0 ? thinkingBudget : 0;
			const messagesBody = effectiveBudget > 0
				? buildMessagesApiBody(request, effectiveBudget)
				: buildMessagesApiBody(request, 0);
			messagesBody.stream = !!request.stream;
			// If no thinking requested, remove the thinking key
			if (effectiveBudget <= 0) {
				delete messagesBody.thinking;
			}

			const messagesResponse = await fetchMessagesApi(capiUrl, token, messagesBody, abortController.signal);

			if (!messagesResponse.ok) {
				const errorText = await messagesResponse.text().catch(() => '');
				return res.status(messagesResponse.status).json({
					error: { message: errorText || `Messages API failed: ${messagesResponse.status}`, type: 'server_error' }
				});
			}

			if (!request.stream) {
				// Non-streaming: convert full Messages API response to chat completions format
				const raw = await messagesResponse.json();
				return res.json(convertMessagesResponseToCompletions(raw));
			}

			// Streaming: convert Anthropic SSE events to OpenAI SSE format
			res.setHeader('Content-Type', 'text/event-stream');
			res.setHeader('Cache-Control', 'no-cache');
			res.setHeader('Connection', 'keep-alive');
			res.setHeader('X-Accel-Buffering', 'no');

			if (messagesResponse.body) {
				const reader = messagesResponse.body.getReader();
				const decoder = new TextDecoder();
				const converter = new MessagesStreamConverter();

				try {
					let buffer = '';
					while (true) {
						const { done, value } = await reader.read();
						if (done) {
							// Process any remaining buffered data
							if (buffer.trim()) {
								const events = parseAnthropicSSE(buffer);
								for (const { event, data } of events) {
									const chunks = converter.convert(event, data);
									for (const chunk of chunks) {
										res.write(chunk);
									}
								}
							}
							break;
						}
						buffer += decoder.decode(value, { stream: true });

						// Process complete events (separated by double newlines)
						const eventBoundary = buffer.lastIndexOf('\n\n');
						if (eventBoundary >= 0) {
							const complete = buffer.slice(0, eventBoundary + 2);
							buffer = buffer.slice(eventBoundary + 2);

							const events = parseAnthropicSSE(complete);
							for (const { event, data } of events) {
								const chunks = converter.convert(event, data);
								for (const chunk of chunks) {
									res.write(chunk);
								}
							}
						}
					}
				} catch (e: any) {
					if (e.name !== 'AbortError') {
						console.error('[thinking-streaming]', e.message);
					}
				} finally {
					res.end();
				}
			} else {
				res.end();
			}
			return;
		}

		// Non-streaming response (regular, no thinking)
		if (!request.stream) {
			const result = await fetchChatCompletion(capiUrl, token, capiBody);
			// CAPI response is already in OpenAI format for non-streaming
			return res.json(result);
		}

		// Streaming response - pipe CAPI SSE stream directly
		// CAPI uses the same SSE format as OpenAI (data: {...}\n\ndata: [DONE]\n\n)
		// @see src/platform/networking/node/stream.ts - processSSE()
		const capiResponse = await streamChatCompletion(capiUrl, token, capiBody, abortController.signal);

		if (!capiResponse.ok) {
			const errorText = await capiResponse.text().catch(() => '');
			const statusCode = capiResponse.status;

			// Map CAPI error codes to OpenAI error format
			// @see src/platform/openai/node/fetch.ts - ChatFailKind
			let errorType = 'server_error';
			let errorCode = 'internal_error';

			if (statusCode === 401 || statusCode === 403) {
				errorType = 'authentication_error';
				errorCode = 'invalid_api_key';
			} else if (statusCode === 429) {
				errorType = 'rate_limit_error';
				errorCode = 'rate_limit_exceeded';
			} else if (statusCode === 400) {
				errorType = 'invalid_request_error';
				errorCode = 'bad_request';
			} else if (statusCode === 404) {
				errorType = 'invalid_request_error';
				errorCode = 'model_not_found';
			}

			return res.status(statusCode).json({
				error: {
					message: errorText || `CAPI returned ${statusCode}`,
					type: errorType,
					code: errorCode,
				}
			});
		}

		// Set SSE headers
		res.setHeader('Content-Type', 'text/event-stream');
		res.setHeader('Cache-Control', 'no-cache');
		res.setHeader('Connection', 'keep-alive');
		res.setHeader('X-Accel-Buffering', 'no');

		// Copy relevant response headers from CAPI
		const requestIdHeader = capiResponse.headers.get('x-request-id');
		if (requestIdHeader) {
			res.setHeader('x-request-id', requestIdHeader);
		}

		// Pipe the SSE stream from CAPI directly to client
		// The CAPI SSE format is OpenAI-compatible, so we can pass it through
		// @see src/platform/networking/node/stream.ts - splitChunk() for the parsing
		if (capiResponse.body) {
			const reader = capiResponse.body.getReader();
			const decoder = new TextDecoder();

			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) {
						break;
					}
					const chunk = decoder.decode(value, { stream: true });
					res.write(chunk);
				}
			} catch (e: any) {
				if (e.name !== 'AbortError') {
					console.error('[streaming]', e.message);
				}
			} finally {
				res.end();
			}
		} else {
			// Fallback: read entire response
			const text = await capiResponse.text();
			res.write(text);
			res.end();
		}
	} catch (e: any) {
		console.error('[/v1/chat/completions]', e.message);

		// If headers already sent (during streaming), just end
		if (res.headersSent) {
			res.end();
			return;
		}

		res.status(500).json({
			error: { message: e.message, type: 'server_error', code: 'internal_error' }
		});
	}
});

/*---------------------------------------------------------------------------------------------
 *  POST /v1/embeddings - Embeddings
 *
 *  Forwards embedding requests to CAPI /embeddings endpoint.
 *  @see src/platform/networking/common/networking.ts - IEndpointBody (embed fields)
 *--------------------------------------------------------------------------------------------*/
proxyRouter.post('/embeddings', async (req: Request, res: ExpressResponse) => {
	try {
		const { token, capiUrl } = await tokenProvider.resolveCapiAuth(req);
		const request = req.body as OpenAIEmbeddingRequest;

		if (!request.input) {
			return res.status(400).json({
				error: { message: 'input is required', type: 'invalid_request_error', code: 'missing_input' }
			});
		}

		if (!request.model) {
			return res.status(400).json({
				error: { message: 'model is required', type: 'invalid_request_error', code: 'missing_model' }
			});
		}

		const capiBody = buildCapiEmbeddingsBody(request);
		const result = await fetchEmbeddings(capiUrl, token, capiBody);
		res.json(result);
	} catch (e: any) {
		console.error('[/v1/embeddings]', e.message);
		res.status(500).json({
			error: { message: e.message, type: 'server_error', code: 'embedding_error' }
		});
	}
});

/*---------------------------------------------------------------------------------------------
 *  POST /v1/responses - Responses API (pass-through)
 *
 *  Forwards requests to CAPI's /responses endpoint for models that use
 *  the Responses API format.
 *  @see src/platform/endpoint/node/responsesApi.ts
 *--------------------------------------------------------------------------------------------*/
proxyRouter.post('/responses', async (req: Request, res: ExpressResponse) => {
	try {
		const { token, capiUrl } = await tokenProvider.resolveCapiAuth(req);
		const requestId = generateUuid();
		const headers: Record<string, string> = {
			'Authorization': `Bearer ${token}`,
			'Content-Type': 'application/json',
			'Accept': req.body.stream ? 'text/event-stream' : 'application/json',
			'X-Request-Id': requestId,
			'X-GitHub-Api-Version': '2025-05-01',
			'Editor-Version': 'vscode/1.100.0',
			'Editor-Plugin-Version': 'copilot-chat/0.38.0',
			'Copilot-Integration-Id': 'vscode-chat',
			'OpenAI-Intent': 'conversation-panel',
			'X-Initiator': 'agent',
		};

		const capiResponse = await fetch(`${capiUrl}/responses`, {
			method: 'POST',
			headers,
			body: JSON.stringify(req.body),
		});

		if (!capiResponse.ok && !req.body.stream) {
			const text = await capiResponse.text().catch(() => '');
			return res.status(capiResponse.status).json({
				error: { message: text || `Responses API failed: ${capiResponse.status}`, type: 'server_error' }
			});
		}

		if (req.body.stream && capiResponse.body) {
			res.setHeader('Content-Type', 'text/event-stream');
			res.setHeader('Cache-Control', 'no-cache');
			res.setHeader('Connection', 'keep-alive');

			const reader = capiResponse.body.getReader();
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
		console.error('[/v1/responses]', e.message);
		if (res.headersSent) { res.end(); return; }
		res.status(500).json({
			error: { message: e.message, type: 'server_error', code: 'responses_error' }
		});
	}
});

/*---------------------------------------------------------------------------------------------
 *  POST /v1/messages - Anthropic Messages API (100% SDK compatible)
 *
 *  Full Anthropic SDK compatibility. Forwards requests to CAPI's /v1/messages
 *  endpoint with proper header forwarding, Anthropic error format, thinking
 *  support, tool use, prompt caching, and client disconnect handling.
 *
 *  Supports all Anthropic features:
 *    - Streaming and non-streaming responses
 *    - Extended thinking (interleaved-thinking-2025-05-14)
 *    - Tool use (tool_choice, auto, any, specific tool)
 *    - System messages (string or content blocks)
 *    - Prompt caching (anthropic-beta: prompt-caching-2024-07-31)
 *    - All Claude models available via Copilot
 *
 *  @see src/platform/endpoint/node/messagesApi.ts
 *--------------------------------------------------------------------------------------------*/
proxyRouter.post('/messages', async (req: Request, res: ExpressResponse) => {
	try {
		// --- Validation (Anthropic error format) ---
		const body = req.body;
		if (!body.model) {
			return res.status(400).json({
				type: 'error',
				error: { type: 'invalid_request_error', message: 'model: field required' },
			});
		}
		if (!body.max_tokens && body.max_tokens !== 0) {
			return res.status(400).json({
				type: 'error',
				error: { type: 'invalid_request_error', message: 'max_tokens: field required' },
			});
		}
		if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
			return res.status(400).json({
				type: 'error',
				error: { type: 'invalid_request_error', message: 'messages: field required, must be a non-empty array' },
			});
		}

		// --- Resolve auth ---
		const { token, capiUrl } = await tokenProvider.resolveCapiAuth(req);
		const isStream = body.stream ?? false;

		// --- Auto-adjust max_tokens when thinking is enabled ---
		if (body.thinking?.type === 'enabled' && body.thinking?.budget_tokens) {
			const budget = body.thinking.budget_tokens;
			if (body.max_tokens <= budget) {
				body.max_tokens = budget + 1;
			}
		}

		// --- Make request to CAPI ---
		const capiResponse = await fetchMessagesApi(
			capiUrl,
			token,
			body,
		);

		// --- Error handling (Anthropic format) ---
		if (!capiResponse.ok) {
			const text = await capiResponse.text().catch(() => '');
			// Try to parse as JSON (CAPI may return structured errors)
			try {
				const parsed = JSON.parse(text);
				// If it's already in Anthropic error format, forward as-is
				if (parsed.type === 'error' && parsed.error) {
					return res.status(capiResponse.status).json(parsed);
				}
				// Wrap OpenAI-style errors into Anthropic format
				const errMsg = parsed.error?.message || parsed.message || text;
				return res.status(capiResponse.status).json({
					type: 'error',
					error: {
						type: capiResponse.status === 401 ? 'authentication_error'
							: capiResponse.status === 429 ? 'rate_limit_error'
								: capiResponse.status === 404 ? 'not_found_error'
									: capiResponse.status >= 500 ? 'api_error'
										: 'invalid_request_error',
						message: errMsg,
					},
				});
			} catch {
				return res.status(capiResponse.status).json({
					type: 'error',
					error: {
						type: 'api_error',
						message: text || `Messages API failed with status ${capiResponse.status}`,
					},
				});
			}
		}

		// --- Streaming response: pipe SSE events directly ---
		if (isStream && capiResponse.body) {
			res.setHeader('Content-Type', 'text/event-stream');
			res.setHeader('Cache-Control', 'no-cache');
			res.setHeader('Connection', 'keep-alive');
			res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

			const reader = capiResponse.body.getReader();
			const decoder = new TextDecoder();
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) { break; }
					const chunk = decoder.decode(value, { stream: true });
					res.write(chunk);
				}
			} catch (e: any) {
				if (e.name !== 'AbortError') {
					console.error('[/v1/messages stream]', e.message);
				}
			} finally {
				res.end();
			}
		} else {
			// --- Non-streaming: forward JSON response as-is ---
			const result = await capiResponse.json();
			res.json(result);
		}
	} catch (e: any) {
		console.error('[/v1/messages]', e.message);
		if (res.headersSent) { res.end(); return; }
		res.status(500).json({
			type: 'error',
			error: { type: 'api_error', message: e.message || 'Internal server error' },
		});
	}
});

// Helper
function generateUuid(): string {
	return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
		const r = Math.random() * 16 | 0;
		const v = c === 'x' ? r : (r & 0x3 | 0x8);
		return v.toString(16);
	});
}
