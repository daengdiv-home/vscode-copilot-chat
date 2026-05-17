/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  CAPI Client - Direct HTTP client for the GitHub Copilot API
 *
 *  This module provides direct HTTP communication with the CAPI endpoints,
 *  reusing the same URL patterns and headers as the original extension's
 *  networking layer (src/platform/networking/common/networking.ts).
 *
 *  Imports types from the original source to ensure compatibility.
 *--------------------------------------------------------------------------------------------*/


/**
 * Extension package.json - used to derive version headers dynamically.
 * @see src/platform/env/common/packagejson.ts
 * @see src/platform/env/vscode/envServiceImpl.ts
 */
const packageJson: { name: string; version: string; engines: { vscode: string } } = require('./package.json');

/** Derived version constants (mirrors IEnvService.getEditorInfo / getEditorPluginInfo) */
const EDITOR_NAME = 'vscode';
const EDITOR_VERSION = packageJson.engines.vscode.replace(/^[^0-9]*/, ''); // strip leading ^ or ~
const PLUGIN_NAME = packageJson.name;       // "copilot-chat"
const PLUGIN_VERSION = packageJson.version;  // e.g. "0.44.0"

/**
 * Persistent session-level identifiers.
 * Real VS Code uses vscode.env.sessionId (per-session) and vscode.env.machineId (per-machine).
 * We generate them once at startup and reuse across all requests, just like the real extension.
 * @see src/platform/env/vscode/envServiceImpl.ts
 */
const PERSISTENT_SESSION_ID = generateSessionId();
const PERSISTENT_MACHINE_ID = generateSessionId();

/**
 * Persistent interaction ID — reused for all requests within a session.
 * Real VS Code uses interactionService.interactionId which persists per conversation.
 * @see src/extension/prompt/node/chatMLFetcher.ts - X-Interaction-Id
 */
const PERSISTENT_INTERACTION_ID = generateSessionId();

/** Generate a stable UUID. Called once at module load. */
function generateSessionId(): string {
	// Use crypto.randomUUID if available (Node 19+), otherwise fallback
	try {
		return require('crypto').randomUUID();
	} catch {
		return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
			const r = Math.random() * 16 | 0;
			const v = c === 'x' ? r : (r & 0x3 | 0x8);
			return v.toString(16);
		});
	}
}

/**
 * Model API response type - mirrors IModelAPIResponse from the extension.
 * @see src/platform/endpoint/common/endpointProvider.ts
 */
export interface ModelAPIResponse {
	id: string;
	vendor: string;
	name: string;
	model_picker_enabled: boolean;
	preview?: boolean;
	is_chat_default: boolean;
	is_chat_fallback: boolean;
	version: string;
	warning_messages?: { code: string; message: string }[];
	info_messages?: { code: string; message: string }[];
	billing?: { is_premium: boolean; multiplier: number; restricted_to?: string[] };
	capabilities: {
		type: 'chat' | 'embeddings' | 'completion';
		family: string;
		tokenizer: string;
		limits?: {
			max_prompt_tokens?: number;
			max_output_tokens?: number;
			max_context_window_tokens?: number;
			max_inputs?: number;
			vision?: { max_prompt_images?: number };
		};
		supports?: {
			parallel_tool_calls?: boolean;
			tool_calls?: boolean;
			streaming?: boolean;
			vision?: boolean;
			prediction?: boolean;
			thinking?: boolean;
			adaptive_thinking?: boolean;
			max_thinking_budget?: number;
			min_thinking_budget?: number;
			reasoning_effort?: string[];
		};
	};
	supported_endpoints?: string[];
	custom_model?: { key_name: string; owner_name: string };
}

// Generate UUID without external dependency
function generateUuid(): string {
	return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
		const r = Math.random() * 16 | 0;
		const v = c === 'x' ? r : (r & 0x3 | 0x8);
		return v.toString(16);
	});
}

/**
 * Options for getCapiHeaders to support per-request customization.
 */
interface CapiHeaderOptions {
	/** Whether this is a user-initiated request (default: true). Controls X-Initiator header. */
	userInitiated?: boolean;
	/** Override OpenAI-Intent (default: 'conversation-panel'). */
	intent?: string;
	/** Override X-Interaction-Type. Derived from intent if not provided. */
	interactionType?: string;
	/** Whether the request contains image content (adds Copilot-Vision-Request header). */
	hasVision?: boolean;
}

/** Standard headers for CAPI requests.
 * Mirrors the exact headers real VS Code sends.
 * @see src/platform/networking/common/networking.ts - networkRequest headers
 * @see src/platform/networking/node/nodeFetcher.ts - User-Agent, X-VSCode-User-Agent-Library-Version
 * @see src/platform/env/common/envService.ts - getEditorVersionHeaders
 * @see src/extension/prompt/node/chatMLFetcher.ts - X-Interaction-Id, X-Initiator
 * @see src/platform/endpoint/common/capiClient.ts - VScode-SessionId, VScode-MachineId
 */
export function getCapiHeaders(copilotToken: string, requestId: string, options?: CapiHeaderOptions): Record<string, string> {
	const intent = options?.intent ?? 'conversation-panel';
	const interactionType = options?.interactionType ?? intent;
	const headers: Record<string, string> = {
		'Authorization': `Bearer ${copilotToken}`,
		'Content-Type': 'application/json',
		'Accept': 'application/json',
		'X-Request-Id': requestId,
		'X-GitHub-Api-Version': '2025-05-01',
		// Editor identification headers (same as real VS Code)
		// @see src/platform/env/common/envService.ts - getEditorVersionHeaders
		'Editor-Version': `${EDITOR_NAME}/${EDITOR_VERSION}`,
		'Editor-Plugin-Version': `${PLUGIN_NAME}/${PLUGIN_VERSION}`,
		// Real VS Code uses node-fetch internally
		// @see src/platform/networking/node/nodeFetcher.ts
		'User-Agent': `GitHubCopilotChat/${PLUGIN_VERSION}`,
		'X-VSCode-User-Agent-Library-Version': 'node-fetch',
		// Session & machine tracking (same as CAPIClient SDK)
		// @see src/platform/endpoint/common/capiClient.ts - constructor
		// @see src/extension/completions-core/vscode-node/lib/src/networking.ts
		'VScode-SessionId': PERSISTENT_SESSION_ID,
		'VScode-MachineId': PERSISTENT_MACHINE_ID,
		// Request routing & tracking (mirrors networkRequest in networking.ts)
		'OpenAI-Intent': intent,
		'X-Interaction-Type': interactionType,
		'X-Agent-Task-Id': requestId,
		// Persistent per-session interaction ID (same as real extension)
		// @see src/extension/prompt/node/chatMLFetcher.ts - X-Interaction-Id
		'X-Interaction-Id': PERSISTENT_INTERACTION_ID,
		// @see src/extension/prompt/node/chatMLFetcher.ts - X-Initiator
		'X-Initiator': (options?.userInitiated ?? true) ? 'user' : 'agent',
	};

	// Copilot-Vision-Request header for requests with images
	// @see src/extension/prompt/node/chatMLFetcher.ts lines 1345-1348
	if (options?.hasVision) {
		headers['Copilot-Vision-Request'] = 'true';
	}

	return headers;
}

/** Model metadata as returned by CAPI /models endpoint */
export interface CAPIModelResponse {
	data: ModelAPIResponse[];
}

/**
 * Fetch the list of models from CAPI.
 * Uses the same endpoint as ModelMetadataFetcher in the extension.
 * @see src/platform/endpoint/node/modelMetadataFetcher.ts
 */
export async function fetchModels(capiUrl: string, copilotToken: string): Promise<ModelAPIResponse[]> {
	const requestId = generateUuid();
	const response = await fetch(`${capiUrl}/models`, {
		method: 'GET',
		headers: getCapiHeaders(copilotToken, requestId),
	});

	if (!response.ok) {
		const text = await response.text().catch(() => '');
		throw new Error(`CAPI /models request failed: ${response.status} ${response.statusText}${text ? ` - ${text}` : ''}`);
	}

	const data = await response.json() as CAPIModelResponse;
	return data.data || [];
}

/**
 * Convert IModelAPIResponse to OpenAI Model format
 * @see https://platform.openai.com/docs/api-reference/models/object
 */
export function toOpenAIModel(model: ModelAPIResponse) {
	return {
		id: model.id,
		object: 'model' as const,
		created: Math.floor(Date.now() / 1000),
		owned_by: model.custom_model ? `${model.custom_model.owner_name}` : model.vendor || 'github-copilot',
		// Extra metadata
		name: model.name,
		version: model.version,
		supported_endpoints: model.supported_endpoints,
		capabilities: {
			type: model.capabilities.type,
			family: model.capabilities.family,
			thinking: model.capabilities.supports?.thinking,
			adaptive_thinking: model.capabilities.supports?.adaptive_thinking,
			max_thinking_budget: model.capabilities.supports?.max_thinking_budget,
			min_thinking_budget: model.capabilities.supports?.min_thinking_budget,
			reasoning_effort: model.capabilities.supports?.reasoning_effort,
			parallel_tool_calls: model.capabilities.supports?.parallel_tool_calls,
		},
	};
}

/** OpenAI-compatible chat message */
export interface OpenAIChatMessage {
	role: 'system' | 'user' | 'assistant' | 'tool' | 'function';
	content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
	name?: string;
	tool_calls?: Array<{
		id: string;
		type: 'function';
		function: { name: string; arguments: string };
	}>;
	tool_call_id?: string;
}

/** OpenAI-compatible chat completion request */
export interface OpenAIChatCompletionRequest {
	model: string;
	messages: OpenAIChatMessage[];
	temperature?: number;
	top_p?: number;
	n?: number;
	stream?: boolean;
	stop?: string | string[];
	max_tokens?: number;
	max_completion_tokens?: number;
	presence_penalty?: number;
	frequency_penalty?: number;
	logit_bias?: Record<string, number>;
	user?: string;
	tools?: Array<{
		type: 'function';
		function: {
			name: string;
			description: string;
			parameters?: object;
		};
	}>;
	tool_choice?: 'none' | 'auto' | { type: 'function'; function: { name: string } };
	response_format?: { type: 'text' | 'json_object' };
	seed?: number;
	// Thinking/reasoning support
	// @see src/platform/endpoint/node/chatEndpoint.ts - customizeCapiBody()
	reasoning_effort?: 'low' | 'medium' | 'high';
	thinking_budget?: number;
	// Anthropic-native thinking config (pass-through)
	thinking?: {
		type: 'enabled' | 'disabled' | 'adaptive';
		budget_tokens?: number;
	};
}

/** OpenAI-compatible embedding request */
export interface OpenAIEmbeddingRequest {
	input: string | string[];
	model: string;
	encoding_format?: 'float' | 'base64';
	dimensions?: number;
}

/**
 * Build CAPI request body from OpenAI-compatible request.
 * Maps the OpenAI format to what CAPI expects.
 * @see src/platform/networking/common/networking.ts - IEndpointBody
 * @see src/platform/endpoint/node/chatEndpoint.ts - createRequestBody
 */
export function buildCapiChatBody(request: OpenAIChatCompletionRequest): Record<string, any> {
	const body: Record<string, any> = {
		model: request.model,
		messages: request.messages,
		stream: request.stream ?? true,
		stream_options: { include_usage: true },
	};

	if (request.temperature !== undefined) { body.temperature = request.temperature; }
	if (request.top_p !== undefined) { body.top_p = request.top_p; }
	if (request.n !== undefined) { body.n = request.n; }
	if (request.stop !== undefined) { body.stop = request.stop; }
	if (request.max_tokens !== undefined) { body.max_tokens = request.max_tokens; }
	if (request.max_completion_tokens !== undefined) { body.max_tokens = request.max_completion_tokens; }
	if (request.presence_penalty !== undefined) { body.presence_penalty = request.presence_penalty; }
	if (request.frequency_penalty !== undefined) { body.frequency_penalty = request.frequency_penalty; }
	if (request.logit_bias !== undefined) { body.logit_bias = request.logit_bias; }
	if (request.tools) { body.tools = request.tools; }
	if (request.tool_choice) { body.tool_choice = request.tool_choice; }
	if (request.seed !== undefined) { body.seed = request.seed; }
	if (request.response_format) { body.response_format = request.response_format; }

	// Thinking/reasoning budget for Claude/Anthropic models
	// Maps OpenAI reasoning_effort to CAPI thinking_budget
	// @see src/platform/endpoint/node/chatEndpoint.ts - _getThinkingBudget(), customizeCapiBody()
	if (request.thinking?.type === 'adaptive') {
		// Anthropic adaptive thinking: pass through directly
		body.thinking = { type: 'adaptive' };
	} else if (request.thinking?.type === 'enabled' && request.thinking.budget_tokens) {
		// Anthropic thinking config pass-through
		body.thinking_budget = Math.max(1024, request.thinking.budget_tokens);
	} else if (request.thinking_budget !== undefined) {
		// Direct thinking_budget pass-through (takes priority)
		body.thinking_budget = Math.max(1024, request.thinking_budget);
	} else if (request.reasoning_effort) {
		// Map OpenAI reasoning_effort levels to thinking_budget values
		// Low: 1024 (minimum), Medium: 10000, High: 32000 (CAPI max)
		const effortMap: Record<string, number> = {
			low: 1024,
			medium: 10000,
			high: 32000,
		};
		const budget = effortMap[request.reasoning_effort];
		if (budget) {
			body.thinking_budget = budget;
		}
	}

	return body;
}

/**
 * Detect if messages contain image content (for Copilot-Vision-Request header).
 * @see src/extension/prompt/node/chatMLFetcher.ts lines 1345-1348
 */
export function messagesContainVision(messages: OpenAIChatMessage[]): boolean {
	return messages?.some(m =>
		Array.isArray(m.content) && m.content.some(c => c.type === 'image_url' || 'image_url' in c)
	) || false;
}

/**
 * Build CAPI embeddings request body from OpenAI-compatible request.
 * @see src/platform/networking/common/networking.ts - IEndpointBody
 */
export function buildCapiEmbeddingsBody(request: OpenAIEmbeddingRequest): Record<string, any> {
	const input = Array.isArray(request.input) ? request.input : [request.input];
	return {
		model: request.model,
		input,
		dimensions: request.dimensions,
	};
}

/**
 * Forward a streaming chat completions request to CAPI and pipe the SSE stream back.
 * Uses the same SSE format as the extension's stream processing.
 * @see src/platform/networking/node/stream.ts - SSEProcessor
 * @see src/extension/prompt/node/chatMLFetcher.ts - _fetchWithInstrumentation
 */
export async function streamChatCompletion(
	capiUrl: string,
	copilotToken: string,
	body: Record<string, any>,
	signal?: AbortSignal,
	hasVision?: boolean,
): Promise<globalThis.Response> {
	const requestId = generateUuid();
	const headers = getCapiHeaders(copilotToken, requestId, { hasVision });
	headers['Accept'] = 'text/event-stream';

	const response = await fetch(`${capiUrl}/chat/completions`, {
		method: 'POST',
		headers,
		body: JSON.stringify(body),
		signal,
	});

	return response;
}

/**
 * Forward a non-streaming chat completions request to CAPI.
 * @see src/platform/endpoint/node/chatEndpoint.ts - defaultNonStreamChatResponseProcessor
 */
export async function fetchChatCompletion(
	capiUrl: string,
	copilotToken: string,
	body: Record<string, any>,
	hasVision?: boolean,
): Promise<any> {
	const requestId = generateUuid();
	const headers = getCapiHeaders(copilotToken, requestId, { hasVision });

	body.stream = false;
	delete body.stream_options;

	const response = await fetch(`${capiUrl}/chat/completions`, {
		method: 'POST',
		headers,
		body: JSON.stringify(body),
	});

	if (!response.ok) {
		const text = await response.text().catch(() => '');
		throw new Error(`CAPI chat completions failed: ${response.status}${text ? ` - ${text}` : ''}`);
	}

	return response.json();
}

/**
 * Forward an embeddings request to CAPI.
 */
export async function fetchEmbeddings(
	capiUrl: string,
	copilotToken: string,
	body: Record<string, any>,
): Promise<any> {
	const requestId = generateUuid();
	const headers = getCapiHeaders(copilotToken, requestId);

	const response = await fetch(`${capiUrl}/embeddings`, {
		method: 'POST',
		headers,
		body: JSON.stringify(body),
	});

	if (!response.ok) {
		const text = await response.text().catch(() => '');
		throw new Error(`CAPI embeddings failed: ${response.status}${text ? ` - ${text}` : ''}`);
	}

	return response.json();
}

/*---------------------------------------------------------------------------------------------
 *  Thinking Support via Messages API
 *
 *  CAPI's /chat/completions endpoint does not return thinking content,
 *  so when thinking_budget is set and the model is Claude/Anthropic,
 *  we route through the /v1/messages endpoint (Anthropic Messages API)
 *  and convert the response back to OpenAI chat completions format.
 *
 *  @see src/platform/endpoint/node/messagesApi.ts - createMessagesRequestBody
 *  @see src/platform/endpoint/node/chatEndpoint.ts - customizeCapiBody
 *  @see src/platform/thinking/common/thinkingUtils.ts - extractThinkingDeltaFromChoice
 *--------------------------------------------------------------------------------------------*/

/** Check if a model ID represents a Claude/Anthropic model */
export function isClaudeModel(modelId: string): boolean {
	const lower = modelId.toLowerCase();
	return lower.startsWith('claude') || lower.includes('anthropic');
}

/** Convert OpenAI messages format to Anthropic Messages API format */
function convertToMessagesFormat(messages: OpenAIChatMessage[]): {
	system?: string;
	messages: Array<{ role: string; content: string | Array<{ type: string; text?: string; source?: any }> }>;
} {
	let systemPrompt: string | undefined;
	const apiMessages: Array<{ role: string; content: string | Array<{ type: string; text?: string; source?: any }> }> = [];

	for (const msg of messages) {
		if (msg.role === 'system') {
			// Accumulate system messages
			const text = typeof msg.content === 'string'
				? msg.content
				: msg.content.filter(p => p.type === 'text').map(p => p.text).join('\n');
			systemPrompt = systemPrompt ? `${systemPrompt}\n${text}` : text;
			continue;
		}

		apiMessages.push({
			role: msg.role === 'tool' ? 'user' : msg.role,
			content: typeof msg.content === 'string'
				? msg.content
				: msg.content.map(part => {
					if (part.type === 'text') {
						return { type: 'text', text: part.text };
					}
					if (part.type === 'image_url' && part.image_url) {
						return {
							type: 'image',
							source: {
								type: 'url',
								url: part.image_url.url,
							}
						};
					}
					return { type: 'text', text: String(part.text || '') };
				}),
		});
	}

	return { system: systemPrompt, messages: apiMessages };
}

/**
 * Build a Messages API request body from an OpenAI chat request with thinking enabled.
 * @see src/platform/endpoint/node/messagesApi.ts - createMessagesRequestBody
 */
export function buildMessagesApiBody(
	request: OpenAIChatCompletionRequest,
	thinkingBudget: number,
): Record<string, any> {
	const { system, messages } = convertToMessagesFormat(request.messages);
	const maxTokens = request.max_tokens ?? request.max_completion_tokens ?? 16384;

	const body: Record<string, any> = {
		model: request.model,
		messages,
		max_tokens: Math.max(maxTokens, thinkingBudget + 1),
		stream: request.stream ?? false,
		thinking: thinkingBudget > 0 ? { type: 'enabled', budget_tokens: thinkingBudget } : undefined,
	};

	if (system) { body.system = system; }
	if (request.temperature !== undefined) { body.temperature = request.temperature; }
	if (request.top_p !== undefined) { body.top_p = request.top_p; }
	if (request.stop !== undefined) { body.stop_sequences = Array.isArray(request.stop) ? request.stop : [request.stop]; }
	if (request.tools) {
		body.tools = request.tools.map(t => {
			const { $schema: _, ...params } = (t.function.parameters || {}) as Record<string, unknown>;
			return {
				name: t.function.name,
				description: t.function.description,
				input_schema: { type: 'object', properties: {}, ...params },
			};
		});
	}
	if (request.tool_choice) {
		if (request.tool_choice === 'auto' || request.tool_choice === 'none') {
			body.tool_choice = { type: request.tool_choice };
		} else if (typeof request.tool_choice === 'object' && request.tool_choice.type === 'function') {
			body.tool_choice = { type: 'tool', name: request.tool_choice.function.name };
		}
	}

	return body;
}

/**
 * Send a Messages API request to CAPI.
 * @see src/platform/endpoint/node/messagesApi.ts
 */
export async function fetchMessagesApi(
	capiUrl: string,
	copilotToken: string,
	body: Record<string, any>,
	signal?: AbortSignal,
): Promise<globalThis.Response> {
	const requestId = generateUuid();
	const headers = getCapiHeaders(copilotToken, requestId, { intent: 'conversation-agent', interactionType: 'conversation-agent' });
	if (body.stream) {
		headers['Accept'] = 'text/event-stream';
	}
	// Anthropic beta headers for thinking and advanced features
	// @see src/platform/endpoint/node/chatEndpoint.ts - getExtraHeaders
	const betaFeatures: string[] = [];
	if (body.thinking?.type !== 'adaptive') {
		betaFeatures.push('interleaved-thinking-2025-05-14');
	}
	// Context management and advanced tool use betas
	// @see src/platform/endpoint/node/chatEndpoint.ts lines 269-276
	betaFeatures.push('context-management-2025-06-27');
	if (body.tools && body.tools.length > 0) {
		betaFeatures.push('advanced-tool-use-2025-11-20');
	}
	headers['anthropic-beta'] = betaFeatures.join(',');

	const response = await fetch(`${capiUrl}/v1/messages`, {
		method: 'POST',
		headers,
		body: JSON.stringify(body),
		signal,
	});

	return response;
}

/**
 * Forward a raw Anthropic Messages API request to CAPI, preserving client
 * Anthropic headers (anthropic-version, anthropic-beta, etc.).
 *
 * This is designed for full Anthropic SDK compatibility: the request body
 * is forwarded as-is, headers are merged, and the response is returned
 * unmodified so the route can pipe it directly to the client.
 */
export async function fetchMessagesApiNative(
	capiUrl: string,
	copilotToken: string,
	body: Record<string, any>,
	clientHeaders?: {
		anthropicVersion?: string;
		anthropicBeta?: string;
	},
	signal?: AbortSignal,
): Promise<globalThis.Response> {
	const requestId = generateUuid();
	const isStream = body.stream ?? false;

	const headers = getCapiHeaders(copilotToken, requestId, {
		intent: 'conversation-agent',
		interactionType: 'conversation-agent',
	});
	headers['Accept'] = isStream ? 'text/event-stream' : 'application/json';

	// NOTE: Do NOT forward anthropic-version header to CAPI.
	// CAPI hangs/times out when this header is present. The Anthropic SDK
	// always sends it, but CAPI handles versioning internally.

	// Merge anthropic-beta: include interleaved-thinking for non-adaptive models, plus any client betas
	// @see src/platform/endpoint/node/chatEndpoint.ts - getExtraHeaders
	const betaFeatures = new Set<string>();
	// Only add interleaved-thinking if the request doesn't use adaptive thinking
	if (body.thinking?.type !== 'adaptive') {
		betaFeatures.add('interleaved-thinking-2025-05-14');
	}
	// Context management and advanced tool use betas
	betaFeatures.add('context-management-2025-06-27');
	if (body.tools && body.tools.length > 0) {
		betaFeatures.add('advanced-tool-use-2025-11-20');
	}
	if (clientHeaders?.anthropicBeta) {
		for (const beta of clientHeaders.anthropicBeta.split(',')) {
			const trimmed = beta.trim();
			if (trimmed) { betaFeatures.add(trimmed); }
		}
	}
	if (betaFeatures.size > 0) {
		headers['anthropic-beta'] = [...betaFeatures].join(',');
	}

	const response = await fetch(`${capiUrl}/v1/messages`, {
		method: 'POST',
		headers,
		body: JSON.stringify(body),
		signal,
	});

	return response;
}

/**
 * Convert a non-streaming Messages API response to OpenAI chat completions format.
 * Extracts thinking blocks and text blocks into a structured response.
 */
export function convertMessagesResponseToCompletions(messagesResponse: any): any {
	const thinkingBlocks: Array<{ thinking: string; signature?: string }> = [];
	let textContent = '';
	const toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = [];

	for (const block of (messagesResponse.content || [])) {
		if (block.type === 'thinking') {
			thinkingBlocks.push({
				thinking: block.thinking || '',
				signature: block.signature,
			});
		} else if (block.type === 'text') {
			textContent += block.text || '';
		} else if (block.type === 'tool_use') {
			toolCalls.push({
				id: block.id || generateUuid(),
				type: 'function',
				function: {
					name: block.name,
					arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input || {}),
				},
			});
		}
	}

	const choice: Record<string, any> = {
		index: 0,
		finish_reason: messagesResponse.stop_reason === 'end_turn' ? 'stop'
			: messagesResponse.stop_reason === 'max_tokens' ? 'length'
				: messagesResponse.stop_reason === 'tool_use' ? 'tool_calls'
					: messagesResponse.stop_reason || 'stop',
		message: {
			role: 'assistant',
			content: textContent || null,
		},
	};

	// Add tool calls if present
	if (toolCalls.length > 0) {
		choice.message.tool_calls = toolCalls;
	}

	// Add thinking content if present
	if (thinkingBlocks.length > 0) {
		choice.message.reasoning_content = thinkingBlocks.map(b => ({
			type: 'thinking',
			thinking: b.thinking,
			...(b.signature ? { signature: b.signature } : {}),
		}));
	}

	const usage = messagesResponse.usage;
	return {
		id: messagesResponse.id || generateUuid(),
		object: 'chat.completion',
		created: Math.floor(Date.now() / 1000),
		model: messagesResponse.model,
		choices: [choice],
		usage: usage ? {
			prompt_tokens: usage.input_tokens || 0,
			completion_tokens: usage.output_tokens || 0,
			total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
			...(usage.cache_read_input_tokens ? { prompt_tokens_details: { cached_tokens: usage.cache_read_input_tokens } } : {}),
		} : undefined,
	};
}

/**
 * Convert a Messages API SSE stream to OpenAI chat completions SSE format.
 * Transforms Anthropic event types (message_start, content_block_start, etc.)
 * into OpenAI SSE chunks (data: {"choices": [...]}).
 *
 * @see src/platform/endpoint/node/messagesApi.ts - SSE event handling
 * @see src/platform/networking/node/stream.ts - SSEProcessor
 */
export class MessagesStreamConverter {
	private messageId = '';
	private model = '';
	private currentToolCallIndex = -1;

	/** Convert a single Anthropic SSE event to OpenAI SSE format */
	convert(eventType: string, data: any): string[] {
		const chunks: string[] = [];

		switch (eventType) {
			case 'message_start': {
				this.messageId = data.message?.id || generateUuid();
				this.model = data.message?.model || '';
				break;
			}

			case 'content_block_start': {
				const block = data.content_block;
				if (block?.type === 'thinking') {
					// Start of thinking block - emit reasoning_content delta
					chunks.push(this.makeChunk({ reasoning_content: [{ type: 'thinking', thinking: '' }] }));
				} else if (block?.type === 'text') {
					// Start of text block
					chunks.push(this.makeChunk({ role: 'assistant', content: '' }));
				} else if (block?.type === 'tool_use') {
					// Start of tool call
					this.currentToolCallIndex++;
					chunks.push(this.makeChunk({
						tool_calls: [{
							index: this.currentToolCallIndex,
							id: block.id || generateUuid(),
							type: 'function',
							function: {
								name: block.name || '',
								arguments: '',
							},
						}],
					}));
				}
				break;
			}

			case 'content_block_delta': {
				const delta = data.delta;
				if (delta?.type === 'thinking_delta' && delta.thinking) {
					chunks.push(this.makeChunk({
						reasoning_content: [{ type: 'thinking', thinking: delta.thinking }],
					}));
				} else if (delta?.type === 'signature_delta' && delta.signature) {
					chunks.push(this.makeChunk({
						reasoning_content: [{ type: 'thinking', signature: delta.signature }],
					}));
				} else if (delta?.type === 'text_delta' && delta.text) {
					chunks.push(this.makeChunk({ content: delta.text }));
				} else if (delta?.type === 'input_json_delta' && delta.partial_json !== undefined) {
					// Tool call argument streaming
					chunks.push(this.makeChunk({
						tool_calls: [{
							index: this.currentToolCallIndex,
							function: { arguments: delta.partial_json },
						}],
					}));
				}
				break;
			}

			case 'message_delta': {
				const stopReason = data.delta?.stop_reason;
				const finishReason = stopReason === 'end_turn' ? 'stop'
					: stopReason === 'max_tokens' ? 'length'
						: stopReason === 'tool_use' ? 'tool_calls'
							: stopReason || null;

				const usageChunk: Record<string, any> = {
					choices: [{
						index: 0,
						finish_reason: finishReason,
						delta: {},
					}],
					created: Math.floor(Date.now() / 1000),
					id: this.messageId,
					model: this.model,
				};

				if (data.usage) {
					usageChunk.usage = {
						prompt_tokens: data.usage.input_tokens || 0,
						completion_tokens: data.usage.output_tokens || 0,
						total_tokens: (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0),
					};
				}

				chunks.push(`data: ${JSON.stringify(usageChunk)}\n\n`);
				break;
			}

			case 'message_stop': {
				chunks.push('data: [DONE]\n\n');
				break;
			}

			// content_block_stop, ping, etc. - no output needed
		}

		return chunks;
	}

	private makeChunk(delta: Record<string, any>): string {
		const chunk = {
			choices: [{
				index: 0,
				delta,
			}],
			created: Math.floor(Date.now() / 1000),
			id: this.messageId,
			model: this.model,
		};
		return `data: ${JSON.stringify(chunk)}\n\n`;
	}
}

/**
 * Parse Anthropic SSE events from a text chunk.
 * Returns array of {event, data} pairs.
 */
export function parseAnthropicSSE(text: string): Array<{ event: string; data: any }> {
	const results: Array<{ event: string; data: any }> = [];
	const lines = text.split('\n');
	let currentEvent = '';

	for (const line of lines) {
		if (line.startsWith('event: ')) {
			currentEvent = line.slice(7).trim();
		} else if (line.startsWith('data: ')) {
			const dataStr = line.slice(6).trim();
			if (dataStr && currentEvent) {
				try {
					results.push({ event: currentEvent, data: JSON.parse(dataStr) });
				} catch {
					// Skip malformed JSON
				}
				currentEvent = '';
			}
		}
	}

	return results;
}
