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

const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const https = require("node:https");
const { pipeline } = require("node:stream/promises");
const { createWriteStream } = require("node:fs");
const { createGunzip } = require("node:zlib");
const tar = require("tar");
const AdmZip = require("adm-zip");

/**
 * Parse GitHub repository URL.
 * @param {string} input - GitHub repo URL in format: github.com/username/repo[@version].
 * @returns {Object} Repository information.
 */
function parseRepoURL(input) {
	const regex = /^github\.com\/([\w.-]+)\/([\w.-]+)(?:@([\w.-]+))?$/;
	const match = input.match(regex);

	if (!match) {
		throw new Error(`Invalid GitHub repository format: ${input}`);
	}

	const [, owner, repo, version = "latest"] = match;
	return { owner, repo, version };
}

/**
 * Get the latest release version.
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @returns {Promise<string>} Latest version
 */
async function getLatestVersion(owner, repo) {
	return new Promise((resolve, reject) => {
		const options = {
			hostname: "api.github.com",
			path: `/repos/${owner}/${repo}/releases/latest`,
			headers: {
				"User-Agent": "binrun",
				Accept: "application/vnd.github.v3+json",
			},
		};

		https
			.get(options, (res) => {
				if (res.statusCode === 404) {
					return reject(
						new Error(
							`Repository ${owner}/${repo} not found or has no releases`,
						),
					);
				}

				if (res.statusCode !== 200) {
					return reject(
						new Error(`GitHub API returned status code ${res.statusCode}`),
					);
				}

				let data = "";
				res.on("data", (chunk) => {
					data += chunk;
				});
				res.on("end", () => {
					try {
						const release = JSON.parse(data);
						resolve(release.tag_name);
					} catch (err) {
						reject(
							new Error(`Failed to parse GitHub API response: ${err.message}`),
						);
					}
				});
			})
			.on("error", reject);
	});
}

/**
 * Get release assets.
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {string} version - Release version
 * @returns {Promise<Array>} Release assets
 */
async function getReleaseAssets(owner, repo, version) {
	return new Promise((resolve, reject) => {
		const path =
			version === "latest"
				? `/repos/${owner}/${repo}/releases/latest`
				: `/repos/${owner}/${repo}/releases/tags/${version}`;

		const options = {
			hostname: "api.github.com",
			path,
			headers: {
				"User-Agent": "binrun",
				Accept: "application/vnd.github.v3+json",
			},
		};

		https
			.get(options, (res) => {
				if (res.statusCode === 404) {
					return reject(
						new Error(`Release ${version} not found for ${owner}/${repo}`),
					);
				}

				if (res.statusCode !== 200) {
					return reject(
						new Error(`GitHub API returned status code ${res.statusCode}`),
					);
				}

				let data = "";
				res.on("data", (chunk) => {
					data += chunk;
				});
				res.on("end", () => {
					try {
						const release = JSON.parse(data);
						resolve(release.assets);
					} catch (err) {
						reject(
							new Error(`Failed to parse GitHub API response: ${err.message}`),
						);
					}
				});
			})
			.on("error", reject);
	});
}

/**
 * Get system information for matching binaries.
 * @returns {Object} System information
 */
function getSystemInfo() {
	const platform = os.platform();
	const arch = os.arch();

	let osName;
	switch (platform) {
		case "darwin":
			osName = "Darwin";
			break;
		case "linux":
			osName = "Linux";
			break;
		case "win32":
			osName = "Windows";
			break;
		default:
			throw new Error(`Unsupported platform: ${platform}`);
	}

	let archName;
	switch (arch) {
		case "x64":
			archName = "x86_64";
			break;
		case "arm64":
			archName = "arm64";
			break;
		case "ia32":
			archName = "386";
			break;
		default:
			throw new Error(`Unsupported architecture: ${arch}`);
	}

	return { osName, archName, platform };
}

/**
 * Find matching binary asset for current system.
 * @param {Array} assets - Release assets
 * @param {Object} systemInfo - System information
 * @param {string} repo - Repository name
 * @returns {Object} Matching asset
 */
function findMatchingAsset(assets, systemInfo, repo) {
	const { osName, archName, platform } = systemInfo;

	// For macOS, create a regex pattern that matches both "Darwin" and "macOS".
	let osPattern = osName;
	if (platform === "darwin") {
		osPattern = "(Darwin|macOS)";
	}

	// Look for tar.gz archive first (GoReleaser common format).
	const tarRegex = new RegExp(
		`${repo}_${osPattern}_${archName}(\.tar\.gz|\.tgz)$`,
		"i",
	);
	const tarAsset = assets.find((asset) => tarRegex.test(asset.name));
	if (tarAsset) {
		return { ...tarAsset, isTar: true };
	}

	// Look for zip archive.
	const zipRegex = new RegExp(`${repo}_${osPattern}_${archName}\.zip$`, "i");
	const zipAsset = assets.find((asset) => zipRegex.test(asset.name));
	if (zipAsset) {
		return { ...zipAsset, isZip: true };
	}

	// Look for direct binary.
	let binaryExt = "";
	if (platform === "win32") {
		binaryExt = ".exe";
	}

	const binaryRegex = new RegExp(
		`${repo}(_${osPattern}_${archName})?${binaryExt}$`,
		"i",
	);
	const binaryAsset = assets.find((asset) => binaryRegex.test(asset.name));
	if (binaryAsset) {
		return { ...binaryAsset, isBinary: true };
	}

	throw new Error(`No matching binary found for ${osName} ${archName}`);
}

/**
 * Download a file with redirect support.
 * @param {string} url - Download URL
 * @param {string} destPath - Destination path
 * @param {number} [redirectLimit=5] - Maximum number of redirects to follow
 * @param {Function} [logFn] - Logging function
 * @returns {Promise<void>}
 */
async function downloadFile(url, destPath, redirectLimit = 5, logFn = () => {}) {
	// Use the provided logFn instead of trying to access log from outer scope
	return new Promise((resolve, reject) => {
		const options = {
			headers: { "User-Agent": "binrun" },
		};

		const handleResponse = (res) => {
			// Handle redirects (301, 302, 303, 307, 308).
			if (
				res.statusCode >= 300 &&
				res.statusCode < 400 &&
				res.headers.location
			) {
				if (redirectLimit <= 0) {
					return reject(new Error("Too many redirects"));
				}

				logFn(`Following redirect to ${res.headers.location}`);
				return downloadFile(res.headers.location, destPath, redirectLimit - 1, logFn)
					.then(resolve)
					.catch(reject);
			}

			if (res.statusCode !== 200) {
				return reject(
					new Error(`Failed to download: server returned ${res.statusCode}`),
				);
			}

			const file = createWriteStream(destPath);
			res.pipe(file);

			file.on("finish", () => {
				file.close();
				resolve();
			});

			file.on("error", (err) => {
				fs.unlink(destPath, () => {}); // Delete the file on error.
				reject(err);
			});

			res.on("error", (err) => {
				fs.unlink(destPath, () => {}); // Delete the file on error.
				reject(err);
			});
		};

		https.get(url, options, handleResponse).on("error", reject);
	});
}

/**
 * Extract tar.gz archive.
 * @param {string} archivePath - Path to archive
 * @param {string} extractDir - Extraction directory
 * @param {string} repoName - Repository name to help identify the binary
 * @returns {Promise<string>} Path to binary
 */
async function extractTarGz(archivePath, extractDir, repoName) {
	await fs.promises.mkdir(extractDir, { recursive: true });

	const fileStream = fs.createReadStream(archivePath);
	const gunzip = createGunzip();

	await pipeline(fileStream, gunzip, tar.extract({ cwd: extractDir }));

	return findBinaryInDir(extractDir, repoName);
}

/**
 * Extract zip archive.
 * @param {string} archivePath - Path to archive
 * @param {string} extractDir - Extraction directory
 * @param {string} repoName - Repository name to help identify the binary
 * @returns {Promise<string>} Path to binary
 */
async function extractZip(archivePath, extractDir, repoName) {
	await fs.promises.mkdir(extractDir, { recursive: true });

	const zip = new AdmZip(archivePath);
	zip.extractAllTo(extractDir, true);

	return findBinaryInDir(extractDir, repoName);
}

/**
 * Find binary in directory.
 * @param {string} dir - Directory to search
 * @param {string} repoName - Repository name to help identify the binary
 * @returns {Promise<string>} Path to binary
 */
async function findBinaryInDir(dir, repoName) {
	// Find the binary in a recursive search.
	let binaryPath = null;

	// Helper function to recursively search directories.
	async function searchDir(currentDir, depth = 0) {
		// Limit recursion depth for safety.
		if (depth > 3) return;

		const files = await fs.promises.readdir(currentDir);

		// Sort files to prioritize certain files.
		const sortedFiles = [...files].sort((a, b) => {
			// Prioritize files that match the repo name.
			const aMatchesRepo = a.toLowerCase().includes(repoName.toLowerCase());
			const bMatchesRepo = b.toLowerCase().includes(repoName.toLowerCase());

			if (aMatchesRepo && !bMatchesRepo) return -1;
			if (!aMatchesRepo && bMatchesRepo) return 1;

			// Deprioritize common non-binary files.
			const aIsCommonNonBinary =
				/^(readme|license|changelog|contributing)/i.test(a);
			const bIsCommonNonBinary =
				/^(readme|license|changelog|contributing)/i.test(b);

			if (aIsCommonNonBinary && !bIsCommonNonBinary) return 1;
			if (!aIsCommonNonBinary && bIsCommonNonBinary) return -1;

			return 0;
		});

		for (const file of sortedFiles) {
			if (binaryPath) break; // Stop if we already found a binary.

			const filePath = path.join(currentDir, file);
			const stats = await fs.promises.stat(filePath);

			if (stats.isDirectory()) {
				// Recursively search subdirectories.
				await searchDir(filePath, depth + 1);
			} else if (stats.isFile() && stats.mode & 0o111) {
				// Check if the file is executable and not a known non-binary.
				const isLikelyNonBinary =
					/\.(md|txt|json|ya?ml|toml|cfg|ini|html|js|ts|css|scss|py|rb|go|rs|java|c|cpp|h|hpp)$/i.test(
						file,
					);
				const isCommonNonBinary =
					/^(readme|license|changelog|contributing)/i.test(file);

				if (!isLikelyNonBinary && !isCommonNonBinary) {
					// If the file name matches the repo name (with or without .exe), it's likely the binary we want.
					const fileBaseName = file.toLowerCase().replace(/\.exe$/i, "");
					const repoNameLower = repoName.toLowerCase();
					
					if (
						fileBaseName === repoNameLower || 
						fileBaseName.includes(repoNameLower) ||
						(file.endsWith(".exe") && fileBaseName.includes(repoNameLower)) ||
						(!file.includes(".") && file !== "LICENSE" && file !== "COPYING")
					) {
						binaryPath = filePath;
						break;
					}

					// If we haven't found a good match yet, keep track of this as a potential match.
					if (!binaryPath) {
						binaryPath = filePath;
					}
				}
			}
		}
	}

	await searchDir(dir);

	// If we didn't find an executable, look for any file without an extension or with .exe.
	if (!binaryPath) {
		// Final attempt - find a file without extension or with .exe extension.
		async function finalSearch(currentDir) {
			const files = await fs.promises.readdir(currentDir);

			for (const file of files) {
				const filePath = path.join(currentDir, file);
				const stats = await fs.promises.stat(filePath);

				if (stats.isDirectory()) {
					const result = await finalSearch(filePath);
					if (result) return result;
				} else if (
					(!file.includes(".") || file.endsWith(".exe")) && 
					!/^(license|copying|readme|changelog|contributing)$/i.test(file)
				) {
					// Prioritize files that match the repo name with .exe extension
					if (file.toLowerCase().replace(/\.exe$/i, "") === repoName.toLowerCase() ||
						file.toLowerCase().includes(repoName.toLowerCase())) {
						return filePath;
					}
					
					// Keep track of this file as a potential match
					if (!binaryPath) {
						binaryPath = filePath;
					}
				}
			}

			return binaryPath;
		}

		binaryPath = await finalSearch(dir);
	}

	if (!binaryPath) {
		throw new Error("Could not find binary in extracted archive");
	}

	// Make the binary executable.
	await fs.promises.chmod(binaryPath, 0o755);

	return binaryPath;
}

/**
 * Set up and run a binary from GitHub.
 * @param {string} repoInput - GitHub repo URL.
 * @param {Object} options - Options.
 * @param {boolean} options.debug - Enable debug logging.
 * @returns {Promise<void>}
 */
async function run(repoInput, options = {}) {
	const debug = options.debug || false;

	// Helper function for conditional logging.
	const log = debug ? console.log : () => {};
	const { owner, repo, version } = parseRepoURL(repoInput);

	const actualVersion =
		version === "latest" ? await getLatestVersion(owner, repo) : version;

	log(`Using ${owner}/${repo}@${actualVersion}`);

	const assets = await getReleaseAssets(owner, repo, version);
	const systemInfo = getSystemInfo();
	const asset = findMatchingAsset(assets, systemInfo, repo);

	log(`Found matching asset: ${asset.name}`);

	// Create cache directory.
	const cacheDir = path.join(os.homedir(), ".binrun", "cache");
	await fs.promises.mkdir(cacheDir, { recursive: true });

	const binDir = path.join(cacheDir, `${owner}_${repo}_${actualVersion}`);
	await fs.promises.mkdir(binDir, { recursive: true });

	// Set up paths for caching.
	const binaryPath = path.join(binDir, asset.name);
	const extractDir = path.join(binDir, "bin");
	const cachedBinaryPathFile = path.join(binDir, ".binary_path");
	let executablePath = null;

	// Try to get cached binary path.
	try {
		const cachedPath = await fs.promises.readFile(cachedBinaryPathFile, "utf8");

		// Verify cached binary exists and is executable.
		await fs.promises.access(cachedPath, fs.constants.X_OK);

		log("Using cached binary");
		executablePath = cachedPath;
	} catch (err) {
		// No valid cache, proceed with download/extraction.

		// Check if we need to download.
		let needToDownload = true;
		try {
			const stats = await fs.promises.stat(binaryPath);
			if (stats.size > 0) {
				needToDownload = false;
			}
		} catch (err) {
			// File doesn't exist, need to download.
		}

		if (needToDownload) {
			log(`Downloading ${asset.browser_download_url}...`);
			await downloadFile(asset.browser_download_url, binaryPath, 5, log);
		}

		// Process the file.
		if (asset.isTar || asset.isZip) {
			// Check if we've already extracted.
			let extractedBinaryPath = null;
			try {
				extractedBinaryPath = await fs.promises.readFile(
					path.join(extractDir, ".extracted_binary_path"),
					"utf8",
				);

				// Verify the extracted binary exists.
				await fs.promises.access(extractedBinaryPath, fs.constants.F_OK);
				log("Using previously extracted binary");
			} catch (err) {
				// Need to extract.
				log(`Extracting ${asset.name}...`);
				await fs.promises.mkdir(extractDir, { recursive: true });

				if (asset.isTar) {
					extractedBinaryPath = await extractTarGz(
						binaryPath,
						extractDir,
						repo,
					);
				} else {
					extractedBinaryPath = await extractZip(binaryPath, extractDir, repo);
				}

				// Save the extracted binary path.
				await fs.promises.writeFile(
					path.join(extractDir, ".extracted_binary_path"),
					extractedBinaryPath,
				);
			}

			// Make sure it's executable.
			await fs.promises.chmod(extractedBinaryPath, 0o755);
			executablePath = extractedBinaryPath;
		} else {
			// Direct binary.
			executablePath = binaryPath;
			await fs.promises.chmod(binaryPath, 0o755);
		}

		// Cache the binary path for future use.
		await fs.promises.writeFile(cachedBinaryPathFile, executablePath);
	}

	// Pass all command line arguments to the binary.
	const args = process.argv.slice(3);
	log(`Running ${executablePath} ${args.join(" ")}`);

	// Use spawn directly for better stdio handling.
	const childProcess = spawn(executablePath, args, {
		stdio: "inherit", // This will properly inherit stdin, stdout, and stderr
		env: process.env, // Pass through environment variables
	});

	// Wait for the process to complete.
	return new Promise((resolve, reject) => {
		childProcess.on("close", (code) => {
			if (code === 0) {
				resolve();
			} else {
				reject(new Error(`Process exited with code ${code}`));
			}
		});

		childProcess.on("error", (err) => {
			reject(err);
		});
	});
}

module.exports = { run };
