#!/usr/bin/env node
/**
 * Copyright 2025 David Stotijn
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const { run } = require("./index.js");

// Parse command-line arguments.
const args = process.argv.slice(2);
const debugFlag = args.includes("--debug");
let repoArg = null;

// Find the repository URL argument.
for (const arg of args) {
	if (arg !== "--debug" && arg.includes("github.com/")) {
		repoArg = arg;
		break;
	}
}

// Filter out --debug from the args that will be passed to the binary.
const binaryArgs = args.filter((arg) => arg !== "--debug" && arg !== repoArg);
process.argv = [process.argv[0], process.argv[1], repoArg, ...binaryArgs];

if (!repoArg) {
	console.error("Usage: binrun [--debug] github.com/username/repo[@version]");
	process.exit(1);
}

// Run with debug mode if --debug flag is present.
run(repoArg, { debug: debugFlag })
	.then(() => process.exit(0))
	.catch((err) => {
		console.error(`Error: ${err.message}`);
		process.exit(1);
	});
