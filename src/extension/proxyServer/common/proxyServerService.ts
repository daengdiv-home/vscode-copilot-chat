/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createServiceIdentifier } from '../../../util/common/services';
import { Event } from '../../../util/vs/base/common/event';

export const IProxyServerService = createServiceIdentifier<IProxyServerService>('IProxyServerService');

export interface IProxyServerService {
	readonly _serviceBrand: undefined;

	/** Whether the server is currently running */
	readonly isRunning: boolean;

	/** The port the server is listening on, or undefined if not running */
	readonly port: number | undefined;

	/** Fired when the server starts or stops */
	readonly onDidChangeState: Event<boolean>;

	/** Start the proxy server on the given port (or default from config) */
	start(port?: number): Promise<void>;

	/** Stop the proxy server */
	stop(): Promise<void>;

	/**
	 * Build CAPI headers using real VS Code services.
	 * Returns the full set of headers that the real extension would send.
	 */
	buildCapiHeaders(requestId: string, options?: {
		intent?: string;
		interactionType?: string;
		userInitiated?: boolean;
		hasVision?: boolean;
	}): Promise<Record<string, string>>;
}
