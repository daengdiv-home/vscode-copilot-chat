/*---------------------------------------------------------------------------------------------
 *  Copilot Token Provider
 *
 *  Handles authenticating with GitHub and obtaining Copilot API tokens.
 *  Reuses the same token flow as the original extension:
 *    GitHub PAT -> https://api.github.com/copilot_internal/v2/token -> Copilot Token
 *
 *  The Copilot token is then used as Bearer token for CAPI requests.
 *--------------------------------------------------------------------------------------------*/

const GITHUB_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token';

/** Raw token envelope from the /copilot_internal/v2/token endpoint */
interface TokenEnvelope {
	token: string;
	expires_at: number;
	refresh_in: number;
	endpoints?: {
		api?: string;
		proxy?: string;
		'origin-tracker'?: string;
		telemetry?: string;
	};
	sku?: string;
	individual?: boolean;
	chat_enabled?: boolean;
	code_quote_enabled?: boolean;
	telemetry?: string;
	public_suggestions?: string;
	organization_list?: string[];
	organization_login_list?: string[];
	enterprise_list?: number[];
	copilot_plan?: string;
	limited_user_quotas?: {
		chat?: number;
		completions?: number;
	};
}

export interface CachedToken {
	rawToken: string;
	expiresAt: number;
	capiUrl: string;
	proxyUrl: string;
	sku: string;
	envelope: TokenEnvelope;
}

export class CopilotTokenProvider {
	private static instance: CopilotTokenProvider;
	private cache: Map<string, CachedToken> = new Map();
	private refreshTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

	static getInstance(): CopilotTokenProvider {
		if (!CopilotTokenProvider.instance) {
			CopilotTokenProvider.instance = new CopilotTokenProvider();
		}
		return CopilotTokenProvider.instance;
	}

	/**
	 * Get a valid Copilot token for the given GitHub PAT.
	 * Caches tokens and refreshes when expired.
	 */
	async getCopilotToken(githubToken: string): Promise<CachedToken> {
		const cached = this.cache.get(githubToken);
		const now = Math.floor(Date.now() / 1000);

		// Return cached if still valid (with 60s buffer)
		if (cached && cached.expiresAt > now + 60) {
			return cached;
		}

		// Fetch new token
		const tokenEnvelope = await this.fetchCopilotToken(githubToken);
		const expiresAt = tokenEnvelope.expires_at ?? (now + (tokenEnvelope.refresh_in || 1800));

		const result: CachedToken = {
			rawToken: tokenEnvelope.token,
			expiresAt,
			capiUrl: tokenEnvelope.endpoints?.api || 'https://api.githubcopilot.com',
			proxyUrl: tokenEnvelope.endpoints?.proxy || 'https://copilot-proxy.githubusercontent.com',
			sku: tokenEnvelope.sku || 'unknown',
			envelope: tokenEnvelope,
		};

		this.cache.set(githubToken, result);

		// Clear old timer
		const oldTimer = this.refreshTimers.get(githubToken);
		if (oldTimer) {
			clearTimeout(oldTimer);
		}

		// Auto-invalidate cache before expiry
		const refreshIn = Math.max((tokenEnvelope.refresh_in || 1800) - 120, 60);
		this.refreshTimers.set(githubToken, setTimeout(() => {
			this.cache.delete(githubToken);
			this.refreshTimers.delete(githubToken);
		}, refreshIn * 1000));

		return result;
	}

	/**
	 * Fetch a Copilot token from GitHub using a PAT
	 */
	private async fetchCopilotToken(githubToken: string): Promise<TokenEnvelope> {
		const response = await fetch(GITHUB_TOKEN_URL, {
			headers: {
				'Authorization': `token ${githubToken}`,
				'Accept': 'application/json',
				'Editor-Version': 'vscode/1.100.0',
				'Editor-Plugin-Version': 'copilot-chat/0.38.0',
				'User-Agent': 'GitHubCopilotChat/0.38.0',
			}
		});

		if (!response.ok) {
			const text = await response.text().catch(() => '');
			throw new Error(`Failed to get Copilot token: HTTP ${response.status} ${response.statusText}${text ? ` - ${text}` : ''}`);
		}

		const data = await response.json() as TokenEnvelope;
		if (!data.token) {
			throw new Error('Copilot token response missing token field');
		}

		return data;
	}

	/**
	 * Check if there's at least one valid cached token.
	 */
	hasValidToken(): boolean {
		const now = Math.floor(Date.now() / 1000);
		for (const cached of this.cache.values()) {
			if (cached.expiresAt > now + 60) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Resolves the GitHub token from request or environment
	 */
	resolveGitHubToken(req: any): string {
		// Check request-level override
		if (req.githubToken) {
			return req.githubToken;
		}
		// Fall back to environment variable
		const envToken = process.env.GITHUB_TOKEN;
		if (!envToken) {
			throw new Error('No GitHub token found. Set GITHUB_TOKEN env var or pass Authorization: Bearer ghp_xxx header.');
		}
		return envToken;
	}

	/**
	 * Resolves token for CAPI: if a direct copilot token is passed, use it directly.
	 * Otherwise obtain one via GitHub token exchange.
	 */
	async resolveCapiAuth(req: any): Promise<{ token: string; capiUrl: string }> {
		// Direct copilot token (non-GitHub PAT)
		if (req.copilotTokenDirect) {
			return {
				token: req.copilotTokenDirect,
				capiUrl: process.env.CAPI_URL || 'https://api.githubcopilot.com',
			};
		}

		const githubToken = this.resolveGitHubToken(req);
		const cached = await this.getCopilotToken(githubToken);
		return {
			token: cached.rawToken,
			capiUrl: cached.capiUrl,
		};
	}
}
