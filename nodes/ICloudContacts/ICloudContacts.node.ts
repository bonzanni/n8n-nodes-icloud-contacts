import {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	NodeOperationError,
} from 'n8n-workflow';

const PROPFIND_PRINCIPAL =
	'<?xml version="1.0" encoding="UTF-8"?>' +
	'<d:propfind xmlns:d="DAV:">' +
	'<d:prop><d:current-user-principal/></d:prop>' +
	'</d:propfind>';

const PROPFIND_HOME =
	'<?xml version="1.0" encoding="UTF-8"?>' +
	'<d:propfind xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">' +
	'<d:prop><card:addressbook-home-set/></d:prop>' +
	'</d:propfind>';

const REPORT_CONTACTS =
	'<?xml version="1.0" encoding="UTF-8"?>' +
	'<card:addressbook-query xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">' +
	'<d:prop><d:getetag/><card:address-data/></d:prop>' +
	'</card:addressbook-query>';

/** Extract text content from an XML element, handling any namespace prefix and attributes. */
function extractHref(xml: string, parentTag: string): string | undefined {
	const re = new RegExp(
		`<[^>]*${parentTag}[^>]*>[\\s\\S]*?<[^>]*href[^>]*>([^<]+)<\\/[^>]*href>`,
		'i',
	);
	return re.exec(xml)?.[1];
}

function decodeVCard(raw: string): string {
	return raw
		.replace(/&#13;/g, '')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&apos;/g, "'")
		.replace(/&quot;/g, '"')
		.trim();
}

export class ICloudContacts implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'iCloud Contacts',
		name: 'iCloudContacts',
		icon: 'fa:address-book',
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

		// Build auth header manually — httpRequestWithAuthentication strips auth
		// on iCloud's cross-host redirects (e.g. contacts → p158-contacts).
		const credentials = await this.getCredentials('httpBasicAuth');
		const authHeader = 'Basic ' + Buffer.from(
			`${credentials.user}:${credentials.password}`,
		).toString('base64');

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
			});
			return typeof response === 'string' ? response : JSON.stringify(response);
		};

		// Step 1: Discover principal path
		let step1: string;
		try {
			step1 = await davRequest('PROPFIND', 'https://contacts.icloud.com/', PROPFIND_PRINCIPAL, '0');
		} catch (error: any) {
			throw new NodeOperationError(this.getNode(),
				`iCloud authentication failed: ${error.message}. Check your Apple ID and app-specific password.`);
		}

		const principalPath = extractHref(step1, 'current-user-principal');
		if (!principalPath) {
			throw new NodeOperationError(this.getNode(),
				`Could not discover principal. Response: ${step1.substring(0, 500)}`);
		}

		// Step 2: Discover addressbook home (may be on a different host)
		const step2 = await davRequest(
			'PROPFIND', `https://contacts.icloud.com${principalPath}`, PROPFIND_HOME, '0',
		);

		let home = extractHref(step2, 'addressbook-home-set');
		if (!home) {
			throw new NodeOperationError(this.getNode(),
				`Could not discover addressbook home. Response: ${step2.substring(0, 500)}`);
		}
		if (!home.startsWith('http')) home = `https://contacts.icloud.com${home}`;
		if (!home.endsWith('/')) home += '/';

		// Step 3: Fetch all vCards from the card collection
		const step3 = await davRequest('REPORT', `${home}card/`, REPORT_CONTACTS, '1');

		const vcardPattern = /<[^>]*address-data[^>]*>([\s\S]*?)<\/[^>]*address-data>/gi;
		let match: RegExpExecArray | null;

		while ((match = vcardPattern.exec(step3)) !== null) {
			const vcard = decodeVCard(match[1]);
			if (!vcard.startsWith('BEGIN:VCARD')) continue;

			const uid = vcard.match(/^UID[;:](.+)$/m)?.[1]?.trim() ?? '';
			const isGroup = /X-ADDRESSBOOKSERVER-KIND:\s*group/i.test(vcard);

			const item: Record<string, any> = { raw: vcard, uid, isGroup };

			if (isGroup) {
				item.groupName = vcard.match(/^FN[;:](.+)$/m)?.[1]?.trim() ?? '';
				const members: string[] = [];
				const memberRe = /X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:([^\s\r\n]+)/gi;
				let m: RegExpExecArray | null;
				while ((m = memberRe.exec(vcard)) !== null) members.push(m[1].trim());
				item.memberUids = members;
			}

			returnData.push({ json: item });
		}

		return [returnData];
	}
}
