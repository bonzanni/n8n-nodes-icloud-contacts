const { src, dest } = require('gulp');

function copyIcons() {
	return src('nodes/**/*.{svg,png}').pipe(dest('dist/nodes/'));
}

function copyMetadata() {
	return src('nodes/**/*.node.json').pipe(dest('dist/nodes/'));
}

exports['build:icons'] = copyIcons;
exports['build:metadata'] = copyMetadata;
exports.default = async function () {
	await copyIcons();
	await copyMetadata();
};
