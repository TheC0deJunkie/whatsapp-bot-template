// Profile flow copy.

export const msgProfileCard = (
  firstName: string,
  surname: string | null | undefined,
  phone: string,
): string =>
  `*Your profile*\n\n` +
  `• *Name:* ${firstName}${surname ? ` ${surname}` : ''}\n` +
  `• *Phone:* ${phone}`;

export const msgAskNewName = (): string =>
  "What's your new *full name*? (first and last)";

export const msgNameUpdated = (firstName: string): string =>
  `Done — I'll call you ${firstName} from now on. ✅`;
