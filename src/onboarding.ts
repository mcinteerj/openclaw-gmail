import type { ClawdbotConfig, ChannelOnboardingAdapter } from "moltbot/plugin-sdk";
import { promptAccountId } from "moltbot/plugin-sdk";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { listGmailAccountIds, resolveDefaultGmailAccountId } from "./accounts.js";

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

export const gmailOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  getStatus: async ({ cfg }: { cfg: ClawdbotConfig }) => {
    const ids = listGmailAccountIds(cfg);
    const configured = ids.length > 0;
    return {
      channel,
      configured,
      statusLines: [`Gmail: ${configured ? `${ids.length} accounts` : "not configured"}`],
      selectionHint: "Polling via gog CLI",
      quickstartScore: configured ? 1 : 5,
    };
  },
  configure: async ({
    cfg,
    prompter,
    accountOverrides,
    shouldPromptAccountIds,
  }: {
    cfg: ClawdbotConfig;
    prompter: {
      text: (opts: { message: string; validate?: (val?: string) => string | undefined; initialValue?: string }) => Promise<string>;
      confirm: (opts: { message: string; initialValue?: boolean }) => Promise<boolean>;
      note: (message: string, title?: string) => Promise<void>;
    };
    accountOverrides: Record<string, string>;
    shouldPromptAccountIds: boolean;
  }) => {
    if (!(await checkGogInstalled())) {
      await prompter.note(
        "The `gog` CLI is required for the Gmail extension.\nPlease install it and ensure it is in your PATH.",
        "Missing Dependency"
      );
      throw new Error("gog CLI not found");
    }

    const version = await getGogVersion();
    if (version && !isVersionAtLeast(version, MIN_GOG_VERSION)) {
      await prompter.note(
        `Your gog version (${version}) is below the recommended ${MIN_GOG_VERSION}.\nSome features may not work correctly.`,
        "Version Warning"
      );
    }

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

    let email = accountId.includes("@") ? accountId : undefined;
    if (!email) {
      email = await prompter.text({
        message: "Gmail address",
        validate: (val: string | undefined) => (val?.includes("@") ? undefined : "Valid email required"),
      });
    }

    if (!email) throw new Error("Email required");

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

    const name = await fetchGmailName(email);

    const accountConfig = {
      enabled: true,
      email,
      name,
      allowFrom,
      pollIntervalMs,
    };

    const gmailConfig = cfg.channels?.gmail || {};
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
  disable: (cfg: ClawdbotConfig) => ({
    ...cfg,
    channels: {
      ...cfg.channels,
      gmail: { ...cfg.channels?.gmail, enabled: false },
    },
  }),
};
