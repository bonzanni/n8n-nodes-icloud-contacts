import {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	NodeOperationError,
	IHttpRequestOptions,
} from 'n8n-workflow';

export class ICloudContacts implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'iCloud Contacts',
		name: 'iCloudContacts',
		icon: 'file:iCloudContacts.svg',
		group: ['transform'],
		version: 1,
		subtitle: 'Get All Contacts',
		description: 'Fetch all contacts from an iCloud account via CardDAV',
		defaults: {
			name: 'iCloud Contacts',
		},
		inputs: ['main'],
		outputs: ['main'],
		credentials: [
			{
				name: 'httpBasicAuth',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Get All',
						value: 'getAll',
						description: 'Fetch all contacts from iCloud',
						action: 'Fetch all contacts from iCloud',
					},
				],
				default: 'getAll',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const returnData: INodeExecutionData[] = [];

		// --- Step 1: PROPFIND / on contacts.icloud.com to get principal path ---
		const propfindPrincipalBody =
			'<?xml version="1.0" encoding="UTF-8"?>' +
			'<d:propfind xmlns:d="DAV:">' +
			'<d:prop><d:current-user-principal/></d:prop>' +
			'</d:propfind>';

		const step1Options: IHttpRequestOptions = {
			method: 'PROPFIND' as any,
			url: 'https://contacts.icloud.com/',
			headers: {
				Depth: '0',
				'Content-Type': 'application/xml; charset=utf-8',
			},
			body: propfindPrincipalBody,
			returnFullResponse: true,
			ignoreHttpStatusErrors: true,
		};

		let step1Response: any;
		try {
			step1Response = await this.helpers.httpRequestWithAuthentication.call(
				this,
				'httpBasicAuth',
				step1Options,
			);
		} catch (error: any) {
			throw new NodeOperationError(
				this.getNode(),
				`Failed to connect to iCloud: ${error.message}`,
			);
		}

		const step1Body: string = typeof step1Response === 'string'
			? step1Response
			: (step1Response.body ?? step1Response);

		// Extract principal path from <d:href> inside <d:current-user-principal>
		const principalMatch = step1Body.match(
			/<d:current-user-principal[\s\S]*?<d:href>([^<]+)<\/d:href>/i,
		);
		// Also try without namespace prefix (some responses use <D:href> or <href>)
		const principalPath = principalMatch?.[1]
			?? step1Body.match(/<current-user-principal[\s\S]*?<href>([^<]+)<\/href>/i)?.[1]
			?? step1Body.match(/<D:current-user-principal[\s\S]*?<D:href>([^<]+)<\/D:href>/i)?.[1];

		if (!principalPath) {
			throw new NodeOperationError(
				this.getNode(),
				'Could not find current-user-principal in iCloud response. Check your credentials (Apple ID + app-specific password).',
			);
		}

		// --- Step 2: PROPFIND principal path to get addressbook-home-set ---
		const propfindHomeBody =
			'<?xml version="1.0" encoding="UTF-8"?>' +
			'<d:propfind xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">' +
			'<d:prop><card:addressbook-home-set/></d:prop>' +
			'</d:propfind>';

		const step2Options: IHttpRequestOptions = {
			method: 'PROPFIND' as any,
			url: `https://contacts.icloud.com${principalPath}`,
			headers: {
				Depth: '0',
				'Content-Type': 'application/xml; charset=utf-8',
			},
			body: propfindHomeBody,
			returnFullResponse: true,
			ignoreHttpStatusErrors: true,
		};

		let step2Response: any;
		try {
			step2Response = await this.helpers.httpRequestWithAuthentication.call(
				this,
				'httpBasicAuth',
				step2Options,
			);
		} catch (error: any) {
			throw new NodeOperationError(
				this.getNode(),
				`Failed to get addressbook-home-set: ${error.message}`,
			);
		}

		const step2Body: string = typeof step2Response === 'string'
			? step2Response
			: (step2Response.body ?? step2Response);

		// addressbook-home-set contains a full URL on a potentially different host
		const homeMatch = step2Body.match(
			/<(?:card:)?addressbook-home-set[\s\S]*?<d:href>([^<]+)<\/d:href>/i,
		) ?? step2Body.match(
			/<(?:C:)?addressbook-home-set[\s\S]*?<(?:D:)?href>([^<]+)<\/(?:D:)?href>/i,
		);

		let addressbookHome = homeMatch?.[1];
		if (!addressbookHome) {
			throw new NodeOperationError(
				this.getNode(),
				'Could not find addressbook-home-set in iCloud response.',
			);
		}

		// If it's a full URL, use as-is. If relative, prepend host.
		if (!addressbookHome.startsWith('http')) {
			addressbookHome = `https://contacts.icloud.com${addressbookHome}`;
		}

		// Ensure trailing slash
		if (!addressbookHome.endsWith('/')) {
			addressbookHome += '/';
		}

		// Address book collection is at {home}card/
		const cardCollectionUrl = `${addressbookHome}card/`;

		// --- Step 3: REPORT on card collection to get all vCards ---
		const reportBody =
			'<?xml version="1.0" encoding="UTF-8"?>' +
			'<card:addressbook-query xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">' +
			'<d:prop><d:getetag/><card:address-data/></d:prop>' +
			'</card:addressbook-query>';

		const step3Options: IHttpRequestOptions = {
			method: 'REPORT' as any,
			url: cardCollectionUrl,
			headers: {
				Depth: '1',
				'Content-Type': 'application/xml; charset=utf-8',
			},
			body: reportBody,
			returnFullResponse: true,
			ignoreHttpStatusErrors: true,
		};

		let step3Response: any;
		try {
			step3Response = await this.helpers.httpRequestWithAuthentication.call(
				this,
				'httpBasicAuth',
				step3Options,
			);
		} catch (error: any) {
			throw new NodeOperationError(
				this.getNode(),
				`Failed to fetch contacts: ${error.message}`,
			);
		}

		const step3Body: string = typeof step3Response === 'string'
			? step3Response
			: (step3Response.body ?? step3Response);

		// Extract all vCards from <card:address-data> or <address-data> elements
		const vcardPattern = /<(?:card:)?address-data[^>]*>([\s\S]*?)<\/(?:card:)?address-data>/gi;
		let vcardMatch: RegExpExecArray | null;

		while ((vcardMatch = vcardPattern.exec(step3Body)) !== null) {
			let vcard = vcardMatch[1];

			// Clean up: strip &#13; (carriage returns encoded as XML entities)
			vcard = vcard.replace(/&#13;/g, '');

			// XML-decode common entities
			vcard = vcard
				.replace(/&amp;/g, '&')
				.replace(/&lt;/g, '<')
				.replace(/&gt;/g, '>')
				.replace(/&apos;/g, "'")
				.replace(/&quot;/g, '"');

			// Trim whitespace
			vcard = vcard.trim();

			if (!vcard.startsWith('BEGIN:VCARD')) {
				continue;
			}

			// Extract UID
			const uidMatch = vcard.match(/^UID[;:](.+)$/m);
			const uid = uidMatch ? uidMatch[1].trim() : '';

			// Check if this is a group
			const isGroup = /X-ADDRESSBOOKSERVER-KIND:\s*group/i.test(vcard);

			const item: Record<string, any> = {
				raw: vcard,
				uid,
				isGroup,
			};

			if (isGroup) {
				// Extract group name from FN
				const fnMatch = vcard.match(/^FN[;:](.+)$/m);
				item.groupName = fnMatch ? fnMatch[1].trim() : '';

				// Extract member UIDs from X-ADDRESSBOOKSERVER-MEMBER lines
				const memberPattern = /X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:([^\s\r\n]+)/gi;
				const memberUids: string[] = [];
				let memberMatch: RegExpExecArray | null;
				while ((memberMatch = memberPattern.exec(vcard)) !== null) {
					memberUids.push(memberMatch[1].trim());
				}
				item.memberUids = memberUids;
			}

			returnData.push({ json: item });
		}

		return [returnData];
	}
}
