import { Readable } from 'stream';
import { request as httpRequest } from 'http';
import { request as httpsRequest } from 'https';
import { HttpsProxyAgent } from 'https-proxy-agent';

export enum ExtensionQueryFilterType {
	Name = 7,
	InstallationTarget = 8,
	SearchText = 10,
	ExcludeWithFlags = 12,
}

export enum ExtensionQueryFlags {
	None = 0,
	IncludeVersions = 1,
	IncludeCategoryAndTags = 4,
	IncludeVersionProperties = 16,
	ExcludeNonValidated = 32,
	IncludeStatistics = 256,
	IncludeLatestVersionOnly = 512,
	IncludeMetadata = 2048,
}

export interface FilterCriteria {
	filterType?: ExtensionQueryFilterType;
	value?: string;
}

export interface ExtensionStatistic {
	statisticName?: string;
	value?: number;
}

export interface ExtensionVersion {
	lastUpdated?: Date;
	properties?: { key: string; value: string }[];
	targetPlatform?: string;
	version?: string;
}

export interface PublishedExtension {
	categories?: string[];
	displayName?: string;
	extensionName?: string;
	lastUpdated?: Date;
	publishedDate?: Date;
	publisher?: {
		displayName?: string;
		publisherName?: string;
	};
	shortDescription?: string;
	statistics?: ExtensionStatistic[];
	tags?: string[];
	versions?: ExtensionVersion[];
}

export class MarketplaceError extends Error {
	constructor(message: string, readonly statusCode: number) {
		super(message);
	}
}

type Requester = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class MarketplaceAPI {
	constructor(
		private readonly baseUrl: string,
		private readonly pat: string,
		private readonly request: Requester = requestMarketplace
	) {}

	getExtension(publisherName: string, extensionName: string, flags: ExtensionQueryFlags): Promise<PublishedExtension> {
		return this.requestJSON(
			'GET',
			`/_apis/gallery/publishers/${encodeURIComponent(publisherName)}/extensions/${encodeURIComponent(extensionName)}`,
			undefined,
			{ flags, 'api-version': '7.2-preview.2' }
		);
	}

	createExtension(contentStream: Readable): Promise<PublishedExtension> {
		return this.requestJSON('POST', '/_apis/gallery/extensions', contentStream, {
			'api-version': '7.2-preview.2'
		}, 'application/octet-stream');
	}

	updateExtension(
		contentStream: Readable,
		publisherName: string,
		extensionName: string
	): Promise<PublishedExtension> {
		return this.requestJSON(
			'PUT',
			`/_apis/gallery/publishers/${encodeURIComponent(publisherName)}/extensions/${encodeURIComponent(extensionName)}`,
			contentStream,
			{ 'api-version': '7.2-preview.2' },
			'application/octet-stream'
		);
	}

	deleteExtension(publisherName: string, extensionName: string): Promise<void> {
		return this.requestJSON(
			'DELETE',
			`/_apis/gallery/publishers/${encodeURIComponent(publisherName)}/extensions/${encodeURIComponent(extensionName)}`,
			undefined,
			{ 'api-version': '7.2-preview.2' }
		);
	}

	deletePublisher(publisherName: string): Promise<void> {
		return this.requestJSON(
			'DELETE',
			`/_apis/gallery/publishers/${encodeURIComponent(publisherName)}`,
			undefined,
			{ 'api-version': '7.2-preview.1' }
		);
	}

	getRoleAssignments(scopeId: string, resourceId: string): Promise<unknown> {
		return this.requestJSON(
			'GET',
			`/_apis/securityroles/scopes/${encodeURIComponent(scopeId)}/roleassignments/resources/${encodeURIComponent(resourceId)}`,
			undefined,
			{ 'api-version': '3.2-preview.1' }
		);
	}

	publishExtensionWithPublisherSignature(
		packageName: string,
		packageStream: Readable,
		sigzipName: string,
		sigzipStream: Readable,
		publisherName: string,
		extensionName: string
	): Promise<PublishedExtension> {
		const boundary = '0f411892-ef48-488f-89d3-4f0546e84723';
		const body = Readable.from(createMultipartBody(boundary, [
			{ name: 'vsix', fileName: packageName, stream: packageStream },
			{ name: 'sigzip', fileName: sigzipName, stream: sigzipStream },
		]));

		return this.requestJSON(
			'PUT',
			`/_apis/gallery/publishers/${encodeURIComponent(publisherName)}/publishersignedextension/${encodeURIComponent(extensionName)}`,
			body,
			{
				extensionType: 'Visual Studio Code',
				'api-version': '7.2-preview.1',
				reCaptchaToken: '',
			},
			`multipart/related; boundary=${boundary}`
		);
	}

	private async requestJSON<T>(
		method: string,
		path: string,
		body?: Readable,
		query: Record<string, string | number> = {},
		contentType?: string
	): Promise<T> {
		const url = new URL(path, `${this.baseUrl.replace(/\/$/, '')}/`);
		for (const [key, value] of Object.entries(query)) {
			url.searchParams.set(key, String(value));
		}

		const init: RequestInit & { duplex?: 'half' } = {
			method,
			headers: {
				Accept: `application/json;api-version=${query['api-version']}`,
				Authorization: `Basic ${Buffer.from(`OAuth:${this.pat}`).toString('base64')}`,
				...(contentType ? { 'Content-Type': contentType } : {}),
			},
		};
		if (body) {
			init.body = Readable.toWeb(toByteStream(body)) as ReadableStream;
			init.duplex = 'half';
		}

		const response = await this.request(url, init);
		const text = await response.text();
		if (!response.ok) {
			throw new MarketplaceError(getErrorMessage(response, text), response.status);
		}
		if (!text) {
			return undefined as T;
		}
		return revivePublishedExtensionDates(JSON.parse(text));
	}
}

async function* createMultipartBody(
	boundary: string,
	parts: { name: string; fileName: string; stream: Readable }[]
): AsyncGenerator<Buffer | Uint8Array> {
	for (const part of parts) {
		yield Buffer.from(`--${boundary}\r\nContent-Disposition: attachment; name=${part.name}; filename="${part.fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
		for await (const chunk of part.stream) {
			yield typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
		}
		yield Buffer.from('\r\n');
	}
	yield Buffer.from(`--${boundary}--\r\n`);
}

function toByteStream(stream: Readable): Readable {
	return Readable.from(async function* () {
		for await (const chunk of stream) {
			yield typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
		}
	}());
}

export async function requestMarketplace(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
	const url = new URL(input instanceof Request ? input.url : input);
	const proxy = getProxy(url);
	const agent = proxy ? new HttpsProxyAgent(proxy) : undefined;
	const headers = Object.fromEntries(new Headers(init.headers));
	const body = typeof init.body === 'string'
		? Readable.from(Buffer.from(init.body))
		: init.body instanceof ReadableStream
			? Readable.fromWeb(init.body as ReadableStream<Uint8Array>)
			: undefined;

	return new Promise((resolve, reject) => {
		const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
		const outgoing = send(url, {
			method: init.method,
			headers,
			agent,
		}, incoming => {
			const chunks: Buffer[] = [];
			incoming.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
			incoming.once('error', reject);
			incoming.once('end', () => {
				const status = incoming.statusCode ?? 500;
				const responseBody = status === 204 || status === 304 ? null : Buffer.concat(chunks);
				const responseHeaders = new Headers();
				for (const [name, value] of Object.entries(incoming.headers)) {
					if (Array.isArray(value)) {
						value.forEach(item => responseHeaders.append(name, item));
					} else if (value !== undefined) {
						responseHeaders.set(name, value);
					}
				}
				resolve(new Response(responseBody, {
					status,
					statusText: incoming.statusMessage,
					headers: responseHeaders,
				}));
			});
		});
		outgoing.once('error', reject);
		if (body) {
			body.once('error', reject);
			body.pipe(outgoing);
		} else {
			outgoing.end();
		}
	});
}

function getProxy(url: URL): string | undefined {
	if (isProxyBypassed(url)) {
		return undefined;
	}
	if (url.protocol === 'https:') {
		return process.env['HTTPS_PROXY'] ?? process.env['https_proxy'] ??
			process.env['HTTP_PROXY'] ?? process.env['http_proxy'];
	}
	return process.env['HTTP_PROXY'] ?? process.env['http_proxy'];
}

function isProxyBypassed(url: URL): boolean {
	const noProxy = process.env['NO_PROXY'] ?? process.env['no_proxy'];
	if (!noProxy) {
		return false;
	}

	return noProxy.split(',').some(value => {
		const entry = value.trim().toLowerCase();
		if (!entry) {
			return false;
		}
		if (entry === '*') {
			return true;
		}

		const [host, port] = entry.split(':');
		const hostname = url.hostname.toLowerCase();
		const urlPort = url.port || (url.protocol === 'https:' ? '443' : '80');
		const hostMatches = host.startsWith('.')
			? hostname === host.slice(1) || hostname.endsWith(host)
			: hostname === host || hostname.endsWith(`.${host}`);
		return hostMatches && (!port || port === urlPort);
	});
}

function getErrorMessage(response: Response, body: string): string {
	if (body) {
		try {
			const parsed = JSON.parse(body);
			if (typeof parsed.message === 'string') {
				return parsed.message;
			}
		} catch {
			return body;
		}
		return body;
	}
	return response.statusText || `Marketplace request failed with status ${response.status}`;
}

export function revivePublishedExtensionDates<T>(value: T): T {
	if (!value || typeof value !== 'object') {
		return value;
	}

	const record = value as Record<string, unknown>;
	for (const key of ['lastUpdated', 'publishedDate', 'releaseDate']) {
		if (typeof record[key] === 'string') {
			record[key] = new Date(record[key]);
		}
	}
	for (const child of Object.values(record)) {
		if (Array.isArray(child)) {
			child.forEach(revivePublishedExtensionDates);
		} else if (child && typeof child === 'object') {
			revivePublishedExtensionDates(child);
		}
	}
	return value;
}
