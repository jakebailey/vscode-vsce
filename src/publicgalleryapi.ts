import {
	PublishedExtension,
	ExtensionQueryFlags,
	FilterCriteria,
	ExtensionQueryFilterType,
	requestMarketplace,
	revivePublishedExtensionDates,
} from './marketplace';

export interface ExtensionQuery {
	readonly pageNumber?: number;
	readonly pageSize?: number;
	readonly flags?: ExtensionQueryFlags[];
	readonly criteria?: FilterCriteria[];
	readonly assetTypes?: string[];
}

interface VSCodePublishedExtension extends PublishedExtension {
	publisher: { displayName: string; publisherName: string };
}

export class PublicGalleryAPI {
	constructor(
		private baseUrl: string,
		private apiVersion = '3.0-preview.1',
		private request: typeof fetch = requestMarketplace
	) {}

	async extensionQuery({
		pageNumber = 1,
		pageSize = 1,
		flags = [],
		criteria = [],
		assetTypes = [],
	}: ExtensionQuery): Promise<VSCodePublishedExtension[]> {
		const data = JSON.stringify({
			filters: [{ pageNumber, pageSize, criteria }],
			assetTypes,
			flags: flags.reduce((memo, flag) => memo | flag, 0),
		});

		const res = await this.request(`${this.baseUrl.replace(/\/$/, '')}/_apis/public/gallery/extensionquery`, {
			method: 'POST',
			body: data,
			headers: {
				Accept: `application/json;api-version=${this.apiVersion}`,
				'Content-Type': 'application/json',
			},
		});
		const text = await res.text();
		let raw;
		try {
			raw = JSON.parse(text);
		} catch (error) {
			if (!res.ok) {
				throw new Error(text || res.statusText);
			}
			throw error;
		}

		if (raw.errorCode !== undefined) {
			throw new Error(raw.message);
		}
		if (!res.ok) {
			throw new Error(raw.message || text || res.statusText);
		}

		return revivePublishedExtensionDates(raw.results[0].extensions);
	}

	async getExtension(extensionId: string, flags: ExtensionQueryFlags[] = []): Promise<PublishedExtension> {
		const query = { criteria: [{ filterType: ExtensionQueryFilterType.Name, value: extensionId }], flags };
		const extensions = await this.extensionQuery(query);
		return extensions.filter(
			({ publisher: { publisherName: publisher }, extensionName: name }) =>
				extensionId.toLowerCase() === `${publisher}.${name}`.toLowerCase()
		)[0];
	}
}
