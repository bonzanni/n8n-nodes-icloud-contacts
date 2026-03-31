"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ICloudContacts = void 0;
const n8n_workflow_1 = require("n8n-workflow");
const PROPFIND_PRINCIPAL = '<?xml version="1.0" encoding="UTF-8"?>' +
    '<d:propfind xmlns:d="DAV:">' +
    '<d:prop><d:current-user-principal/></d:prop>' +
    '</d:propfind>';
const PROPFIND_HOME = '<?xml version="1.0" encoding="UTF-8"?>' +
    '<d:propfind xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">' +
    '<d:prop><card:addressbook-home-set/></d:prop>' +
    '</d:propfind>';
const REPORT_CONTACTS = '<?xml version="1.0" encoding="UTF-8"?>' +
    '<card:addressbook-query xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">' +
    '<d:prop><d:getetag/><card:address-data/></d:prop>' +
    '</card:addressbook-query>';
/** Extract text content from an XML element, handling any namespace prefix and attributes. */
function extractHref(xml, parentTag) {
    var _a;
    const re = new RegExp(`<[^>]*${parentTag}[^>]*>[\\s\\S]*?<[^>]*href[^>]*>([^<]+)<\\/[^>]*href>`, 'i');
    return (_a = re.exec(xml)) === null || _a === void 0 ? void 0 : _a[1];
}
function decodeVCard(raw) {
    return raw
        .replace(/&#13;/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&apos;/g, "'")
        .replace(/&quot;/g, '"')
        .trim();
}
class ICloudContacts {
    constructor() {
        this.description = {
            displayName: 'iCloud Contacts',
            name: 'iCloudContacts',
            icon: 'file:ICloudContacts.svg',
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
    }
    async execute() {
        var _a, _b, _c, _d, _e, _f;
        const returnData = [];
        // Build auth header manually — httpRequestWithAuthentication strips auth
        // on iCloud's cross-host redirects (e.g. contacts → p158-contacts).
        const credentials = await this.getCredentials('httpBasicAuth');
        const authHeader = 'Basic ' + Buffer.from(`${credentials.user}:${credentials.password}`).toString('base64');
        const davRequest = async (method, url, body, depth) => {
            const response = await this.helpers.httpRequest({
                method: method,
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
        let step1;
        try {
            step1 = await davRequest('PROPFIND', 'https://contacts.icloud.com/', PROPFIND_PRINCIPAL, '0');
        }
        catch (error) {
            throw new n8n_workflow_1.NodeOperationError(this.getNode(), `iCloud authentication failed: ${error.message}. Check your Apple ID and app-specific password.`);
        }
        const principalPath = extractHref(step1, 'current-user-principal');
        if (!principalPath) {
            throw new n8n_workflow_1.NodeOperationError(this.getNode(), `Could not discover principal. Response: ${step1.substring(0, 500)}`);
        }
        // Step 2: Discover addressbook home (may be on a different host)
        const step2 = await davRequest('PROPFIND', `https://contacts.icloud.com${principalPath}`, PROPFIND_HOME, '0');
        let home = extractHref(step2, 'addressbook-home-set');
        if (!home) {
            throw new n8n_workflow_1.NodeOperationError(this.getNode(), `Could not discover addressbook home. Response: ${step2.substring(0, 500)}`);
        }
        if (!home.startsWith('http'))
            home = `https://contacts.icloud.com${home}`;
        if (!home.endsWith('/'))
            home += '/';
        // Step 3: Fetch all vCards from the card collection
        const step3 = await davRequest('REPORT', `${home}card/`, REPORT_CONTACTS, '1');
        const vcardPattern = /<[^>]*address-data[^>]*>([\s\S]*?)<\/[^>]*address-data>/gi;
        let match;
        while ((match = vcardPattern.exec(step3)) !== null) {
            const vcard = decodeVCard(match[1]);
            if (!vcard.startsWith('BEGIN:VCARD'))
                continue;
            const uid = (_c = (_b = (_a = vcard.match(/^UID[;:](.+)$/m)) === null || _a === void 0 ? void 0 : _a[1]) === null || _b === void 0 ? void 0 : _b.trim()) !== null && _c !== void 0 ? _c : '';
            const isGroup = /X-ADDRESSBOOKSERVER-KIND:\s*group/i.test(vcard);
            const item = { raw: vcard, uid, isGroup };
            if (isGroup) {
                item.groupName = (_f = (_e = (_d = vcard.match(/^FN[;:](.+)$/m)) === null || _d === void 0 ? void 0 : _d[1]) === null || _e === void 0 ? void 0 : _e.trim()) !== null && _f !== void 0 ? _f : '';
                const members = [];
                const memberRe = /X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:([^\s\r\n]+)/gi;
                let m;
                while ((m = memberRe.exec(vcard)) !== null)
                    members.push(m[1].trim());
                item.memberUids = members;
            }
            returnData.push({ json: item });
        }
        return [returnData];
    }
}
exports.ICloudContacts = ICloudContacts;
