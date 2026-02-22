import type { OpenClawConfig, ChannelOnboardingAdapter } from "openclaw/plugin-sdk";
import { promptAccountId } from "openclaw/plugin-sdk";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { listGmailAccountIds, resolveDefaultGmailAccountId } from "./accounts.js";
import { readGogCredentials, runOAuthFlow, createOAuth2Client } from "./auth.js";
import { ApiGmailClient } from "./api-client.js";

const execAsync = promisify(exec);
const channel = "gmail" as const;

const MIN_GOG_VERSION = "1.2.0";

async function checkGogInstalled(): Promise<boolean> {
  try {
    await execAsync("command -v gog");
    return true;
  } catch {
    return false;
  }
}

async function getGogVersion(): Promise<string | null> {
  try {
    const { stdout } = await execAsync("gog --version");
    const match = stdout.match(/gog version (\d+\.\d+\.\d+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function isVersionAtLeast(current: string, min: string): boolean {
  const currentParts = current.split(".").map(Number);
  const minParts = min.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (currentParts[i] > minParts[i]) return true;
    if (currentParts[i] < minParts[i]) return false;
  }
  return true;
}

async function checkGogAuth(email: string): Promise<boolean> {
  try {
    const { stdout } = await execAsync("gog auth list --plain");
    return stdout.includes(email);
  } catch {
    return false;
  }
}

async function authorizeGog(email: string): Promise<void> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    const child = spawn("gog", ["auth", "add", email], { stdio: "inherit" });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`gog auth failed with code ${code}`));
    });
  });
}

async function fetchGmailName(email: string): Promise<string | undefined> {
  try {
    const { stdout } = await execAsync(`gog gmail settings sendas list --account ${email} --json`);
    const data = JSON.parse(stdout);
    const primary = data.sendAs?.find((s: any) => s.isPrimary) || data.sendAs?.[0];
    return primary?.displayName;
  } catch {
    return undefined;
  }
}

async function fetchApiDisplayName(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<string | undefined> {
  try {
    const auth = createOAuth2Client({ clientId, clientSecret, refreshToken });
    const client = new ApiGmailClient(auth);
    const sendAs = await client.getSendAs();
    const primary = sendAs.find((s) => s.isPrimary) || sendAs[0];
    return primary?.displayName;
  } catch {
    return undefined;
  }
}

export const gmailOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  getStatus: async ({ cfg }: { cfg: OpenClawConfig }) => {
    const ids = listGmailAccountIds(cfg);
    const configured = ids.length > 0;
    const gmailConfig = (cfg.channels as any)?.gmail || {};
    const accounts = gmailConfig.accounts || {};
    const backends = new Set(
      Object.values(accounts).map((a: any) => a.backend || "gog"),
    );
    let hint = "Gmail polling";
    if (backends.size === 1) {
      hint = backends.has("api") ? "Gmail API" : "gog CLI";
    } else if (backends.size > 1) {
      hint = "Gmail API + gog CLI";
    }
    return {
      channel,
      configured,
      statusLines: [`Gmail: ${configured ? `${ids.length} accounts` : "not configured"}`],
      selectionHint: hint,
      quickstartScore: configured ? 1 : 5,
    };
  },
  configure: async ({
    cfg,
    prompter,
    accountOverrides,
    shouldPromptAccountIds,
  }: {
    cfg: OpenClawConfig;
    prompter: {
      text: (opts: { message: string; validate?: (val?: string) => string | undefined; initialValue?: string }) => Promise<string>;
      confirm: (opts: { message: string; initialValue?: boolean }) => Promise<boolean>;
      note: (message: string, title?: string) => Promise<void>;
    };
    accountOverrides: Record<string, string>;
    shouldPromptAccountIds: boolean;
  }) => {
    // --- Account selection (unchanged) ---
    const existingIds = listGmailAccountIds(cfg);
    const gmailOverride = accountOverrides.gmail?.trim();
    const defaultAccountId = resolveDefaultGmailAccountId(cfg);
    let accountId = gmailOverride || defaultAccountId;

    if (shouldPromptAccountIds && !gmailOverride && existingIds.length > 0) {
      accountId = await promptAccountId({
        cfg,
        prompter,
        label: "Gmail",
        currentId: accountId,
        listAccountIds: listGmailAccountIds,
        defaultAccountId,
      });
    }

    // --- Email prompt (unchanged) ---
    let email = accountId.includes("@") ? accountId : undefined;
    if (!email) {
      email = await prompter.text({
        message: "Gmail address",
        validate: (val: string | undefined) => (val?.includes("@") ? undefined : "Valid email required"),
      });
    }
    if (!email) throw new Error("Email required");

    // --- Detect available auth sources ---
    const gmailConfig = (cfg.channels as any)?.gmail || {};
    const existingAccount = gmailConfig.accounts?.[email];
    const existingOAuth = existingAccount?.oauth;
    const gogInstalled = await checkGogInstalled();
    const gogCreds = readGogCredentials();

    // --- Determine backend ---
    let backend: "api" | "gog";
    let clientId: string | undefined;
    let clientSecret: string | undefined;
    let refreshToken: string | undefined;

    if (existingOAuth?.clientId && existingOAuth?.clientSecret && existingOAuth?.refreshToken) {
      // Scenario D: Existing API user reconfiguring
      backend = "api";
      clientId = existingOAuth.clientId;
      clientSecret = existingOAuth.clientSecret;
      refreshToken = existingOAuth.refreshToken;

      await prompter.note(
        `Using existing API credentials for ${email}.`,
        "OAuth Credentials"
      );

      const reAuth = await prompter.confirm({
        message: "Re-authorize with Google? (only needed if token expired)",
        initialValue: false,
      });
      if (reAuth) {
        refreshToken = await runOAuthFlow(clientId, clientSecret);
      }
    } else if (gogInstalled && gogCreds) {
      // Scenario A/C: gog installed with credentials — offer migration
      const migrate = await prompter.confirm({
        message: "Found gog CLI credentials. Migrate to direct API access? (recommended, one-time browser auth)",
        initialValue: true,
      });

      if (migrate) {
        backend = "api";
        clientId = gogCreds.clientId;
        clientSecret = gogCreds.clientSecret;
        await prompter.note(
          "Reusing your gog OAuth client credentials.\nA browser window will open for one-time authorization.",
          "API Migration"
        );
        refreshToken = await runOAuthFlow(clientId, clientSecret);
      } else {
        backend = "gog";
      }
    } else if (gogInstalled) {
      // gog installed but no credentials file — offer choice
      const useApi = await prompter.confirm({
        message: "Use direct Gmail API access? (recommended; otherwise uses gog CLI)",
        initialValue: true,
      });

      if (useApi) {
        backend = "api";
      } else {
        backend = "gog";
      }
    } else {
      // Scenario B: No gog — API is the only option
      backend = "api";
    }

    // --- API backend: resolve credentials and run OAuth if needed ---
    if (backend === "api" && !refreshToken) {
      // Need client credentials
      if (!clientId || !clientSecret) {
        if (gogCreds) {
          clientId = gogCreds.clientId;
          clientSecret = gogCreds.clientSecret;
        } else {
          await prompter.note(
            "To use Gmail with OpenClaw, you need a Google Cloud OAuth client:\n" +
            "1. Go to https://console.cloud.google.com/apis/credentials\n" +
            "2. Create a project (or use existing)\n" +
            "3. Enable the Gmail API\n" +
            "4. Create OAuth 2.0 Client ID (type: Desktop app)\n" +
            "5. Copy the Client ID and Client Secret",
            "GCP OAuth Setup"
          );

          clientId = await prompter.text({
            message: "OAuth Client ID",
            validate: (val?: string) => (val?.trim() ? undefined : "Client ID required"),
          });
          clientSecret = await prompter.text({
            message: "OAuth Client Secret",
            validate: (val?: string) => (val?.trim() ? undefined : "Client Secret required"),
          });
        }
      }

      await prompter.note(
        "A browser window will open for Gmail authorization.",
        "OAuth Flow"
      );
      refreshToken = await runOAuthFlow(clientId!, clientSecret!);
    }

    // --- gog backend: version check + auth ---
    if (backend === "gog") {
      const version = await getGogVersion();
      if (version && !isVersionAtLeast(version, MIN_GOG_VERSION)) {
        await prompter.note(
          `Your gog version (${version}) is below the recommended ${MIN_GOG_VERSION}.\nSome features may not work correctly.`,
          "Version Warning"
        );
      }

      const isAuthed = await checkGogAuth(email);
      if (!isAuthed) {
        await prompter.note(
          `Gog CLI is not authorized for ${email}. We need to authorize it now.`,
          "Authorization"
        );
        const doAuth = await prompter.confirm({
          message: "Authorize gog now?",
          initialValue: true,
        });
        if (doAuth) {
          await authorizeGog(email);
        } else {
          await prompter.note("Skipping auth. You must run `gog auth add " + email + "` manually.", "Warning");
        }
      }
    }

    // --- Common prompts ---
    const allowFromRaw = await prompter.text({
      message: "Allow emails from (comma separated, * for all)",
      initialValue: "",
    });
    const allowFrom = allowFromRaw.split(",").map((s: string) => s.trim()).filter(Boolean);

    const pollIntervalSecsRaw = await prompter.text({
      message: "Polling interval (seconds)",
      initialValue: "60",
      validate: (val: string | undefined) => {
        const n = parseInt(val || "", 10);
        return isNaN(n) || n < 1 ? "Positive integer required" : undefined;
      }
    });
    const pollIntervalMs = parseInt(pollIntervalSecsRaw, 10) * 1000;

    // --- Fetch display name via appropriate backend ---
    let name: string | undefined;
    if (backend === "api" && clientId && clientSecret && refreshToken) {
      name = await fetchApiDisplayName(clientId, clientSecret, refreshToken);
    } else {
      name = await fetchGmailName(email);
    }

    // --- Build account config ---
    const accountConfig: Record<string, unknown> = {
      enabled: true,
      email,
      name,
      allowFrom,
      pollIntervalMs,
      backend,
    };

    if (backend === "api" && clientId && clientSecret && refreshToken) {
      accountConfig.oauth = { clientId, clientSecret, refreshToken };
    }

    const accounts = gmailConfig.accounts || {};

    const next = {
      ...cfg,
      channels: {
        ...cfg.channels,
        gmail: {
          dmPolicy: "allowlist",
          archiveOnReply: true,
          ...gmailConfig,
          enabled: true,
          accounts: {
            ...accounts,
            [email]: accountConfig,
          },
        },
      },
    };

    return { cfg: next, accountId: email };
  },
  disable: (cfg: OpenClawConfig) => ({
    ...cfg,
    channels: {
      ...cfg.channels,
      gmail: { ...cfg.channels?.gmail, enabled: false },
    },
  }),
};
