import path from "node:path";
import { fileURLToPath } from "node:url";
import { AppError, requireThat, VERSION } from "../../../packages/contracts/src/index.mjs";
import {
  DEFAULT_GITHUB_API,
  DEFAULT_UPDATE_REPO,
  checkForUpdate,
  detectInstallMode,
  downloadAndVerifyRelease,
  installUpdateTarball,
} from "../../../packages/platform/src/updater.mjs";
import { assertIdle } from "./operations.mjs";

const PACKAGE_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

export function createUpdaterService(service, options = {}) {
  const currentVersion = options.currentVersion ?? VERSION;
  const repo = options.repo ?? process.env.ATK_UPDATE_REPO ?? DEFAULT_UPDATE_REPO;
  const apiBase = options.apiBase ?? process.env.ATK_UPDATE_API_BASE ?? DEFAULT_GITHUB_API;
  const installMode = options.installMode ?? detectInstallMode(options.packageRoot ?? PACKAGE_ROOT);
  const fetchImpl = options.fetchImpl ?? fetch;
  const installer = options.installer ?? installUpdateTarball;

  let activeCheck = null;
  let activeApply = null;
  let state = {
    currentVersion,
    installMode,
    repo,
    status: "idle",
    checking: false,
    applying: false,
    updateAvailable: false,
    latestVersion: currentVersion,
    tagName: null,
    prerelease: false,
    publishedAt: null,
    releaseUrl: `https://github.com/${repo}/releases`,
    notes: "",
    asset: null,
    checkedAt: null,
    lastError: null,
    appliedVersion: null,
    downloadedPath: null,
    restartRequired: false,
  };

  function getState() {
    return { ...state };
  }

  async function check({ includePrerelease = false } = {}) {
    if (activeCheck) return activeCheck;
    state = { ...state, checking: true, status: "checking", lastError: null };
    activeCheck = (async () => {
      try {
        const result = await checkForUpdate({
          currentVersion,
          repo,
          apiBase,
          includePrerelease: Boolean(includePrerelease),
          fetchImpl,
        });
        state = {
          ...state,
          checking: false,
          status: state.restartRequired
            ? "ready"
            : result.updateAvailable
              ? "available"
              : "up-to-date",
          updateAvailable: result.updateAvailable,
          latestVersion: result.latestVersion,
          tagName: result.tagName,
          prerelease: result.prerelease,
          publishedAt: result.publishedAt,
          releaseUrl: result.releaseUrl,
          notes: result.notes,
          asset: result.asset,
          checkedAt: result.checkedAt,
          lastError: null,
        };
        return getState();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        state = {
          ...state,
          checking: false,
          status: state.restartRequired ? "ready" : "error",
          lastError: message,
          checkedAt: new Date().toISOString(),
        };
        throw new AppError("UPDATE_CHECK_FAILED", message, 502);
      } finally {
        activeCheck = null;
      }
    })();
    return activeCheck;
  }

  async function apply({
    includePrerelease = false,
    allowSource = false,
  } = {}) {
    requireThat(!activeApply, "UPDATE_IN_PROGRESS", "An update installation is already in progress", 409);
    assertIdle(service);
    if (installMode === "source" && !allowSource) {
      throw new AppError(
        "SOURCE_INSTALL_NOT_SUPPORTED",
        "Auto-install is disabled for a Git source checkout. Pull the latest release tag or install the GitHub Release package.",
        409,
        { releaseUrl: state.releaseUrl },
      );
    }
    const latest = await check({ includePrerelease });
    requireThat(
      latest.updateAvailable,
      "ALREADY_UP_TO_DATE",
      `Already running the latest version (${currentVersion})`,
      409,
    );
    requireThat(
      latest.asset?.url,
      "UPDATE_ASSET_MISSING",
      "The latest GitHub Release does not contain a downloadable package archive",
      409,
    );
    activeApply = (async () => {
      state = { ...state, applying: true, status: "downloading", lastError: null };
      try {
        const destDir = path.join(service.dataDir, "updates", latest.latestVersion);
        const downloaded = await downloadAndVerifyRelease({
          release: latest,
          destDir,
          fetchImpl,
          requireChecksum: options.requireChecksum !== false,
        });
        state = { ...state, status: "installing", downloadedPath: downloaded.filePath };
        const installed = await installer({
          tarballPath: downloaded.filePath,
          prefix: options.installPrefix,
        });
        state = {
          ...state,
          applying: false,
          status: "ready",
          appliedVersion: latest.latestVersion,
          restartRequired: true,
          lastError: null,
        };
        return {
          ...getState(),
          sha256: downloaded.sha256,
          verified: downloaded.verified,
          installed: Boolean(installed?.installed ?? true),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        state = {
          ...state,
          applying: false,
          status: "error",
          lastError: message,
        };
        if (error instanceof AppError) throw error;
        throw new AppError("UPDATE_APPLY_FAILED", message, 500);
      } finally {
        activeApply = null;
      }
    })();
    return activeApply;
  }

  return { getState, check, apply };
}
