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
        // --- Step 1: PROPFIND / on contacts.icloud.com to get principal path ---
        const propfindPrincipalBody = '<?xml version="1.0" encoding="UTF-8"?>' +
            '<d:propfind xmlns:d="DAV:">' +
            '<d:prop><d:current-user-principal/></d:prop>' +
            '</d:propfind>';
        const step1Options = {
            method: 'PROPFIND',
            url: 'https://contacts.icloud.com/',
            headers: {
                Depth: '0',
                'Content-Type': 'application/xml; charset=utf-8',
            },
            body: propfindPrincipalBody,
            returnFullResponse: true,
            ignoreHttpStatusErrors: true,
        };
        let step1Response;
        try {
            step1Response = await this.helpers.httpRequestWithAuthentication.call(this, 'httpBasicAuth', step1Options);
        }
        catch (error) {
            throw new n8n_workflow_1.NodeOperationError(this.getNode(), `Failed to connect to iCloud: ${error.message}`);
        }
        const step1Body = typeof step1Response === 'string'
            ? step1Response
            : typeof (step1Response === null || step1Response === void 0 ? void 0 : step1Response.body) === 'string'
                ? step1Response.body
                : JSON.stringify(step1Response);
        // Check for HTTP errors in full response
        const step1Status = (_a = step1Response === null || step1Response === void 0 ? void 0 : step1Response.statusCode) !== null && _a !== void 0 ? _a : step1Response === null || step1Response === void 0 ? void 0 : step1Response.status;
        if (step1Status && (step1Status === 401 || step1Status === 403)) {
            throw new n8n_workflow_1.NodeOperationError(this.getNode(), `iCloud authentication failed (HTTP ${step1Status}). Check your Apple ID and app-specific password.`);
        }
        // Extract principal path — handle any namespace prefix (d:, D:, or none)
        const principalPath = (_b = step1Body.match(/<[^>]*current-user-principal[\s\S]*?<[^>]*href>([^<]+)<\/[^>]*href>/i)) === null || _b === void 0 ? void 0 : _b[1];
        if (!principalPath) {
            throw new n8n_workflow_1.NodeOperationError(this.getNode(), `Could not find current-user-principal in iCloud response. Status: ${step1Status !== null && step1Status !== void 0 ? step1Status : 'unknown'}. Response (first 500 chars): ${step1Body.substring(0, 500)}`);
        }
        // --- Step 2: PROPFIND principal path to get addressbook-home-set ---
        const propfindHomeBody = '<?xml version="1.0" encoding="UTF-8"?>' +
            '<d:propfind xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">' +
            '<d:prop><card:addressbook-home-set/></d:prop>' +
            '</d:propfind>';
        const step2Options = {
            method: 'PROPFIND',
            url: `https://contacts.icloud.com${principalPath}`,
            headers: {
                Depth: '0',
                'Content-Type': 'application/xml; charset=utf-8',
            },
            body: propfindHomeBody,
            returnFullResponse: true,
            ignoreHttpStatusErrors: true,
        };
        let step2Response;
        try {
            step2Response = await this.helpers.httpRequestWithAuthentication.call(this, 'httpBasicAuth', step2Options);
        }
        catch (error) {
            throw new n8n_workflow_1.NodeOperationError(this.getNode(), `Failed to get addressbook-home-set: ${error.message}`);
        }
        const step2Body = typeof step2Response === 'string'
            ? step2Response
            : typeof (step2Response === null || step2Response === void 0 ? void 0 : step2Response.body) === 'string'
                ? step2Response.body
                : JSON.stringify(step2Response);
        // Extract addressbook-home-set — handle any namespace prefix
        const homeMatch = step2Body.match(/<[^>]*addressbook-home-set[\s\S]*?<[^>]*href>([^<]+)<\/[^>]*href>/i);
        let addressbookHome = homeMatch === null || homeMatch === void 0 ? void 0 : homeMatch[1];
        if (!addressbookHome) {
            throw new n8n_workflow_1.NodeOperationError(this.getNode(), `Could not find addressbook-home-set. Response (first 500 chars): ${step2Body.substring(0, 500)}`);
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
        const reportBody = '<?xml version="1.0" encoding="UTF-8"?>' +
            '<card:addressbook-query xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">' +
            '<d:prop><d:getetag/><card:address-data/></d:prop>' +
            '</card:addressbook-query>';
        const step3Options = {
            method: 'REPORT',
            url: cardCollectionUrl,
            headers: {
                Depth: '1',
                'Content-Type': 'application/xml; charset=utf-8',
            },
            body: reportBody,
            returnFullResponse: true,
            ignoreHttpStatusErrors: true,
        };
        let step3Response;
        try {
            step3Response = await this.helpers.httpRequestWithAuthentication.call(this, 'httpBasicAuth', step3Options);
        }
        catch (error) {
            throw new n8n_workflow_1.NodeOperationError(this.getNode(), `Failed to fetch contacts: ${error.message}`);
        }
        const step3Body = typeof step3Response === 'string'
            ? step3Response
            : typeof (step3Response === null || step3Response === void 0 ? void 0 : step3Response.body) === 'string'
                ? step3Response.body
                : JSON.stringify(step3Response);
        // Extract all vCards from <card:address-data> or <address-data> elements
        const vcardPattern = /<(?:card:)?address-data[^>]*>([\s\S]*?)<\/(?:card:)?address-data>/gi;
        let vcardMatch;
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
            const item = {
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
