import { type ChannelThreadingAdapter } from "openclaw/plugin-sdk";

export const gmailThreading: ChannelThreadingAdapter = {
  buildToolContext: ({ context, hasRepliedRef }) => ({
    currentThreadTs: context.ReplyToId,
    hasRepliedRef,
  }),
};
