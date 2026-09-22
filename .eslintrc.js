module.exports = {
	parser: '@typescript-eslint/parser',
	parserOptions: {
		project: './tsconfig.json',
		sourceType: 'module',
	},
	plugins: ['@typescript-eslint'],
	extends: ['plugin:n8n-nodes-base/community'],
	rules: {
		'n8n-nodes-base/node-param-default-missing': 'off',
	},
	overrides: [
		{
			files: ['package.json'],
			parser: 'jsonc-eslint-parser',
			extends: ['plugin:n8n-nodes-base/community'],
		},
	],
};
