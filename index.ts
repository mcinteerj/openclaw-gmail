import type { ClawdbotPluginApi } from "clawdbot/plugin-sdk";
import { gmailPlugin } from "./src/channel.js";

import { setGmailRuntime } from "./src/runtime.js";

const plugin = {
  ...gmailPlugin,
  register: (api: ClawdbotPluginApi) => {
    setGmailRuntime(api.runtime);
    api.registerChannel(gmailPlugin);
  }
};

export default plugin;
