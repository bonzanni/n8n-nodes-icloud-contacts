"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ICloudContacts = void 0;
const n8n_workflow_1 = require("n8n-workflow");
class ICloudContacts {
    constructor() {
        this.description = {
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
    }
    async execute() {
        var _a, _b;
        const returnData = [];
        // Build Basic auth header manually so it survives iCloud's redirects
        const credentials = await this.getCredentials('httpBasicAuth');
        const user = credentials.user;
        const password = credentials.password;
        const authHeader = 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');
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
            // httpRequest returns the body directly (string for XML responses)
            if (typeof response === 'string')
                return response;
            return JSON.stringify(response);
        };
        // --- Step 1: PROPFIND / on contacts.icloud.com to get principal path ---
        const step1Body = await davRequest('PROPFIND', 'https://contacts.icloud.com/', '<?xml version="1.0" encoding="UTF-8"?>' +
            '<d:propfind xmlns:d="DAV:">' +
            '<d:prop><d:current-user-principal/></d:prop>' +
            '</d:propfind>', '0');
        const principalPath = (_a = step1Body.match(/<[^>]*current-user-principal[\s\S]*?<[^>]*href>([^<]+)<\/[^>]*href>/i)) === null || _a === void 0 ? void 0 : _a[1];
        if (!principalPath) {
            throw new n8n_workflow_1.NodeOperationError(this.getNode(), `Could not find current-user-principal. Response (first 500 chars): ${step1Body.substring(0, 500)}`);
        }
        // --- Step 2: PROPFIND principal path to get addressbook-home-set ---
        const step2Body = await davRequest('PROPFIND', `https://contacts.icloud.com${principalPath}`, '<?xml version="1.0" encoding="UTF-8"?>' +
            '<d:propfind xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">' +
            '<d:prop><card:addressbook-home-set/></d:prop>' +
            '</d:propfind>', '0');
        let addressbookHome = (_b = step2Body.match(/<[^>]*addressbook-home-set[\s\S]*?<[^>]*href>([^<]+)<\/[^>]*href>/i)) === null || _b === void 0 ? void 0 : _b[1];
        if (!addressbookHome) {
            throw new n8n_workflow_1.NodeOperationError(this.getNode(), `Could not find addressbook-home-set. Response (first 500 chars): ${step2Body.substring(0, 500)}`);
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
        const step3Body = await davRequest('REPORT', cardCollectionUrl, '<?xml version="1.0" encoding="UTF-8"?>' +
            '<card:addressbook-query xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">' +
            '<d:prop><d:getetag/><card:address-data/></d:prop>' +
            '</card:addressbook-query>', '1');
        // Extract all vCards from <card:address-data> or <address-data> elements
        const vcardPattern = /<(?:card:)?address-data[^>]*>([\s\S]*?)<\/(?:card:)?address-data>/gi;
        let vcardMatch;
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
            if (!vcard.startsWith('BEGIN:VCARD'))
                continue;
            const uidMatch = vcard.match(/^UID[;:](.+)$/m);
            const uid = uidMatch ? uidMatch[1].trim() : '';
            const isGroup = /X-ADDRESSBOOKSERVER-KIND:\s*group/i.test(vcard);
            const item = { raw: vcard, uid, isGroup };
            if (isGroup) {
                const fnMatch = vcard.match(/^FN[;:](.+)$/m);
                item.groupName = fnMatch ? fnMatch[1].trim() : '';
                const memberPattern = /X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:([^\s\r\n]+)/gi;
                const memberUids = [];
                let memberMatch;
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
exports.ICloudContacts = ICloudContacts;
