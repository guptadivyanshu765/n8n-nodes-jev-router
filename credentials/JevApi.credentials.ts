import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class JevApi implements ICredentialType {
	name = 'jevApi';

	displayName = 'Jev API';

	documentationUrl = 'https://typesafe.ai/docs';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description: 'API key issued by TypeSafe AI, sent as a Bearer token',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://api.typesafe.ai',
			required: true,
			description:
				'Base URL of the Jev-compatible API. Change this to point at OpenRouter or another compatible gateway.',
		},
	];

	// Applies the Bearer token to every request made with this credential.
	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
				'Content-Type': 'application/json',
			},
		},
	};

	// Minimal call n8n uses to validate the credential from the "Test" button.
	// A single trivial Noul question keeps this cheap while still exercising
	// the real auth header and endpoint.
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl}}',
			url: '/v1/systemone',
			method: 'POST',
			body: {
				model: 'jev-1.13.0',
				state: 'credential test',
				questions: {
					ping: {
						type: 'noul',
						instructions: 'Is this a test?',
					},
				},
			},
		},
	};
}
