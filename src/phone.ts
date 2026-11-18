// Brazilian WhatsApp numbers and the 9th digit: an account's JID keeps the form it was registered with, often the
// 12-digit one without the 9, while people write their number with it. Compare both sides without the 9.

/** A Brazilian mobile without the 9 after the area code: 55 DD 9XXXXXXXX -> 55 DD XXXXXXXX (only 13-digit 55 numbers change). */
export const withoutNinthDigit = (phone: string): string => phone.replace(/^55(\d{2})9(\d{8})$/, "55$1$2");

/** Same WhatsApp account whichever form (with or without the 9) each side uses. */
export const samePhone = (a: string, b: string): boolean => withoutNinthDigit(a) === withoutNinthDigit(b);
