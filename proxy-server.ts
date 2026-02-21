/*---------------------------------------------------------------------------------------------
 *  OpenAI & Anthropic Compatible Proxy Server for GitHub Copilot Chat Extension
 *
 *  This proxy server exposes the GitHub Copilot API as both OpenAI-compatible
 *  and Anthropic-compatible REST APIs. It reuses the original extension types
 *  and authentication flow without modifying any original source files.
 *
 *  Usage:
 *    GITHUB_TOKEN=ghp_xxx npx tsx proxy-server.ts
 *    # or
 *    GITHUB_TOKEN=ghp_xxx node dist/proxy-server.js
 *
 *  OpenAI Endpoints:
 *    GET  /v1/models              - List available models
 *    POST /v1/chat/completions    - Chat completions (streaming & non-streaming)
 *    POST /v1/embeddings          - Embeddings
 *    GET  /v1/models/:modelId     - Get model info
 *
 *  Anthropic Endpoints:
 *    POST /v1/messages            - Anthropic Messages API (100% compatible)
 *
 *  Common:
 *    POST /v1/responses           - Responses API (pass-through)
 *    GET  /health                 - Health check
 *--------------------------------------------------------------------------------------------*/

import express, { Response as ExpressResponse, NextFunction, Request } from 'express';
import { CopilotTokenProvider } from './proxy-auth';
import { proxyRouter } from './proxy-routes';

const app = express();
const PORT = parseInt(process.env.PROXY_PORT || '8080', 10);
const DEBUG = process.env.PROXY_DEBUG === '1' || process.env.PROXY_DEBUG === 'true';

// Server stats
const serverStats = {
	startedAt: Date.now(),
	totalRequests: 0,
	activeRequests: 0,
};

// Parse JSON bodies
app.use(express.json({ limit: '50mb' }));

// CORS headers (support both OpenAI and Anthropic SDK headers)
app.use((_req: Request, res: ExpressResponse, next: NextFunction) => {
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta, anthropic-dangerous-direct-browser-access');
	if (_req.method === 'OPTIONS') {
		res.sendStatus(204);
		return;
	}
	next();
});

// Request logging & stats
app.use((req: Request, res: ExpressResponse, next: NextFunction) => {
	serverStats.totalRequests++;
	serverStats.activeRequests++;
	const start = Date.now();

	res.on('finish', () => {
		serverStats.activeRequests--;
		if (DEBUG) {
			const duration = Date.now() - start;
			console.log(`[${req.method}] ${req.path} → ${res.statusCode} (${duration}ms)`);
		}
	});

	next();
});

// Health check
app.get('/health', (_req: Request, res: ExpressResponse) => {
	const tokenProvider = CopilotTokenProvider.getInstance();
	res.json({
		status: 'ok',
		service: 'copilot-openai-anthropic-proxy',
		version: '1.3.0',
		uptime_seconds: Math.floor((Date.now() - serverStats.startedAt) / 1000),
		total_requests: serverStats.totalRequests,
		active_requests: serverStats.activeRequests,
		token_status: tokenProvider.hasValidToken() ? 'valid' : 'expired',
		debug: DEBUG,
		endpoints: [
			'GET  /v1/models',
			'GET  /v1/models/:model',
			'POST /v1/chat/completions',
			'POST /v1/embeddings',
			'POST /v1/responses',
			'POST /v1/messages',
		],
	});
});

// Authentication middleware - extracts token from Authorization header, x-api-key, or env
// Supports both OpenAI (Authorization: Bearer) and Anthropic (x-api-key) authentication
app.use('/v1', (req: Request, _res: ExpressResponse, next: NextFunction) => {
	const extractGitHubToken = (token: string) => {
		if (token.startsWith('ghp_') || token.startsWith('gho_') || token.startsWith('ghu_') || token.startsWith('github_pat_')) {
			(req as any).githubToken = token;
			return true;
		}
		// Copilot tokens are long JWT-like strings (header.payload.signature)
		if (token.length > 100 && token.includes('.')) {
			(req as any).copilotTokenDirect = token;
			return true;
		}
		return false;
	};

	// 1. Check Authorization: Bearer header (OpenAI SDK style)
	const authHeader = req.headers.authorization;
	if (authHeader?.startsWith('Bearer ')) {
		extractGitHubToken(authHeader.slice(7));
	}

	// 2. Check x-api-key header (Anthropic SDK style)
	const apiKey = req.headers['x-api-key'] as string | undefined;
	if (apiKey && !(req as any).githubToken && !(req as any).copilotTokenDirect) {
		extractGitHubToken(apiKey);
	}

	next();
});

// Mount OpenAI-compatible routes
app.use('/v1', proxyRouter);

// Error handler
app.use((err: Error, _req: Request, res: ExpressResponse, _next: NextFunction) => {
	console.error('[Proxy Error]', err);
	res.status(500).json({
		error: {
			message: err.message || 'Internal server error',
			type: 'server_error',
			code: 'internal_error'
		}
	});
});

// Start server
async function main() {
	const githubToken = process.env.GITHUB_TOKEN;
	if (!githubToken) {
		console.error('Error: GITHUB_TOKEN environment variable is required.');
		console.error('Set it to your GitHub Personal Access Token (with copilot scope).');
		console.error('  export GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx');
		process.exit(1);
	}

	// Pre-warm the token cache
	try {
		const tokenProvider = CopilotTokenProvider.getInstance();
		console.log('Fetching initial Copilot token...');
		await tokenProvider.getCopilotToken(githubToken);
		console.log('Copilot token acquired successfully.');
	} catch (e: any) {
		console.error('Failed to acquire Copilot token:', e.message);
		console.error('Make sure your GITHUB_TOKEN has copilot access.');
		process.exit(1);
	}

	app.listen(PORT, () => {
		console.log(`\n🚀 Copilot OpenAI + Anthropic Proxy v1.3.0 running on http://localhost:${PORT}`);
		console.log(`\nOpenAI-Compatible Endpoints:`);
		console.log(`  GET  http://localhost:${PORT}/v1/models`);
		console.log(`  POST http://localhost:${PORT}/v1/chat/completions`);
		console.log(`  POST http://localhost:${PORT}/v1/embeddings`);
		console.log(`  POST http://localhost:${PORT}/v1/responses`);
		console.log(`\nAnthropic-Compatible Endpoints:`);
		console.log(`  POST http://localhost:${PORT}/v1/messages`);
		console.log(`\nCommon:`);
		console.log(`  GET  http://localhost:${PORT}/health`);
		console.log(`\nUsage with OpenAI SDK:`);
		console.log(`  client = OpenAI(base_url="http://localhost:${PORT}/v1", api_key="dummy")`);
		console.log(`\nUsage with Anthropic SDK:`);
		console.log(`  client = Anthropic(base_url="http://localhost:${PORT}", api_key="dummy")`);
		if (DEBUG) { console.log(`\nDebug mode: ON (set PROXY_DEBUG=0 to disable)`); }
		console.log('');
	});

	// Graceful shutdown
	const shutdown = (signal: string) => {
		console.log(`\n${signal} received. Shutting down gracefully...`);
		process.exit(0);
	};
	process.on('SIGTERM', () => shutdown('SIGTERM'));
	process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch(e => {
	console.error('Fatal error:', e);
	process.exit(1);
});
