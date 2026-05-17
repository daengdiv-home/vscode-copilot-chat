/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Proxy Server Contribution
 *
 *  Registers VS Code commands to start/stop the integrated proxy server and
 *  auto-starts it when the configuration setting is enabled.
 *
 *  Commands:
 *    github.copilot.proxy.start  - Start the proxy server
 *    github.copilot.proxy.stop   - Stop the proxy server
 *
 *  Configuration:
 *    github.copilot.chat.proxyServer.enabled - Auto-start the proxy on activation
 *    github.copilot.chat.proxyServer.port    - Port to listen on (default: 18080)
 *--------------------------------------------------------------------------------------------*/

import { commands, window, workspace } from 'vscode';
import { ILogService } from '../../../platform/log/common/logService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IExtensionContribution } from '../../common/contributions';
import { IProxyServerService } from '../common/proxyServerService';

const PROXY_ENABLED_KEY = 'github.copilot.chat.proxyServer.enabled';
const PROXY_PORT_KEY = 'github.copilot.chat.proxyServer.port';

export class ProxyServerContribution extends Disposable implements IExtensionContribution {
	public readonly id = 'proxy.server';

	constructor(
		@IProxyServerService private readonly _proxyServerService: IProxyServerService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();

		// Register start command
		this._register(commands.registerCommand('github.copilot.proxy.start', async () => {
			try {
				if (this._proxyServerService.isRunning) {
					window.showInformationMessage(`Copilot Proxy is already running on port ${this._proxyServerService.port}`);
					return;
				}
				const port = this._getPort();
				await this._proxyServerService.start(port);
				window.showInformationMessage(
					`Copilot Proxy started on http://localhost:${port}\n` +
					`Use with OpenAI SDK: base_url="http://localhost:${port}/v1"\n` +
					`Use with Anthropic SDK: base_url="http://localhost:${port}"`
				);
			} catch (e: any) {
				window.showErrorMessage(`Failed to start Copilot Proxy: ${e.message}`);
			}
		}));

		// Register stop command
		this._register(commands.registerCommand('github.copilot.proxy.stop', async () => {
			if (!this._proxyServerService.isRunning) {
				window.showInformationMessage('Copilot Proxy is not running');
				return;
			}
			await this._proxyServerService.stop();
			window.showInformationMessage('Copilot Proxy stopped');
		}));

		// Auto-start if configured
		this._autoStart();
	}

	private _getPort(): number {
		const config = workspace.getConfiguration();
		const portConfig = config.get<number>(PROXY_PORT_KEY);
		if (typeof portConfig === 'number' && portConfig > 0) {
			return portConfig;
		}
		return 18080;
	}

	private async _autoStart(): Promise<void> {
		try {
			const config = workspace.getConfiguration();
			const enabled = config.get<boolean>(PROXY_ENABLED_KEY, false);
			if (enabled) {
				const port = this._getPort();
				this._logService.info(`[ProxyServer] Auto-starting on port ${port} (enabled via settings)`);
				await this._proxyServerService.start(port);
			}
		} catch (e: any) {
			this._logService.error('[ProxyServer] Auto-start failed:', e);
		}
	}

	override dispose(): void {
		this._proxyServerService.stop().catch(() => { /* ignore */ });
		super.dispose();
	}
}
