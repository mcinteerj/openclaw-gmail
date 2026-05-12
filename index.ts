import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { gmailPlugin } from "./src/channel.js";
import { setGmailRuntime } from "./src/runtime.js";

export default defineChannelPluginEntry({
  id: "openclaw-gmail",
  name: "Gmail",
  description: "Gmail channel plugin for OpenClaw - direct API or gog CLI",
  plugin: gmailPlugin,
  registerFull(api) {
    setGmailRuntime(api.runtime);
  },
});
