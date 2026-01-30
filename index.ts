import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { gmailPlugin } from "./src/channel.js";

import { setGmailRuntime } from "./src/runtime.js";

const plugin = {
  ...gmailPlugin,
  register: (api: OpenClawPluginApi) => {
    setGmailRuntime(api.runtime);
    api.registerChannel(gmailPlugin);
  }
};

export default plugin;
