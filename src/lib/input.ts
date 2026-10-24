/**
 * For text that must stay exactly as typed: names, hosts, users, filters, cell values. Without it
 * macOS corrects spelling and capitalizes the first letter ("asset" becomes "Asset").
 */
export const exact = { spellCheck: false, autoCorrect: "off", autoCapitalize: "off" } as const;
