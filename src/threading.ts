import { type ChannelThreadingAdapter } from "moltbot/plugin-sdk";

export const gmailThreading: ChannelThreadingAdapter = {
  buildToolContext: ({ context, hasRepliedRef }) => ({
    currentThreadTs: context.ReplyToId,
    hasRepliedRef,
  }),
};
