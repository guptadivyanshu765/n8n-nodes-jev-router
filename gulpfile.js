const { src, dest, series } = require('gulp');

// Copies node/credential icons (svg/png) into dist/ alongside the compiled JS,
// since tsc only emits .js files and n8n resolves icons relative to dist.
function buildIcons() {
	return src('nodes/**/*.{png,svg}').pipe(dest('dist/nodes'));
}

exports['build:icons'] = series(buildIcons);
