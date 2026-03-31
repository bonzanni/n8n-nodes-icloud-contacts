import {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	NodeOperationError,
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

		// Build Basic auth header manually so it survives iCloud's redirects
		const credentials = await this.getCredentials('httpBasicAuth');
		const user = credentials.user as string;
		const password = credentials.password as string;
		const authHeader = 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');

		const davRequest = async (method: string, url: string, body: string, depth: string): Promise<string> => {
			const response = await this.helpers.httpRequest({
				method: method as any,
				url,
				headers: {
					Authorization: authHeader,
					Depth: depth,
					'Content-Type': 'application/xml; charset=utf-8',
				},
				body,
				returnFullResponse: true,
				ignoreHttpStatusErrors: true,
			});

			const statusCode = response?.statusCode ?? response?.status;
			const responseBody: string = typeof response === 'string'
				? response
				: typeof response?.body === 'string'
					? response.body
					: JSON.stringify(response);

			if (statusCode === 401 || statusCode === 403) {
				throw new NodeOperationError(
					this.getNode(),
					`iCloud authentication failed (HTTP ${statusCode}). Check your Apple ID and app-specific password.`,
				);
			}

			return responseBody;
		};

		// --- Step 1: PROPFIND / on contacts.icloud.com to get principal path ---
		const step1Body = await davRequest(
			'PROPFIND',
			'https://contacts.icloud.com/',
			'<?xml version="1.0" encoding="UTF-8"?>' +
			'<d:propfind xmlns:d="DAV:">' +
			'<d:prop><d:current-user-principal/></d:prop>' +
			'</d:propfind>',
			'0',
		);

		const principalPath = step1Body.match(
			/<[^>]*current-user-principal[\s\S]*?<[^>]*href>([^<]+)<\/[^>]*href>/i,
		)?.[1];

		if (!principalPath) {
			throw new NodeOperationError(
				this.getNode(),
				`Could not find current-user-principal. Response (first 500 chars): ${step1Body.substring(0, 500)}`,
			);
		}

		// --- Step 2: PROPFIND principal path to get addressbook-home-set ---
		const step2Body = await davRequest(
			'PROPFIND',
			`https://contacts.icloud.com${principalPath}`,
			'<?xml version="1.0" encoding="UTF-8"?>' +
			'<d:propfind xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">' +
			'<d:prop><card:addressbook-home-set/></d:prop>' +
			'</d:propfind>',
			'0',
		);

		let addressbookHome = step2Body.match(
			/<[^>]*addressbook-home-set[\s\S]*?<[^>]*href>([^<]+)<\/[^>]*href>/i,
		)?.[1];

		if (!addressbookHome) {
			throw new NodeOperationError(
				this.getNode(),
				`Could not find addressbook-home-set. Response (first 500 chars): ${step2Body.substring(0, 500)}`,
			);
		}

		// If relative path, prepend host
		if (!addressbookHome.startsWith('http')) {
			addressbookHome = `https://contacts.icloud.com${addressbookHome}`;
		}
		if (!addressbookHome.endsWith('/')) {
			addressbookHome += '/';
		}

		// --- Step 3: REPORT on {home}card/ to get all vCards ---
		const cardCollectionUrl = `${addressbookHome}card/`;

		const step3Body = await davRequest(
			'REPORT',
			cardCollectionUrl,
			'<?xml version="1.0" encoding="UTF-8"?>' +
			'<card:addressbook-query xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">' +
			'<d:prop><d:getetag/><card:address-data/></d:prop>' +
			'</card:addressbook-query>',
			'1',
		);

		// Extract all vCards from <card:address-data> or <address-data> elements
		const vcardPattern = /<(?:card:)?address-data[^>]*>([\s\S]*?)<\/(?:card:)?address-data>/gi;
		let vcardMatch: RegExpExecArray | null;

		while ((vcardMatch = vcardPattern.exec(step3Body)) !== null) {
			let vcard = vcardMatch[1];

			// Clean up: strip &#13; and XML-decode entities
			vcard = vcard
				.replace(/&#13;/g, '')
				.replace(/&amp;/g, '&')
				.replace(/&lt;/g, '<')
				.replace(/&gt;/g, '>')
				.replace(/&apos;/g, "'")
				.replace(/&quot;/g, '"')
				.trim();

			if (!vcard.startsWith('BEGIN:VCARD')) continue;

			const uidMatch = vcard.match(/^UID[;:](.+)$/m);
			const uid = uidMatch ? uidMatch[1].trim() : '';
			const isGroup = /X-ADDRESSBOOKSERVER-KIND:\s*group/i.test(vcard);

			const item: Record<string, any> = { raw: vcard, uid, isGroup };

			if (isGroup) {
				const fnMatch = vcard.match(/^FN[;:](.+)$/m);
				item.groupName = fnMatch ? fnMatch[1].trim() : '';

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
