import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// Store historyIds in ~/.moltbot/state/gmail/history-{account}.json
const STORE_DIR = path.join(os.homedir(), ".moltbot", "state", "gmail");

interface HistoryState {
  historyId: string;
  lastSync: number;
}

function getStorePath(account: string) {
  // Sanitize email for filename
  const safeAccount = account.replace(/[^a-z0-9@.-]/gi, "_");
  return path.join(STORE_DIR, `history-${safeAccount}.json`);
}

export async function loadHistoryId(account: string): Promise<string | null> {
  try {
    const file = getStorePath(account);
    const raw = await fs.readFile(file, "utf-8");
    const data = JSON.parse(raw) as HistoryState;
    return data.historyId;
  } catch {
    return null;
  }
}

export async function saveHistoryId(account: string, historyId: string): Promise<void> {
  const file = getStorePath(account);
  const dir = path.dirname(file);
  
  await fs.mkdir(dir, { recursive: true });
  
  const data: HistoryState = {
    historyId,
    lastSync: Date.now(),
  };
  
  await fs.writeFile(file, JSON.stringify(data, null, 2), "utf-8");
}
