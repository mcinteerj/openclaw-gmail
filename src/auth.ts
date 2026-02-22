import { OAuth2Client } from "google-auth-library";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { execFile } from "node:child_process";
import type { OpenClawConfig } from "openclaw/plugin-sdk";

export interface OAuthCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

/**
 * Read gog CLI's credentials.json to reuse its OAuth client_id/client_secret.
 * Returns null if the file doesn't exist or is malformed.
 */
export function readGogCredentials(): { clientId: string; clientSecret: string } | null {
  const credPath = path.join(os.homedir(), ".config", "gogcli", "credentials.json");
  try {
    const raw = fs.readFileSync(credPath, "utf-8");
    const data = JSON.parse(raw);
    if (typeof data.client_id === "string" && typeof data.client_secret === "string") {
      return { clientId: data.client_id, clientSecret: data.client_secret };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve OAuth credentials from config, falling back to gog's credentials.json
 * for client_id/client_secret.
 *
 * Returns full credentials (including refreshToken) only if all three parts are available.
 * Returns null if refresh token is missing (caller should run the OAuth flow).
 */
export function resolveOAuthCredentials(
  accountEmail: string,
  cfg: OpenClawConfig,
): OAuthCredentials | null {
  const accounts = (cfg.channels as any)?.["openclaw-gmail"]?.accounts;
  const account = accounts?.[accountEmail] ?? Object.values(accounts ?? {}).find(
    (a: any) => a.email === accountEmail,
  );

  const oauth = (account as any)?.oauth;
  if (oauth?.clientId && oauth?.clientSecret && oauth?.refreshToken) {
    return {
      clientId: oauth.clientId,
      clientSecret: oauth.clientSecret,
      refreshToken: oauth.refreshToken,
    };
  }

  // If we have a refresh token in config but client creds come from gog
  if (oauth?.refreshToken) {
    const gogCreds = readGogCredentials();
    if (gogCreds) {
      return {
        clientId: oauth.clientId || gogCreds.clientId,
        clientSecret: oauth.clientSecret || gogCreds.clientSecret,
        refreshToken: oauth.refreshToken,
      };
    }
  }

  return null;
}

/**
 * Resolve just the client_id/client_secret pair (without refresh token).
 * Useful for initiating the OAuth flow.
 */
export function resolveClientCredentials(
  accountEmail: string,
  cfg: OpenClawConfig,
): { clientId: string; clientSecret: string } | null {
  const accounts = (cfg.channels as any)?.["openclaw-gmail"]?.accounts;
  const account = accounts?.[accountEmail] ?? Object.values(accounts ?? {}).find(
    (a: any) => a.email === accountEmail,
  );

  const oauth = (account as any)?.oauth;
  if (oauth?.clientId && oauth?.clientSecret) {
    return { clientId: oauth.clientId, clientSecret: oauth.clientSecret };
  }

  return readGogCredentials();
}

/**
 * Create an authenticated OAuth2Client with auto-refresh.
 */
export function createOAuth2Client(creds: OAuthCredentials): OAuth2Client {
  const client = new OAuth2Client(creds.clientId, creds.clientSecret);
  client.setCredentials({ refresh_token: creds.refreshToken });
  return client;
}

/**
 * Open a URL in the user's default browser.
 */
function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : "xdg-open";
  execFile(cmd, [url], (err) => {
    if (err) {
      // If browser open fails, the URL is already printed to console
    }
  });
}

/**
 * Run the browser-based OAuth2 consent flow.
 *
 * 1. Starts a local HTTP server on 127.0.0.1
 * 2. Opens the consent URL in the user's browser
 * 3. Waits for the redirect callback with the auth code
 * 4. Exchanges the code for tokens
 * 5. Returns the refresh_token
 */
export async function runOAuthFlow(
  clientId: string,
  clientSecret: string,
  opts?: { port?: number },
): Promise<string> {
  const port = opts?.port ?? 0; // 0 = OS picks a free port

  return new Promise<string>((resolve, reject) => {
    const server = http.createServer();

    const timeout = setTimeout(() => {
      server.close();
      reject(new Error("OAuth flow timed out after 5 minutes"));
    }, 5 * 60 * 1000);

    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        clearTimeout(timeout);
        server.close();
        reject(new Error("Failed to start local OAuth server"));
        return;
      }

      const redirectUri = `http://127.0.0.1:${addr.port}/callback`;
      const oauth2Client = new OAuth2Client(clientId, clientSecret, redirectUri);

      const authUrl = oauth2Client.generateAuthUrl({
        access_type: "offline",
        scope: ["https://mail.google.com/"],
        prompt: "consent",
      });

      console.log(`\nOpen this URL in your browser to authorize:\n\n  ${authUrl}\n`);
      openBrowser(authUrl);

      server.on("request", async (req, res) => {
        if (!req.url?.startsWith("/callback")) {
          res.writeHead(404);
          res.end("Not found");
          return;
        }

        const url = new URL(req.url, `http://127.0.0.1:${addr.port}`);
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");

        if (error) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end("<h1>Authorization denied</h1><p>You can close this tab.</p>");
          clearTimeout(timeout);
          server.close();
          reject(new Error(`OAuth authorization denied: ${error}`));
          return;
        }

        if (!code) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end("<h1>Missing authorization code</h1>");
          return;
        }

        try {
          const { tokens } = await oauth2Client.getToken(code);
          if (!tokens.refresh_token) {
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end("<h1>Error</h1><p>No refresh token received. Try revoking access at <a href='https://myaccount.google.com/permissions'>Google Account Permissions</a> and retry.</p>");
            clearTimeout(timeout);
            server.close();
            reject(new Error("No refresh_token received. Revoke app access and retry with prompt=consent."));
            return;
          }

          res.writeHead(200, { "Content-Type": "text/html" });
          res.end("<h1>Authorization successful!</h1><p>You can close this tab and return to the terminal.</p>");
          clearTimeout(timeout);
          server.close();
          resolve(tokens.refresh_token);
        } catch (err) {
          res.writeHead(500, { "Content-Type": "text/html" });
          res.end("<h1>Token exchange failed</h1><p>Check the terminal for details.</p>");
          clearTimeout(timeout);
          server.close();
          reject(err);
        }
      });
    });

    server.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}
