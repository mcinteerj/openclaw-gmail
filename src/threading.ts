import { type ChannelThreadingAdapter } from "openclaw/plugin-sdk/compat";

export const gmailThreading: ChannelThreadingAdapter = {
  buildToolContext: ({ context, hasRepliedRef }) => ({
    currentThreadTs: context.ReplyToId,
    hasRepliedRef,
  }),
};
