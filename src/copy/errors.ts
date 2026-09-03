// User-facing error strings.

export const msgInvalidDate = (): string =>
  `I couldn't read that date. Try one of:\n` +
  `• *17 April*\n` +
  `• *1992-04-17*\n` +
  `• *17/04/1992*`;

export const msgGenericError = (): string =>
  `Something went wrong on my end. Give me a moment and try again.`;

// Sent to the user when a handler throws mid-dispatch so a crashing handler
// produces a single graceful reply instead of silence.
export const msgHandlerError = (): string =>
  `Sorry — something went wrong on our end. Send *menu* to start over.`;

// Sent when the conversation state could not be read from the database
// (transient blip, retried and still failing). The engine deliberately does
// NOT fabricate an empty state — that would silently demote a mid-flow user
// to 'idle'. Being explicit is the whole point: the durable row is untouched,
// so resending resumes the flow.
export const msgStateLoadFailed = (): string =>
  `I couldn't load our conversation just then — my database blinked. 😵‍💫

` +
  `Nothing was lost. Please send that last message again.`;
