import * as fs from 'fs';
import * as path from 'path';
import minify_html from './utils/minify_html';
import { create_compilers, create_app, create_manifest_data, create_serviceworker_manifest } from '../core';
import { copy_shimport } from './utils/copy_shimport';
import read_template from '../core/read_template';
import inject_resources from '../core/create_compilers/inject';
import { CompileResult } from '../core/create_compilers/interfaces';
import { noop } from './utils/noop';
import validate_bundler from './utils/validate_bundler';
import { copy_runtime } from './utils/copy_runtime';
import { rimraf, mkdirp } from './utils/fs_utils';
import { create_index_html } from "../core/generate_index_html";

type Opts = {
	cwd?: string;
	src?: string;
	routes?: string;
	dest?: string;
	output?: string;
	static?: string;
	basepath?: string,
	legacy?: boolean;
	bundler?: 'rollup' | 'webpack';
	ext?: string;
	oncompile?: ({ type, result }: { type: string; result: CompileResult }) => void;
	ssr?: boolean;
	hashbang?: boolean,
	template_file?: string;
};

export async function build({
	cwd,
	src = 'src',
	routes = 'src/routes',
	output = 'src/node_modules/@sapper',
	static: static_files = 'static',
	dest = '__sapper__/build',
	ssr = true,
	hashbang = false,
	template_file = 'template.html',
	basepath = '',

	bundler,
	legacy = false,
	ext,
	oncompile = noop
}: Opts = {}) {
	bundler = validate_bundler(bundler);

	cwd = path.resolve(cwd);
	src = path.resolve(cwd, src);
	dest = path.resolve(cwd, dest);
	routes = path.resolve(cwd, routes);
	output = path.resolve(cwd, output);
	static_files = path.resolve(cwd, static_files);

	if (legacy && bundler === 'webpack') {
		throw new Error(`Legacy builds are not supported for projects using webpack`);
	}

	rimraf(output);
	mkdirp(output);
	copy_runtime(output, ssr);

	rimraf(dest);
	mkdirp(`${dest}/client`);
	copy_shimport(dest);

	// minify src/template.html
	// TODO compile this to a function? could be quicker than str.replace(...).replace(...).replace(...)
	const template = read_template(src, template_file);

	fs.writeFileSync(`${dest}/${template_file}`, minify_html(template));

	const manifest_data = create_manifest_data(routes, ext);

	// create src/node_modules/@sapper/app.mjs and server.mjs
	create_app({
		bundler,
		manifest_data,
		cwd,
		src,
		dest,
		routes,
		output,
		ssr,
		hashbang,
		template: template_file,
		dev: false
	});

	const { client, server, serviceworker } = await create_compilers(bundler, cwd, src, dest, false);

	const client_result = await client.compile();
	oncompile({
		type: 'client',
		result: client_result
	});

	const build_info = client_result.to_json(manifest_data, {
		src,
		routes,
		dest
	});

	if (legacy) {
		process.env.SAPPER_LEGACY_BUILD = 'true';
		const { client: legacy_client } = await create_compilers(bundler, cwd, src, dest, false);

		const legacy_client_result = await legacy_client.compile();

		oncompile({
			type: 'client (legacy)',
			result: legacy_client_result
		});

		legacy_client_result.to_json(manifest_data, { src, routes, dest });
		build_info.legacy_assets = legacy_client_result.assets;
		delete process.env.SAPPER_LEGACY_BUILD;
	}

	fs.writeFileSync(path.join(dest, 'build.json'), JSON.stringify(build_info));
	if (bundler === 'rollup') {
		inject_resources(path.join(dest, 'build.json'), path.join(dest, 'client'));
	}

	const server_stats = await server.compile();
	if (bundler === 'rollup') {
		inject_resources(path.join(dest, 'build.json'), path.join(dest, 'server'));
	}
	oncompile({
		type: 'server',
		result: server_stats
	});

	let serviceworker_stats;

	if (serviceworker) {

		const client_files = client_result.chunks
			.filter(chunk => !chunk.file.endsWith('.map')) // SW does not need to cache sourcemap files
			.map(chunk => `client/${chunk.file}`);

		create_serviceworker_manifest({
			manifest_data,
			output,
			client_files,
			static_files,
			ssr
		});

		serviceworker_stats = await serviceworker.compile();

		oncompile({
			type: 'serviceworker',
			result: serviceworker_stats
		});
	}

	if (!ssr) {
		create_index_html({
			basepath,
			build_info,
			dev: false,
			output,
			cwd,
			src,
			dest,
			ssr,
			hashbang,
			template_file,
			service_worker: !!serviceworker
		});
	}
}
