// Shared back/menu affordance footer. Appended verbatim to every multi-step
// prompt so users always know the escape hatch.
//
// Italic via underscores; *back* / *menu* bold. Two leading newlines isolate
// the footer from the prompt body. WhatsApp renders both reliably on iOS+Android.
export const FOOTER_BACK_MENU = '\n\n_Type *back* or *menu* anytime._';
