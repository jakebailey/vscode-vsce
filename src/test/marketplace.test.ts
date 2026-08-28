import * as assert from 'assert';
import { createServer } from 'http';
import { AddressInfo } from 'net';
import { Readable } from 'stream';
import {
	ExtensionQueryFilterType,
	ExtensionQueryFlags,
	MarketplaceAPI,
	MarketplaceError,
	requestMarketplace,
} from '../marketplace';
import { PublicGalleryAPI } from '../publicgalleryapi';

interface RecordedRequest {
	url: URL;
	init: RequestInit;
	body: string;
}

function createRequester(responses: Response[]) {
	const requests: RecordedRequest[] = [];
	const requester = async (input: string | URL | Request, init: RequestInit = {}) => {
		requests.push({
			url: new URL(input instanceof Request ? input.url : input),
			init,
			body: init.body ? await new Response(init.body).text() : '',
		});
		const response = responses.shift();
		assert.ok(response, 'Unexpected Marketplace request');
		return response;
	};
	return { requester, requests };
}

describe('MarketplaceAPI', () => {
	it('sends request bodies with the default Node client', async () => {
		const server = createServer((request, response) => {
			let body = '';
			request.setEncoding('utf8');
			request.on('data', chunk => body += chunk);
			request.on('end', () => {
				response.end(body);
			});
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		const { port } = server.address() as AddressInfo;
		const originalNoProxy = process.env['NO_PROXY'];
		process.env['NO_PROXY'] = '127.0.0.1';

		try {
			const response = await requestMarketplace(`http://127.0.0.1:${port}`, {
				method: 'POST',
				body: 'request body',
			});
			assert.strictEqual(await response.text(), 'request body');
		} finally {
			originalNoProxy === undefined
				? delete process.env['NO_PROXY']
				: process.env['NO_PROXY'] = originalNoProxy;
			await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
		}
	});

	it('gets extensions with authentication and revives dates', async () => {
		const { requester, requests } = createRequester([
			Response.json({
				extensionName: 'extension',
				lastUpdated: '2024-01-02T03:04:05Z',
				versions: [{ version: '1.0.0', lastUpdated: '2024-01-01T00:00:00Z' }],
			}),
		]);
		const api = new MarketplaceAPI('https://marketplace.example', 'token', requester);

		const extension = await api.getExtension('publisher', 'extension', ExtensionQueryFlags.IncludeVersions);

		assert.strictEqual(requests[0].url.toString(), 'https://marketplace.example/_apis/gallery/publishers/publisher/extensions/extension?flags=1&api-version=7.2-preview.2');
		assert.strictEqual(requests[0].init.method, 'GET');
		assert.strictEqual(new Headers(requests[0].init.headers).get('authorization'), 'Basic T0F1dGg6dG9rZW4=');
		assert.ok(extension.lastUpdated instanceof Date);
		assert.ok(extension.versions![0].lastUpdated instanceof Date);
	});

	it('uses the Marketplace routes for publishing and account management', async () => {
		const { requester, requests } = createRequester([
			Response.json({}),
			Response.json({}),
			new Response(null, { status: 204 }),
			new Response(null, { status: 204 }),
			Response.json([]),
		]);
		const api = new MarketplaceAPI('https://marketplace.example/', 'token', requester);

		await api.createExtension(Readable.from('create'));
		await api.updateExtension(Readable.from('update'), 'publisher', 'extension');
		await api.deleteExtension('publisher', 'extension');
		await api.deletePublisher('publisher');
		await api.getRoleAssignments('gallery.publisher', 'publisher');

		assert.deepStrictEqual(
			requests.map(({ url, init, body }) => [init.method, url.pathname, url.search, body]),
			[
				['POST', '/_apis/gallery/extensions', '?api-version=7.2-preview.2', 'create'],
				['PUT', '/_apis/gallery/publishers/publisher/extensions/extension', '?api-version=7.2-preview.2', 'update'],
				['DELETE', '/_apis/gallery/publishers/publisher/extensions/extension', '?api-version=7.2-preview.2', ''],
				['DELETE', '/_apis/gallery/publishers/publisher', '?api-version=7.2-preview.1', ''],
				['GET', '/_apis/securityroles/scopes/gallery.publisher/roleassignments/resources/publisher', '?api-version=3.2-preview.1', ''],
			]
		);
	});

	it('streams publisher-signed multipart packages', async () => {
		const { requester, requests } = createRequester([Response.json({})]);
		const api = new MarketplaceAPI('https://marketplace.example', 'token', requester);

		await api.publishExtensionWithPublisherSignature(
			'extension.vsix',
			Readable.from('VSIX'),
			'extension.sigzip',
			Readable.from('SIGZIP'),
			'publisher',
			'extension'
		);

		const boundary = '0f411892-ef48-488f-89d3-4f0546e84723';
		assert.strictEqual(
			requests[0].url.toString(),
			'https://marketplace.example/_apis/gallery/publishers/publisher/publishersignedextension/extension?extensionType=Visual+Studio+Code&api-version=7.2-preview.1&reCaptchaToken='
		);
		assert.strictEqual(new Headers(requests[0].init.headers).get('content-type'), `multipart/related; boundary=${boundary}`);
		assert.strictEqual(
			requests[0].body,
			`--${boundary}\r\nContent-Disposition: attachment; name=vsix; filename="extension.vsix"\r\nContent-Type: application/octet-stream\r\n\r\nVSIX\r\n` +
			`--${boundary}\r\nContent-Disposition: attachment; name=sigzip; filename="extension.sigzip"\r\nContent-Type: application/octet-stream\r\n\r\nSIGZIP\r\n` +
			`--${boundary}--\r\n`
		);
	});

	it('preserves response status and Marketplace error messages', async () => {
		const { requester } = createRequester([
			Response.json({ message: 'Version already exists' }, { status: 409 }),
		]);
		const api = new MarketplaceAPI('https://marketplace.example', 'token', requester);

		await assert.rejects(
			() => api.createExtension(Readable.from('package')),
			(error: MarketplaceError) => error.statusCode === 409 && error.message === 'Version already exists'
		);
	});
});

describe('PublicGalleryAPI', () => {
	it('queries extensions and revives response dates', async () => {
		const { requester, requests } = createRequester([
			Response.json({
				results: [{
					extensions: [{
						extensionName: 'extension',
						publisher: { publisherName: 'publisher' },
						publishedDate: '2024-01-01T00:00:00Z',
					}],
				}],
			}),
		]);
		const api = new PublicGalleryAPI('https://marketplace.example', '3.0-preview.1', requester);

		const extensions = await api.extensionQuery({
			pageSize: 10,
			criteria: [{ filterType: ExtensionQueryFilterType.SearchText, value: 'search' }],
			flags: [ExtensionQueryFlags.IncludeVersions, ExtensionQueryFlags.IncludeStatistics],
		});

		assert.deepStrictEqual(JSON.parse(requests[0].body), {
			filters: [{
				pageNumber: 1,
				pageSize: 10,
				criteria: [{ filterType: 10, value: 'search' }],
			}],
			assetTypes: [],
			flags: 257,
		});
		assert.ok(extensions[0].publishedDate instanceof Date);
	});
});
