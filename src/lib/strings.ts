/**
 * Every user-facing string in the app lives here, as whole sentences rather
 * than fragments assembled at the call site. That makes translation later a
 * data change to this one module instead of a refactor scattered across
 * components.
 */
export const strings = {
  studio: {
    heading: "BookReel",
    subheading: "Your episodes",
    loading: "Loading episodes…",
    loadError: "Could not load your episodes. Try reloading the page.",
    empty: "No episodes yet — upload some book pages to make your first one.",
  },
} as const;
