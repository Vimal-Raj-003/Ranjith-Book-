/**
 * Every user-facing string in the app lives here, as whole sentences rather
 * than fragments assembled at the call site. That makes translation later a
 * data change to this one module instead of a refactor scattered across
 * components.
 *
 * This module has NO imports, and must keep it that way: it is read by
 * `"use client"` components, so anything it pulled in would land in the
 * browser bundle. That is why the voice catalogue below is a hand-copied
 * transcription of `src/lib/media/pocket-tts.ts` rather than an import of it —
 * that module spawns a local model server and cannot resolve in a browser.
 * `tests/strings-voices.test.mts` compares the two, so the copy cannot drift.
 */

/** A voice the narrator can use. Ids match `POCKET_VOICES` in pocket-tts.ts. */
export interface VoiceOption {
  id: string;
  label: string;
  gender: "female" | "male";
  note: string;
}

export const VOICES: VoiceOption[] = [
  { id: "alba", label: "Alba", gender: "female", note: "warm, casual" },
  { id: "cosette", label: "Cosette", gender: "female", note: "expressive, animated" },
  { id: "vera", label: "Vera", gender: "female", note: "clear, even-paced" },
  { id: "jane", label: "Jane", gender: "female", note: "bright, friendly" },
  { id: "eve", label: "Eve", gender: "female", note: "calm, measured" },
  { id: "caro_davy", label: "Caro", gender: "female", note: "conversational" },
  { id: "michael", label: "Michael", gender: "male", note: "steady, documentary" },
  { id: "charles", label: "Charles", gender: "male", note: "deep, deliberate" },
  { id: "paul", label: "Paul", gender: "male", note: "natural, everyday" },
  { id: "george", label: "George", gender: "male", note: "crisp, energetic" },
  { id: "stuart_bell", label: "Stuart", gender: "male", note: "narrator tone" },
  { id: "peter_yearsley", label: "Peter", gender: "male", note: "mature, warm" },
];

export const DEFAULT_VOICE_ID = "charles";

/**
 * What to call the voice an episode was narrated with, or null when none was
 * recorded.
 *
 * The lookup is keyed off `provider`, not off the id: only a Pocket voice is in
 * `VOICES`, and another provider's id is not a catalogue key. Looked up there
 * anyway, an OpenAI voice that happened to be spelled like a Pocket one would be
 * shown under Pocket's name. So only a Pocket id is turned into a name; any
 * other is shown as it was recorded, which is also what a Pocket voice since
 * dropped from the catalogue gets.
 *
 * Falsy, not just null, is "not recorded": `resolveVoice` hands back "" for a
 * provider with no stored voice, and a blank name would read as a rendering bug.
 */
export function recordedVoiceName(
  provider: string | null | undefined,
  id: string | null | undefined,
): string | null {
  if (!id) return null;
  if (provider !== "pocket") return id;
  return VOICES.find((v) => v.id === id)?.label ?? id;
}

/** Visual themes. All five are built and selectable; so is `auto`, below. */
export interface ThemeOption {
  id: string;
  label: string;
  note: string;
  available: boolean;
  /** The music bed this theme's mood produces — see MOOD_TO_STYLE in pipeline.ts. */
  music: string;
  /**
   * The preview card's two lines: what the theme looks like, and the kind of
   * book it suits. A hand-copy of the `meta` on the theme module itself, for
   * the same reason `VOICES` above is a hand-copy of `POCKET_VOICES` — the
   * inspector is `"use client"`, a theme module reaches `build.ts`, and that
   * import would land the whole compositor in the browser bundle.
   * `tests/themes.test.mts` compares the two, for every theme that carries a
   * `meta`, so the copy cannot drift.
   *
   * Optional, not required, for two separate reasons. `AUTO_THEME_OPTION` below
   * is not a theme and has no `meta` to copy. And the five themes that shipped
   * first were left ENTIRELY untouched by the theme-engine work — no `meta`, no
   * recompile, not one byte of their modules changed — so their two lines are
   * written here and only here. See `tests/theme-compat.test.mts`.
   */
  description?: string;
  bestFor?: string;
}

/**
 * Note the split every panel in the inspector now follows: a short line that
 * is always on screen, and the honest long-form paragraph kept beside it under
 * a `…More` / `…Details` key. Nothing was deleted to make the app fit in one
 * window — the sentences moved behind a `<summary>`.
 */
export const VIDEO_THEMES: ThemeOption[] = [
  {
    id: "marginalia", label: "Marginalia", note: "Warm paper, hand-drawn marker", available: true,
    music: "Editorial — warm, gentle",
    description: "A warm desk, cream paper and a felt-tip yellow that bleeds past the words.",
    bestFor: "A book being studied — notes, lessons, passages worth underlining.",
  },
  {
    id: "terminal", label: "Terminal", note: "Dark, developer-native", available: true,
    music: "Terminal — sparse, unhurried",
    description: "Deep graphite, phosphor mint, monospace everywhere — a screen at 2am.",
    bestFor: "Software, machines, data — work done alone at a keyboard.",
  },
  {
    id: "editorial", label: "Editorial", note: "Magazine feature", available: true,
    music: "Editorial — warm, gentle",
    description: "An ecru press sheet, a masthead rule, an editor's vermillion pencil.",
    bestFor: "People and culture — a reported story, a profile, an argument.",
  },
  {
    id: "spotlight", label: "Spotlight", note: "Punchy, made for Shorts", available: true,
    music: "Spotlight — driving, punchy",
    description: "Near-black, one hot accent and a beam — the loudest theme here.",
    bestFor: "Ambition and performance — money, business, winning, risk.",
  },
  {
    id: "blueprint", label: "Blueprint", note: "Calm, documentary", available: true,
    music: "Blueprint — calm, documentary",
    description: "Deep indigo, a two-scale grid and registration marks on a drafting table.",
    bestFor: "How something is made and proved — design, method, evidence.",
  },

  /* --- the six from the theme engine (2026-10-05) -------------------------
   * Each one's `description` and `bestFor` is a hand-copy of the `meta` on its
   * own module; `music` names the bed its `musicMood` asks for, which for five
   * of these six is a bed the old four-value enum could not reach at all.
   */
  {
    id: "academia", label: "Dark Academia", note: "Library at night, brass and walnut", available: true,
    music: "Nocturne — minor 7ths, very low movement",
    description: "Walnut dark, brass lamplight, old-style serif on aged ivory, a sepia underline.",
    bestFor: "Philosophy, history, the classics — anything read slowly.",
  },
  {
    id: "atelier", label: "Luxury Editorial", note: "Ivory, charcoal and gold", available: true,
    music: "Resolve — root-position major triads, slow",
    description: "Ivory on flat charcoal, a didone headline, gold as a hairline, uppercase captions.",
    bestFor: "Design, style, money — a book you want to look expensive.",
  },
  {
    id: "dossier", label: "Documentary", note: "Cold slate, broadcast subtitles", available: true,
    music: "Vista — wide, cinematic, unhurried",
    description: "Cold slate, a neutral sheet, signal amber, and real broadcast subtitles.",
    bestFor: "Reported books, biography, science — where the page is evidence.",
  },
  {
    id: "quiet", label: "Premium Minimal", note: "Gallery white, no effects", available: true,
    music: "Stark — open fifths, no third",
    description: "Gallery white, a tight grotesque at scale, one hairline, the quietest motion here.",
    bestFor: "Design, productivity, essays — a book that wants room to breathe.",
  },
  {
    id: "storybook", label: "Vintage Storybook", note: "Moss board, foxed cream paper", available: true,
    music: "Editorial — warm, gentle",
    description: "Moss board, foxed cream paper, brick red, a pencil wash under the words.",
    bestFor: "Fables, memoir, anything with a narrator and a long time ago.",
  },
  {
    id: "neon", label: "Futuristic Neon", note: "Violet panel, magenta and cyan", available: true,
    music: "Tension — minor seconds held against the root",
    description: "Violet ground under scanlines, magenta and cyan bloom, a marker that glows.",
    bestFor: "Technology, the future, and anything meant to stop a thumb.",
  },
];

/**
 * The default choice, and the only one that is not a theme: let each video be
 * skinned to what it is about (`src/lib/video/composition/themes/choose.ts`).
 *
 * Why it is a separate constant and not a sixth entry in `VIDEO_THEMES`: that
 * list is the registry's five, and `tests/themes.test.mts` asserts the two agree
 * exactly — "the registry and the picker have drifted apart" is a real bug this
 * codebase has shipped (spec §17) and the assertion is what catches it. "auto"
 * resolves to no theme at all, so putting it in that list would either break
 * that check or force it to be loosened. `id` must stay equal to
 * `THEME_SETTING_AUTO`; this module cannot import it (see the header — no
 * imports, ever), so a test compares the two instead.
 */
export const AUTO_THEME_OPTION: ThemeOption = {
  id: "auto",
  label: "Auto — from the book",
  note: "Each video is skinned to what it is about",
  available: true,
  music: "Follows each video's own theme",
};

export const strings = {
  app: {
    brand: "BookReel",
    tagline: "Book pages in, video out.",
    skipToContent: "Skip to main content",
  },
  nav: {
    label: "Sections",
    studio: "Studio",
    books: "Book PDFs",
    library: "Library",
    freeBooks: "Free books",
    queue: "Queue",
    comingSoon: "Soon",
    comingSoonHint: "Not built yet",
  },
  /**
   * The workspace shell: the two rails, and what each says once it is folded
   * away. A collapsed rail is never silent — every chip in it carries one of
   * these as its accessible name and its tooltip, because at 50px wide the
   * name is the only thing left of the control.
   */
  layout: {
    sectionsRail: "Sections",
    settingsRail: "Settings",
    /**
     * The toggles' names do NOT change with their state. The button carries
     * `aria-expanded`, which a screen reader already reads as "collapsed" or
     * "expanded"; naming it "Collapse the sections rail" as well produces
     * "Collapse the sections rail, expanded, button" — the state said twice,
     * once as an instruction and once as a fact, which is how a name and a
     * state end up contradicting each other.
     */
    toggleSections: "Sections rail",
    toggleSettings: "Settings rail",
    /** On a chip in the folded settings rail: what it says, and what clicking does. */
    openSettingsFor: (summary: string) => `${summary} — open the settings rail`,
    /** The folded sections rail: the same nav, as glyphs. */
    goTo: (label: string) => `Go to ${label}`,
  },
  account: {
    label: "Account",
    signOut: "Sign out",
    signingOut: "Signing out…",
    signOutError: "Could not sign out. Try again.",
  },
  themeToggle: {
    label: "Appearance",
    toLight: "Switch to the light theme",
    toDark: "Switch to the dark theme",
    light: "Light",
    dark: "Dark",
  },
  studio: {
    heading: "BookReel",
    subheading: "Your episodes",
    workbenchIntro: "Pages in, video out.",
    workbenchHelpSummary: "How this works",
    workbenchHelp:
      "Photograph the pages you want, add them below in reading order, and start the ingest. The pipeline reads them, writes a script, records the narration and renders a 9:16 video. Progress appears under the upload form; the finished video appears in the preview beside it.",
    loading: "Loading episodes…",
    loadError: "Could not load your episodes. Try reloading the page.",
    empty: "No episodes yet — upload some book pages to make your first one.",
    untitled: "Untitled",
  },
  upload: {
    sectionHeading: "Add book pages",
    dropHint: "Drag photographs here, or",
    chooseFiles: "Choose files",
    titleLabel: "Book title",
    titlePlaceholder: "e.g. Atomic Habits",
    bookLinkLabel: "Book link (optional)",
    bookLinkPlaceholder: "https://…  where people can buy it",
    bookLinkHint: "Adds a buy card and a link in the description.",
    bookLinkMoreSummary: "More about the link",
    bookLinkMore:
      "Leave it blank and neither the card nor the link appears. Only web addresses starting http:// or https:// are kept — anything else is ignored, and your upload still goes through.",
    rightsLabel: "Rights status",
    rightsOptions: {
      "public-domain": "Public domain",
      "in-copyright": "Still in copyright",
      "own-work": "My own work",
    } as Record<string, string>,
    emptyHint: "No photographs added yet.",
    readyAnnouncement: (n: number) => (n === 1 ? "1 photograph ready" : `${n} photographs ready`),
    pageLabel: (n: number) => `Page ${n}`,
    thumbAlt: (n: number) => `Photograph for page ${n}`,
    removePage: (n: number) => `Remove page ${n}`,
    moveUp: (n: number) => `Move page ${n} up`,
    moveDown: (n: number) => `Move page ${n} down`,
    uploadButton: "Upload pages",
    uploading: "Uploading…",
    ingestButton: "Ingest these pages",
    ingestStarting: "Starting…",
    ingestStarted: "Ingest started — watch its progress below.",
    ingestError: "Could not start ingest. Try again.",
    uploadSuccess: (n: number) => (n === 1 ? "1 page uploaded." : `${n} pages uploaded.`),
    genericError: "The upload could not be completed. Try again.",
    noTitleError: "Give the book a title before uploading.",
    noPhotosError: "Add at least one photograph before uploading.",
  },
  run: {
    heading: "Runs",
    ingestHeading: "Reading your pages",
    /** The compressed rail: "Step 7 of 14", then the stage's own name. */
    stepCount: (index: number, total: number) => `Step ${index} of ${total}`,
    notStarted: "Not started",
    stepRunning: "running",
    allSteps: "All steps",
    notesSummary: (n: number) => (n === 1 ? "1 note" : `${n} notes`),
    videoReady: "Your video is ready.",
    /** The Publish button on a finished episode card, and the dialog it opens. */
    publish: "Publish",
    publishTitle: (title: string) => `Publish — ${title}`,
    publishDisabledHint: "Publishing opens once the video has finished rendering.",
    publishClose: "Close",
    episodeLabel: (part: number, total: number) => (total > 1 ? `Episode ${part} of ${total}` : "Episode"),
    failed: "This run failed.",
    cancelled: "This run was cancelled.",
    loadError: "This episode could not be loaded. It may have been removed.",
    select: (title: string) => `Show ${title} in the preview`,
    selected: "Showing in the preview",
    cancelGeneration: "Cancel generation",
    cancelling: "Cancelling…",
    cancelError: "Could not cancel that run. Try again.",
    /** The recovery button on a FAILED episode card: re-runs that one episode. */
    regenerate: "Regenerate",
    retrying: "Retrying…",
    retryError: "Could not regenerate that video. Try again.",
    statusLabel: (status: string) =>
      ({
        QUEUED: "Queued",
        RUNNING: "Running",
        DONE: "Done",
        FAILED: "Failed",
        CANCELLED: "Cancelled",
      })[status] ?? status,
  },
  preview: {
    heading: "Preview",
    aspectNote: "9:16 — Shorts and Reels",
    none: "Nothing to preview yet. Start a run, or pick an episode from your library.",
    building: "The video appears here the moment the render finishes.",
    failed: "This run failed before a video was rendered.",
    cancelled: "This run was cancelled before a video was rendered.",
    unsupported: "Your browser cannot play this video. Download it instead.",
    download: "Download video",
    loadError: "This video could not be loaded. Try reloading the page, or download it directly.",
  },
  publish: {
    /** Doubles as the `<summary>`: the whole panel is collapsed by default,
     *  because four boxes of pastable text is most of a laptop screen. */
    heading: "Ready to post",
    youtubeTitle: "YouTube title",
    youtubeDescription: "YouTube description",
    hashtags: "Hashtags",
    instagram: "Instagram caption",
    empty: "Caption text for this episode is not available yet.",
    partial: "This episode has no description or hashtags saved, so only what exists is shown.",
    waiting: "The caption text is written partway through the run and appears here when it does.",
  },
  /**
   * The Publish Center.
   *
   * `publish` above is deliberately untouched: those seven strings label the
   * four copy blocks the operator has been pasting from for months, and the new
   * surface keeps every one of them working. This block is everything the
   * surface added around them.
   *
   * Every sentence here is written on the assumption that NOTHING IS CONNECTED,
   * because nothing is. There is no "Publishing…", no "Posted", no progress
   * wording of any kind for work that is not happening — the state is named
   * plainly and the operator is told exactly what they must do by hand and what
   * a connection would later do for them.
   */
  publishCenter: {
    heading: "Publish",
    none: "Pick a finished episode to publish it.",
    /** The verdict, as the badge beside the heading. */
    ready: "READY TO PUBLISH",
    notReady: "NOT READY",
    missingOne: "One thing is missing before this can be published:",
    missingMany: (n: number) => `${n} things are missing before this can be published:`,
    stale:
      "This server is running an older database client that does not know about publish state yet. Restart the dev server and this panel will work.",
    loadFailed: "The publish state for this episode could not be loaded.",
    retry: "Try again",

    assetsHeading: "What goes out",
    videoLabel: "Video",
    lengthLabel: "Length",
    posterLabel: "Selected poster",
    noVideoYet: "No rendered video yet.",
    noPosterYet: "This episode has no poster.",
    publishedLabel: "Published",
    platformIdLabel: "Platform id",
    openOn: (platform: string) => `Open on ${platform}`,
    noValue: "—",
    posterAlt: (title: string) => `Selected poster for ${title}`,
    durationValue: (seconds: number) => `${Math.round(seconds)}s`,
    sizeValue: (bytes: number) =>
      bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`,
    downloadVideo: "Download video",
    downloadPoster: "Download poster",
    unsupported: "Your browser cannot play this video. Download it instead.",

    metadataHeading: "Metadata",
    metadataHint:
      "What the pipeline wrote, for you to edit. Saving keeps your words; Rewrite asks the writer for new ones from the book and this episode's own script.",
    titleLabel: "Title",
    descriptionLabel: "Description",
    hashtagsLabel: "Hashtags",
    hashtagsHint: "One line, separated by spaces. A missing # is added for you; a repeat is dropped.",
    save: "Save",
    saving: "Saving…",
    savedToast: "Saved.",
    saveFailed: "That edit could not be saved.",
    /** "Rewrite" is the wireframe's word for the per-field Regenerate: the same action, the same route. */
    regenerate: "Rewrite",
    regenerating: "Rewriting…",
    regeneratedToast: (field: string) => `New ${field} written.`,
    /** Shown beside a field the operator has typed over. */
    handEdited: "Your words",
    asWritten: "As written",
    /** The confirmation a hand-edited field demands before Rewrite replaces it. */
    confirmBody: (field: string) => `You edited this ${field} by hand. Rewriting replaces what you wrote.`,
    confirmYes: "Replace it",
    confirmNo: "Keep mine",
    counter: (n: number, limit: number) => `${n} / ${limit}`,
    tagCounter: (n: number, limit: number) => `${n} / ${limit} tags`,
    overBy: (over: number) => `${over} over`,
    /** The long-call warning on Rewrite: it is a real model call. */
    regenerateHint:
      "Rewrite asks the writer for new words and can take a minute or two. Nothing is changed unless it answers.",

    platformsHeading: "Platforms",
    /**
     * The status vocabulary, in the operator's words. Keys are the values in
     * `src/lib/publish/limits.ts`; `tests/publish.test.mts` compares the two, so
     * a status added there cannot ship without a label here (the bug would be an
     * empty badge).
     */
    statusLabel: {
      NOT_READY: "Not ready",
      READY: "Ready",
      REQUIRES_CONNECTION: "Requires connection",
      QUEUED: "Queued",
      PREPARING: "Preparing",
      UPLOADING: "Uploading",
      AWAITING_HUMAN: "Needs you",
      SCHEDULED: "Scheduled",
      PUBLISHED: "Published",
      FAILED: "Failed",
    } as Record<string, string>,
    /** What each status MEANS, so "Requires connection" is not left to be guessed at. */
    statusNote: {
      NOT_READY: "This episode is not finished, or something it needs is missing.",
      READY: "This platform is connected and this episode would be accepted.",
      REQUIRES_CONNECTION:
        "Nothing is connected to this platform, so this app cannot post for you. Everything is ready to hand over — do the upload yourself in the platform's own uploader.",
      PREPARING: "The upload is being prepared.",
      QUEUED: "The approved upload is saved in the publishing queue.",
      UPLOADING: "The upload is in progress.",
      AWAITING_HUMAN:
        "The browser window stopped for you: a sign-in or security check needs a person, or what happened is not known. It is never retried automatically.",
      SCHEDULED: "The platform confirmed this post is scheduled. Nothing is live yet.",
      PUBLISHED: "The platform confirmed this post.",
      FAILED: "The last attempt was refused.",
    } as Record<string, string>,
    /**
     * The OPTIONAL browser-window route, beside the API. Every sentence is plain
     * about three things: it opens a real window you may have to sign in to, it
     * drives a website (which can break, and which the platform's terms may not
     * welcome), and the official API stays the recommended way.
     */
    browser: {
      eyebrow: "Browser window",
      optional: "Optional",
      intro: (platform: string) =>
        `Opens a real browser window on the computer running BookReel and posts through ${platform}'s own website. ` +
        "You may have to sign in the first time, in that window, and clear any security check yourself: BookReel never types your password and never tries to get past a check.",
      recommend:
        "The official API above is the recommended route. This one drives a website, which can break whenever the site changes and which the platform's terms may not welcome.",
      unavailable: "This route is not available on this server.",
      /**
       * The same route when BOOKREEL_PUBLISH_CHROME_CDP is set: nothing is launched,
       * BookReel attaches to a Chrome the operator started and signed in to. Plain
       * about what it does NOT do -- it does not manage that Chrome, read its
       * profile, or close it.
       */
      attachIntro: (platform: string, endpoint: string) =>
        `Attaches to your own Chrome (the one you started with remote debugging, at ${endpoint}) and posts through ${platform}'s own website in a new tab there. ` +
        "BookReel never types or stores your password, never reads or copies your Chrome profile, and never tries to get past a check: if you are asked to sign in or verify, do it in that tab, then press Retry.",
      attachStepsHeading: "How to use your own Chrome",
      attachSteps: (platform: string, port: string) => [
        "Quit Chrome completely (every window).",
        `Start it again with remote debugging and its own profile folder, for example: chrome.exe --remote-debugging-port=${port} --user-data-dir="%LOCALAPPDATA%\\bookreel-chrome". Chrome 136 and later ignore remote debugging on the default profile, so the --user-data-dir is required.`,
        `In that Chrome, sign in to ${platform} yourself. For YouTube, pick the channel this install publishes to (@betweenpages08-l4d unless BOOKREEL_YOUTUBE_HANDLE says otherwise): BookReel stops if it is a different one.`,
        "Keep that Chrome open, then publish. Choose Private for a first test.",
      ],
      attachNote: "BookReel leaves its tab open in your Chrome and never closes your browser.",
      /**
       * The same route when BOOKREEL_PUBLISH_BROWSER_CHANNEL is set: BookReel opens the
       * browser INSTALLED on this computer, on a profile of its own. Plain about what that
       * is (a real Chrome, not your personal one) and what it is not (not hidden from the
       * site as automated, so a sign-in may still be refused).
       */
      channelIntro: (platform: string, browser: string) =>
        `Opens your installed ${browser} in a window of its own, on a dedicated BookReel profile (not your personal ${browser} profile), and posts through ${platform}'s own website. ` +
        "Sign in yourself the first time, in a normal window, and clear any security check yourself. " +
        "BookReel never types or stores your password, never copies cookies, never reuses your personal profile, and never tries to get past a check.",
      channelName: { chrome: "Google Chrome", msedge: "Microsoft Edge" } as Record<string, string>,
      channelYouTube:
        "For YouTube, sign in with the account that owns the channel and pick the channel this install publishes to (@betweenpages08-l4d unless BOOKREEL_YOUTUBE_HANDLE says otherwise): BookReel stops if it is a different one.",
      channelNote:
        "BookReel does not hide that its publishing window is automated, so Google may refuse a sign-in typed into it: that is why you sign in once in a normal window (the button below) and the publishing window reuses it. If Google still refuses, use your own Chrome instead (BOOKREEL_PUBLISH_CHROME_CDP).",
      /**
       * YouTube's one-time sign-in, in channel mode. The button opens a PLAIN Chrome (no automation, no
       * debugging port) on the same dedicated profile the publishing window later opens, so the session
       * saved there is the one the publish reuses. Plain about what it is and is not: not the personal
       * Chrome, no password typed or stored, no cookie copied, and it must be closed before publishing.
       */
      signIn: {
        heading: "Sign in to YouTube once",
        button: "Sign in to YouTube",
        opening: "Opening Chrome…",
        intro: (browser: string) =>
          "Google refuses a sign-in inside a window that an automation tool opened, so you sign in once in a normal one. " +
          `This opens a normal ${browser} on a dedicated BookReel profile (not your personal ${browser}). ` +
          "In it, open studio.youtube.com, sign in with the Google account that manages your channel and pick the channel @betweenpages08-l4d, then close that window and publish. " +
          "BookReel reuses that saved session: it never types or stores your password and never copies cookies.",
        closeFirst: "Close the sign-in window before you publish: the profile can only be open in one Chrome at a time. The session can expire; if it does, sign in again.",
        opened: "A normal Chrome window is opening on this computer. Sign in there, then close it and publish.",
        failed: "The sign-in window could not be opened.",
      },
      headless:
        "BOOKREEL_PUBLISH_HEADLESS is on, so the window is hidden and a sign-in or security check cannot be done in it: the job will stop and say so. Unset it and restart to sign in.",
      notOwned:
        "This episode does not belong to this account, so it cannot be posted from here. The hand-off below still works.",
      publish: "Publish via browser window",
      publishing: "Opening the window…",
      started: "The browser window is opening. Watch it, and sign in if it asks.",
      failed: "The browser publish could not be started.",
      working: "A browser window is working on this. The result is only recorded once the platform's own page confirms it.",
      kidsLegend: "Is this video made for kids?",
      kidsNote: "YouTube requires an answer and it is yours to give, so BookReel never picks one for you.",
      kidsNo: "No, it is not made for kids",
      kidsYes: "Yes, it is made for kids",
      visibilityLabel: "Visibility",
      visibilityPrivate: "Private (review in Studio)",
      visibilityUnlisted: "Unlisted",
      visibilityPublic: "Public",
      scheduleLabel: "Schedule for later (optional)",
      scheduleNote: "Scheduled posts go public at that time. Uses your computer's time zone.",
      igPublicNote:
        "Instagram has no private or draft post: sharing puts the Reel on your account, publicly, at once. Instagram's website cannot schedule it, so there is no schedule here.",
      confirmPublic: "This goes live without a review step and cannot be taken back from here. Post it?",
      confirmYes: "Yes, open the window and post",
      confirmNo: "Not now",
      stoppedHeading: "The browser window stopped for you",
      stoppedNote:
        "Look at the open window. If it was a sign-in or a security check, do it there. If the post may already be on the platform, check the platform first.",
      ackLabel: "I looked at the platform: the post is not there, or a sign-in was the only problem.",
      retry: "Retry in the browser window",
      retrying: "Opening the window…",
      alreadySeen: "A video was already seen on the platform, so this is not retried.",
      scheduledFor: (when: string) => `Scheduled for ${when} (as the platform read it back)`,
      scheduledId: "Platform id",
      viaBrowser: "Posted through the browser window",
    },
    /**
     * The Instagram account connection card. It is account-level, so it sits above the per-video
     * flow. Plain about what it does NOT do: it never types or stores a password, never gets past
     * a security check, never posts, and never turns a publishing flag on.
     */
    instagramConnect: {
      heading: "Instagram account",
      intro:
        "BookReel never sees your Instagram password. You sign in by hand in a normal Chrome window on BookReel's own profile, " +
        "and BookReel then looks, through that same profile, at which account is signed in and whether Instagram offers it Schedule content.",
      stateLabel: {
        not_connected: "Not Connected",
        connected: "Connected",
        eligible: "Eligible for Scheduling",
        not_eligible: "Not Eligible",
      },
      stateNote: {
        not_connected: "No verified Instagram account yet. Instagram publishing stays unavailable.",
        connected: "The right account is signed in. Whether it can schedule is not known yet.",
        eligible: "Instagram's composer offered Schedule content for this account.",
        not_eligible: "The right account is signed in, but Instagram does not offer it scheduling.",
      },
      signedInAs: "Signed in as",
      publishesTo: "Publishes to",
      accountType: "Account type",
      accountKind: {
        professional: "Professional",
        personal: "Personal",
        unknown: "Not determined",
      },
      scheduleContent: "Schedule content",
      composer: {
        offers_schedule: "Offered by Instagram",
        no_schedule_option: "Not offered",
        unreachable: "Could not reach the last screen",
        not_checked: "Not checked yet",
      },
      calendarLabel: "Scheduled posts",
      calendar: {
        readable: (n: number | null) => (n === null ? "Readable" : `Readable (${n} scheduled)`),
        unreadable: "Could not be read",
        not_checked: "Not checked yet",
      },
      lastChecked: "Last checked",
      never: "Never",
      stale: "That was over a week ago. Verify again before relying on it.",
      connect: "Connect Instagram",
      connectAgain: "Sign in again",
      connecting: "Opening Chrome…",
      verify: "Verify account",
      verifying: "Checking…",
      checkScheduling: "Check Schedule content",
      checkingScheduling: "Checking…",
      recheckScheduling: "Check Schedule content again",
      stepsHeading: "To connect",
      steps: (handle: string) => [
        "Press Connect Instagram. A normal Chrome window opens on BookReel's Instagram profile.",
        `In it, open instagram.com and sign in as ${handle} yourself. Clear any security check yourself.`,
        "Close that Chrome window.",
        "Press Verify account.",
      ],
      afterConnect: "Sign in there, then close that window and press Verify account.",
      /** Above the sentence the sign-in route sent back when it did NOT open a window you can see. */
      connectErrorHeading: "Chrome did not open",
      scheduleDisclosureHeading: "What the Schedule content check does",
      scheduleDisclosure:
        "It opens Instagram's Create, then Reel, and loads a short blank placeholder clip that BookReel makes itself (never one of your videos) " +
        "so the screen can reach its last page and show whether Schedule content is there. It never presses Share or Schedule, " +
        "discards the draft afterwards, and posts nothing. Instagram may process the clip while the screen is open.",
      scheduleConfirm: "I understand: nothing will be shared or scheduled.",
      attachNote:
        "BookReel is set to use your own Chrome (BOOKREEL_PUBLISH_CHROME_CDP). Sign in to Instagram in that Chrome; Connect Instagram is not used.",
      bundledNote:
        "Connect Instagram opens your installed Chrome. Set BOOKREEL_PUBLISH_BROWSER_CHANNEL=chrome and restart BookReel to use it.",
      headlessNote:
        "The browser is set to run hidden (BOOKREEL_PUBLISH_HEADLESS), so a security check could not be cleared. Unset it to verify.",
      browserNotReady: (why: string) => `The browser is not ready: ${why}`,
      running: "Checking Instagram…",
      runningNote: "A Chrome window opens on BookReel's Instagram profile while this runs. Leave it alone.",
      errorHeading: "The last check could not finish",
      loadFailed: "The Instagram connection could not be read.",
      retry: "Try again",
      flagsHeading: "Instagram publishing switches",
      flagsOff:
        "Both switches are off. They stay off until the account is verified and Eligible for Scheduling, and BookReel never changes them itself.",
      flagsPartial: "One switch is on and one is off. Set both, then restart BookReel.",
      flagsOn: "Both switches are on.",
      flagsNext: "To turn Instagram scheduling on, set these two lines in .env.local yourself, then restart BookReel:",
      flagsLines: ["BOOKREEL_INSTAGRAM_PUBLISH_ENABLED=1", "BOOKREEL_IG_NATIVE_SCHEDULE=1"],
      flagsBlocked:
        "A publishing switch is on, but this account is not Eligible for Scheduling yet. Turn it off in .env.local until it is.",
      fixAccount: "Switch the account to a professional (Business or Creator) account in Instagram, then press Verify account and Check Schedule content again.",
    },
    /** Named plainly, because an operator should know why a button is not there. */
    cannotUpload: "This app cannot upload to this platform yet.",
    requiresHeading: "A connection will need",
    problemsHeading: "This platform would refuse it:",
    handoffHeading: "Do it by hand",
    recordHandoff: "I handed this over",
    recording: "Recording…",
    recordHint:
      "Records that these exact words and files were handed over, and when. It does NOT post anything and never claims it did.",
    recordedAt: (when: string) => `Handed over ${when}`,
    recordedToast: "Handed-over record saved.",
    attemptsLabel: (n: number) => (n === 1 ? "1 handover" : `${n} handovers`),
    /** The honest caveat under the per-platform cards. */
    noConfirmation:
      "Nothing here can tell you whether a post went live: that needs a connection to the platform, which this build does not have.",
    openInNewTab: "Opens in a new tab",

    /* --- the metadata is now grouped by platform (2026-10-10) ---------------
     * The YouTube package gains a keyword-tags field distinct from hashtags,
     * and Instagram gains its own hook, caption and hashtags written for
     * Instagram rather than lifted from the YouTube description. */
    youtubePackageHeading: "YouTube",
    instagramPackageHeading: "Instagram",

    /** YouTube keyword tags — search keywords, not the `#` tags shown under a video. */
    tagsLabel: "Tags (keywords)",
    tagsHint:
      "Search keywords, comma-separated — not #hashtags. YouTube counts the whole line against a 500-character limit. A leading # is dropped for you.",
    copyTags: "Copy tags",

    /** The independent Instagram fields. */
    instagramIntro:
      "Written for Instagram, not copied from the YouTube description. Leave these blank to fall back to the caption composed from the hook, description and hashtags.",
    /** Shown while the episode has no Instagram copy of its own and the caption is still the derived one. */
    instagramDerivedNote:
      "No Instagram copy of its own yet — the caption below is composed from the YouTube hook, description and hashtags. Edit or regenerate a field to make Instagram independent.",
    igHookLabel: "Title / hook",
    igHookHint:
      "Instagram has no title field, so this is its title: the scroll-stopping opening line of the caption, written for a Reels audience. Not the YouTube title.",
    igCaptionLabel: "Caption",
    igHashtagsLabel: "Hashtags",

    /** Per-field copy buttons. */
    copyTitle: "Copy title",
    copyDescription: "Copy description",
    copyHashtags: "Copy hashtags",
    copyHook: "Copy hook",
    copyCaption: "Copy caption",
    copyFullCaption: "Copy full caption",
    copyField: "Copy",
    copyAll: "Copy all metadata",

    /* --- the tags and Instagram copy are written for you (2026-10-13) ------
     * The render writes YouTube tags and the three Instagram fields in one call
     * after the script is stored. An episode rendered before that has them
     * empty, so opening its panel asks once; these are the two states that
     * leaves on screen -- working, and failed with a way to try again -- so a
     * field is never just silently empty. */
    generatingYouTube: "Writing the YouTube tags from this episode's script…",
    generatingInstagram: "Writing the Instagram title, caption and hashtags from this episode's script…",
    generatingHint: "This is a model call and can take a minute or two. Anything you have already written is left alone.",
    generateFailed: "The missing copy could not be written.",
    generateStillEmpty: "The writer answered, but nothing was filled in.",
    generate: "Generate",
    generating: "Generating…",

    /* --- per-platform cover picker (reuses the six existing posters) -------- */
    thumbnailsHeading: "Thumbnails",
    thumbnailsHint:
      "Choose the cover for each platform. YouTube favours the wide 16:9 crops, Instagram the tall 9:16. Nothing new is generated here — these are this episode's existing posters.",
    thumbnailsEmpty:
      "This episode has no posters yet. They are drawn during the render; retitle or re-render the episode to make them.",
    thumbnailsLoadFailed: "The posters for this episode could not be loaded.",
    thumbUseYouTube: "Use for YouTube",
    thumbUseInstagram: "Use for Instagram",
    thumbYouTubeBadge: "YouTube",
    thumbInstagramBadge: "Instagram",
    thumbDownload: "Download",
    thumbAspect: (aspect: string) => `${aspect} crop`,
    thumbAlt: (aspect: string) => `${aspect} poster for this episode`,

    /**
     * The Publish page, laid out the way the wireframe draws it: header, video and
     * thumbnail, a YouTube block and an Instagram block, visibility, schedule, and the
     * three publish buttons. Every sentence here is a statement of what a press WILL do
     * or what the platform's own page CONFIRMED -- never what a request merely hoped for.
     */
    flow: {
      headingFor: (title: string | null) => (title && title.trim() !== "" ? `Publish – ${title.trim()}` : "Publish"),
      untitled: "Untitled video",

      /* The fields' buttons. "Rewrite" is the existing Regenerate action, relabelled. */
      copy: "Copy",
      copyAria: (field: string) => `Copy ${field}`,
      copied: "Copied",

      /* The media row. */
      mediaLabel: "The video and its thumbnail",
      videoFacts: (size: string, length: string) => `${length} · ${size}`,
      chooseThumbnail: "Choose a different thumbnail",
      handoffSummary: "Post it by hand instead",
      handoffHint: "Download the files and copy the text, then upload on the platform yourself. This never posts anything.",

      /* A platform block. */
      publish: "Publish",
      publishing: "Publishing…",
      retry: "Retry",
      publishAria: (platform: string) => `Publish to ${platform}`,
      retryAria: (platform: string) => `Retry publishing to ${platform}`,
      confirmTitle: (platforms: string[]) => `Publish to ${platforms.join(" and ")}?`,
      confirmOk: "OK",
      confirmCancel: "Cancel",
      confirmSkipped: (note: string) => `Not sent: ${note}`,
      routeApi: (platform: string) => `Sent through the official ${platform} API.`,
      routeBrowser: (platform: string) => `Sent through a browser window on this computer, signed in to ${platform}.`,

      /* What OK will do. */
      sumYtApi:
        "Uploads to YouTube through the official API as a PRIVATE video. Nothing goes public: you review it in YouTube Studio.",
      sumYtPrivate:
        "Opens a browser window and uploads to YouTube as a PRIVATE video. Nothing goes public: you review it in YouTube Studio.",
      sumYtUnlisted:
        "Uploads to YouTube as UNLISTED: anyone with the link can watch it, and it is not shown on the channel.",
      sumYtPublic:
        "Posts to YouTube PUBLICLY, right now, with no review step. It goes live on the channel and cannot be taken back from here.",
      sumYtScheduled: (when: string) =>
        `Schedules it on YouTube to go PUBLIC at ${when}. It goes live on the channel with no review step and cannot be taken back from here.`,
      sumIg:
        "Shares it to Instagram as a Reel, PUBLICLY and at once. Instagram has no private or draft post, and it cannot be taken back from here.",
      sumIgIgnoresSchedule:
        "This quick-publish action shares Instagram now. Use Weekly Schedule for native Instagram scheduling when publishing is enabled.",

      /* Why a press does nothing yet. */
      notOwned: "This video does not belong to this account, so it cannot be posted from here.",
      notReady: "This video is not ready to publish yet. The list at the top says what is missing.",
      noBrowserRoute: (platform: string) => `There is no browser route for ${platform}, and its official API is not connected.`,
      browserUnavailable: (platform: string) => `The ${platform} browser route is not available on this server.`,
      cannotSchedule: (platform: string) => `${platform} cannot be scheduled from here. Clear the schedule to post it now.`,
      kidsRequired:
        "Say whether this video is made for kids, under Visibility. YouTube requires an answer and it is yours to give, so BookReel never picks one.",
      donePosted: (platform: string) => `Already posted on ${platform}. Nothing was sent.`,
      doneScheduled: (platform: string, when: string | null) =>
        `Already scheduled on ${platform}${when ? ` for ${when}` : ""}. Nothing was sent.`,
      doneInProgress: (platform: string) => `A ${platform} publish is already in progress. Nothing more was sent.`,
      doneSeen: (platform: string, id: string) =>
        `${platform} already showed a video for this one (id ${id}), so it will not be started again. Check ${platform}.`,
      retryNeedsLook: (platform: string) =>
        `Tick the box below to say you looked at ${platform}, then retry. It is never retried on its own.`,

      /* Visibility. */
      visibilityHeading: "Visibility",
      visibilityYouTube: "YouTube",
      visibilityInstagram: "Instagram",
      visibilityScheduled: "Public at the scheduled time",
      visibilityLockedBySchedule: "A schedule makes the post public at that time, so there is nothing to choose here.",
      igVisibilityValue: "Public",
      igVisibilityNote: "Instagram has no private or unlisted post: a share is public, at once.",
      kidsFromSchedule: "Taken from the answer saved on your Weekly Schedule. Change it if it is wrong.",

      /* Schedule. */
      scheduleHeading: "Schedule",
      scheduleField: "Date and time",
      scheduleCalendar: "Open the calendar",
      scheduleClear: "Clear",
      scheduleOptional: "Leave empty to publish now.",
      scheduleZone: "Times are India time (Asia/Kolkata, IST), whatever this computer's clock says.",
      schedulePreview: (when: string) => `Goes public ${when}.`,
      scheduleYouTubeOnly: "This quick-publish flow schedules YouTube only. Use Weekly Schedule for Instagram scheduling.",
      scheduleInvalid: "That is not a valid date and time. Nothing was sent.",
      scheduleTooSoon: (minutes: number) =>
        `Pick a time at least ${minutes} minutes from now to schedule a YouTube post. Nothing was sent.`,
      slotLocked: (when: string) =>
        `From your Weekly Schedule: ${when}. This video is in an activated schedule, so it is posted at exactly that time and the time is locked here.`,
      slotUnreadable: "The Weekly Schedule's time for this video could not be read. Nothing was sent.",
      slotTooSoon: (when: string, minutes: number) =>
        `Your Weekly Schedule set this video for ${when}, which has passed or is less than ${minutes} minutes away. BookReel will not post it at a different time: plan it again in Weekly Schedule. Nothing was sent.`,
      slotChecking: "Checking your Weekly Schedule…",
      slotCheckFailed:
        "Your Weekly Schedule could not be checked, so scheduling is off for now (a video in a schedule must be posted at its own time).",
      slotRetry: "Check again",

      /* The three publish buttons. */
      actionsHeading: "Publish to",
      actionInstagram: "Instagram",
      actionYouTube: "YouTube",
      actionBoth: "Instagram & YouTube",

      /* What happened, from the job. */
      resultsHeading: "Where it stands",
      reportPosted: (platform: string) => `Posted on ${platform}`,
      reportPostedDetail: (when: string, id: string) => `${when} · confirmed by the platform · id ${id}`,
      reportScheduled: (platform: string, when: string) => `Scheduled on ${platform} for ${when}`,
      reportScheduledDetail: (platform: string) => `${platform} read the time back from its own page. Nothing is live yet.`,
      reportInProgress: (platform: string) => `${platform}: working on it`,
      reportInProgressDetail:
        "A browser window or the platform is working on this. It is only recorded as posted or scheduled once the platform's own page confirms it.",
      reportNeedsYou: (platform: string) => `${platform}: needs you`,
      reportNeedsYouDetail: (platform: string) => `The attempt stopped for a person. Check ${platform}.`,
      reportFailed: (platform: string) => `${platform}: failed`,
      reportCheck: (platform: string) => `${platform}: check it`,
      unconfirmedPosted: (platform: string) =>
        `This is recorded as posted, but ${platform}'s own confirmation is not on record, so it is not shown as posted. Check ${platform}.`,
      unconfirmedScheduled: (platform: string) =>
        `This is recorded as scheduled, but ${platform}'s own confirmation is not on record, so it is not shown as scheduled. Check ${platform}.`,
      openStudio: "Open in YouTube Studio",
      statusPosted: "Posted",
      statusScheduled: "Scheduled",
      statusInProgress: "In progress",
      statusNeedsYou: "Needs you",
      statusFailed: "Failed",
      statusNotReady: "Not ready",
      statusNotPosted: "Not posted yet",
      sentStarted: (platform: string) => `${platform}: started. The result appears here once the platform confirms it.`,
      sentNothing: (platform: string) => `${platform}: nothing new was started.`,
      sentFailed: (platform: string) => `${platform} could not be started.`,
      sentNetwork: (platform: string) => `${platform} could not be reached from this page. Nothing was confirmed; check the platform before trying again.`,
    },
  },
  library: {
    heading: "Library",
    intro: "Newest first.",
    countLabel: (n: number) => (n === 1 ? "1 episode" : `${n} episodes`),
    open: (title: string) => `Open ${title}`,
    noPoster: "No thumbnail yet",
    durationLabel: (seconds: number) => `${Math.round(seconds)}s`,
    retry: "Try again",
  },
  queue: {
    heading: "Queue",
    badge: "Coming soon",
    body: "Batch runs, scheduling and retries will live here. Nothing is queued today — every run you start begins immediately.",
  },
  inspector: {
    heading: "Settings",
    episodeLabel: "Selected episode",
    noEpisode: "Pick an episode to see its settings.",
    saveFailed: "Could not save that setting.",
    displayOnly: "Display only — this cannot be changed yet.",
  },
  themePanel: {
    heading: "Theme",
    /**
     * The collapsed summary, in the same shape the voice and music panels
     * use: the group says its answer without being opened, so the whole
     * configuration can be read down the rail at a glance.
     */
    summary: (label: string) => `Theme · ${label}`,
    /** Before `GET /api/settings` has answered there is nothing true to name. */
    summaryUnknown: "Theme",
    current: "In use",
    unavailable: "Coming soon",
    /** The one line that stays on screen. */
    hint: "Applies to your next run.",
    /* --- the preview cards (2026-10-05) -----------------------------------
     * Eleven themes is past the point where a row of named chips tells anyone
     * anything: "Atelier" and "Dossier" are words, not looks. The cards carry a
     * real still rendered by the compositor itself, so the picker shows the
     * thing rather than describing it.
     */
    previewsSummary: "See every theme",
    previewsBody:
      "Each picture is a real frame from this app's own renderer, made from the same sample page: the ground, the paper card, the marker and the caption are exactly what you would get. Full-screen scene cards are not themed yet and keep the shared face in every theme.",
    /** Alt text for one card's still. */
    previewAlt: (label: string) => `A frame rendered in the ${label} theme`,
    /** Shown on a card when the still has not been generated yet. */
    previewMissing: "No preview rendered yet",
    /** The badge on the themes Auto would pick for the episode in the inspector. */
    suggested: "Suits this book",
    suggestedBody:
      "Ranked from this episode's title, hook and script by the same matcher Auto uses, best first. An episode created on Auto was ranked from the words it had at the time, so the top entry here can differ from the theme it was given. A suggestion either way — picking a theme still pins every video to that one.",
    detailsSummary: "What each theme looks like",
    detailsBody:
      "An episode keeps the theme it was made with, so changing this never re-skins a video that already exists.",
    /** Why the default is not one of the five. */
    autoBody:
      "On Auto, each video gets the theme that suits what it is about, so two videos from the same book can look different. Pick a theme by name to use that one for everything instead.",
  },
  voicePanel: {
    heading: "Voice",
    /** The collapsed summary: the panel is not in use, so it says its answer. */
    summary: (label: string) => `Voice · ${label}`,
    /** Before the setting has been read there is nothing true to name. */
    summaryUnknown: "Voice",
    /** A finished video: what narrated IT, not what the next one will use. */
    summaryNarrated: (name: string) => `Voice · Narrated by ${name}`,
    summaryNotRecorded: "Voice · not recorded",
    selectLabel: "Narrator",
    placeholder: "Choose a narrator",
    hint: "Applies to your next run. A finished video keeps the voice it was narrated with.",
    preview: "Preview",
    /** Short on purpose: it sits beside the select, and a longer label would resize the row. */
    previewing: "Loading…",
    /** The first preview loads the speech model; the wait is the model, not a hang. */
    previewHint:
      "Plays one short line in the selected voice. The first preview can take around twenty-five seconds while the voice model loads.",
    previewFailed: "That voice could not be played.",
    previewTimedOut: "The voice is still loading. Try the preview again in a moment.",
    genderLabel: { female: "Female", male: "Male" } as Record<string, string>,
  },
  musicPanel: {
    heading: "Music",
    /** The collapsed summary says the answer, as the voice panel's does. */
    summary: (label: string) => `Music · ${label}`,
    /** Before the setting has been read there is nothing true to name. */
    summaryUnknown: "Music",
    moodLabel: "Mood",
    moodPlaceholder: "Choose a mood",
    duckPlaceholder: "Choose a ducking level",
    intensityLabel: "Layers",
    levelLabel: "Bed level",
    /**
     * The slider's reading. The narration is mastered to -16, so the distance from
     * it is what an operator is actually setting; the minus is U+2212, which is
     * what the other strings use, and is display only (what is SENT is "-22").
     */
    levelValue: (db: number) => {
      const under = -16 - db;
      const spoken = `−${Math.abs(db)} dB`;
      if (under > 0) return `${spoken} · about ${under} dB under the narration`;
      if (under === 0) return `${spoken} · level with the narration`;
      return `${spoken} · about ${-under} dB over the narration`;
    },
    duckLabel: "Ducking",
    hint: "Applies to your next run. The bed is synthesized here for every video, so it carries no licence and cannot be claimed. The level is the bed's mean level before ducking.",
  },
  thumbnails: {
    heading: "Thumbnails",
    summary: (n: number) => (n === 0 ? "Thumbnails" : n === 1 ? "Thumbnails · 1" : `Thumbnails · ${n}`),
    empty: "No thumbnails for this episode yet.",
    pending: "Thumbnails are generated at the end of a run.",
    alt: (variant: string, aspect: string) => `${variant} thumbnail, ${aspect}`,
    aspectLabel: (aspect: string) => aspect,
    download: (variant: string) => `Download the ${variant} thumbnail`,
    use: "Use",
    inUse: "In use",
    useLabel: (variant: string, aspect: string) => `Use the ${variant} ${aspect} poster for this episode`,
    headlineLabel: "Poster headline",
    headlinePlaceholder: "The generated headline",
    retitle: "Retitle",
    retitling: "Redrawing…",
    headlineHint: "Redraws all six posters with these words. Clear the field to go back to the generated headline.",
    retitled: "Posters redrawn.",
    retitledPartial: (n: number) =>
      n === 1
        ? "1 poster could not be redrawn and was removed. Retitle again to try for it."
        : `${n} posters could not be redrawn and were removed. Retitle again to try for them.`,
    choiceFailed: "Could not save that choice.",
    retitleFailed: "Could not redraw the posters.",
    /** Said when an episode has fewer than the full set -- including after a reload, which forgets why. */
    fewerPosters: (have: number, of: number) =>
      `${have} of ${of} posters are here. Retitle to try for the rest.`,
  },
  download: {
    heading: "Download",
    video: "Video (MP4)",
    unavailable: "Available once the render finishes.",
  },
  books: {
    heading: "Book PDFs",
    intro: "A whole book in, the best video ideas out.",
    helpSummary: "How this works",
    help:
      "Upload a book as a PDF, up to 300 pages. BookReel reads every page — running OCR on scanned ones — finds the chapters, and looks through the whole book for ideas that could each carry a 1–2 minute video. Every idea is checked against the book's own words and shows the pages it came from. Pick the ideas you want made into videos.",
    uploadHeading: "Add a book PDF",
    dropHint: "Drag a PDF here, or",
    choose: "Choose PDF",
    chosen: (name: string, mb: string) => `${name} · ${mb} MB`,
    notPdf: "That file is not a PDF.",
    tooLarge: "That PDF is over 300 MB.",
    noFile: "Choose a PDF first.",
    noTitle: "Give the book a title first.",
    start: "Upload and analyse",
    uploading: (pct: number) => `Uploading… ${pct}%`,
    starting: "Starting…",
    uploadError: "The upload could not be completed. Try again.",
    started: "Analysis started.",
    listHeading: "Your books",
    /** The group's summary once the list has loaded: it answers without opening. */
    listSummary: (n: number) =>
      n === 0 ? "Your books · none yet" : n === 1 ? "Your books · 1" : `Your books · ${n}`,
    listEmpty: "No books yet. Upload a PDF to find its video ideas.",
    listLoadError: "Could not load your books.",
    pages: (n: number | null) => (n == null ? "" : n === 1 ? "1 page" : `${n} pages`),
    ideaCount: (n: number) => (n === 1 ? "1 idea" : `${n} ideas`),
    open: (title: string) => `Open ${title}`,
    coverRegenerate: "Regenerate cover",
    coverRegenerating: "Regenerating…",
    coverRegenerateError: "Could not regenerate the cover.",
    coverRegenerateFor: (title: string) => `Regenerate the cover of ${title}`,
    nothingOpen: "Pick a book to see its ideas, or upload a new one.",
    runHeading: "Analysing the book",
    elapsed: "Total elapsed",
    stepTimes: "Time per step",
    loadError: "This book could not be loaded.",
    retry: "Try again",
    retrying: "Restarting…",
    retryError: "Could not restart the analysis.",
    notes: (n: number) => (n === 1 ? "1 note about this analysis" : `${n} notes about this analysis`),
    ideasHeading: (n: number) => (n === 1 ? "1 video idea" : `${n} video ideas`),
    ideasIntro: (pages: number | null) =>
      pages ? `Ranked from the strongest, across all ${pages} pages.` : "Ranked from the strongest.",
    selectedCount: (n: number) => (n === 0 ? "None selected" : n === 1 ? "1 selected" : `${n} selected`),
    generate: (n: number) => (n <= 1 ? "Generate video" : `Generate ${n} videos`),
    generating: "Queuing…",
    generateHint: "Each video is 1–2 minutes and takes several minutes to make. They are made one at a time.",
    generateNone: "Select the ideas you want made into videos.",
    generateError: "Could not start the videos. Try again.",
    generated: (n: number, already: number) =>
      [n ? (n === 1 ? "1 video queued." : `${n} videos queued.`) : "", already ? (already === 1 ? "1 already has a video." : `${already} already have videos.`) : ""]
        .filter(Boolean)
        .join(" "),
    videosHeading: "Videos",
    videoStatus: (status: string) =>
      ({
        QUEUED: "Video queued",
        RUNNING: "Making video",
        DONE: "Video ready",
        FAILED: "Video failed",
        CANCELLED: "Video cancelled",
      })[status] ?? status,
    select: "Select",
    selectAll: "Select all",
    deselectAll: "Deselect all",
    selectLabel: (title: string) => `Select “${title}” for a video`,
    selectError: "Could not save that selection. Try again.",
    hookLabel: "Opening line",
    whyLabel: "Why it works",
    whyItMatters: "Why it matters",
    hookPotential: "Hook",
    storyPotential: "Story",
    practicalValue: "Practical value",
    visualPotential: "On screen",
    sourceLabel: "From the book",
    sourceSummary: (pages: string) => `From the book · ${pages}`,
    pageRef: (n: number, label: string | null) => (label ? `p. ${label} (PDF ${n})` : `p. ${n}`),
    related: (pages: string) => `Also relevant: ${pages}`,
    pagePreviewAlt: (n: number) => `Page ${n} of the book`,
    angle: {
      "counterintuitive-insight": "Counterintuitive",
      "practical-technique": "Technique",
      story: "Story",
      "surprising-fact": "Surprising fact",
      "mental-model": "Mental model",
      "common-mistake": "Common mistake",
      framework: "Framework",
      "emotional-truth": "Emotional truth",
      other: "Idea",
    } as Record<string, string>,
  },
  /**
   * The Weekly Schedule panel on the Book PDFs page. Plain about what it does: it
   * uploads each video NOW through the operator's signed-in Chrome and YouTube
   * publishes it at the slot time, and a video is only marked scheduled after
   * YouTube's own page confirms that time. YouTube only: Instagram's website
   * cannot schedule.
   */
  schedule: {
    button: "Weekly Schedule",
    buttonLabel: "Schedule this book's videos across a week on YouTube and Instagram",
    title: "Weekly Schedule",
    close: "Close the weekly schedule",
    intro:
      "Spread this book's finished videos across a week. Activating is your go-live confirmation: it works through the list below, one video at a time, " +
      "using your connected YouTube account or signed-in Chrome, and each enabled platform receives its exact publication time.",
    chromeNote:
      "Browser uploads reuse your own signed-in Chrome session. Keep this computer on until each enabled platform confirms its schedule; the platform then holds the publication time.",
    platformsHeading: "Where to publish",
    platformYouTube: "YouTube",
    platformInstagram: "Instagram",
    needPlatform: "Choose at least one platform.",
    youtubeNote:
      "YouTube: each video is uploaded now and YouTube itself publishes it at its slot time. A video is only marked scheduled after YouTube's own page confirms the exact time.",
    instagramNote:
      "Instagram uses its own Schedule content controls and confirms the exact time from Scheduled content. It requires an eligible account and a signed-in BookReel browser session. Instagram execution remains disabled until explicitly enabled; YouTube can proceed independently.",
    weekStart: "First day",
    days: "Number of days",
    daysOption: (n: number) => `${n} ${n === 1 ? "day" : "days"}`,
    timesHeading: "Daily times",
    timesNote: "Each day's times are filled in order, then the next day's, so the videos go live in the order listed below.",
    addTime: "Add time",
    newTimeLabel: "Time to add",
    removeTime: (t: string) => `Remove ${t}`,
    timezone: "Time zone",
    timezoneValue: "Asia/Kolkata",
    timezoneNote: "Every time here is Asia/Kolkata (IST), wherever this computer is.",
    kidsLegend: "Are these videos made for kids?",
    kidsNote: "YouTube requires an answer and it is yours to give, so BookReel never picks one for you.",
    kidsNo: "No, they are not made for kids",
    kidsYes: "Yes, they are made for kids",
    videosHeading: "Videos",
    videosNote: (picked: number, ready: number) => `${picked} of ${ready} finished videos chosen`,
    selectAll: "Select all",
    deselectAll: "Deselect all",
    notFinished: "Not finished yet",
    noVideos: "This book has no finished videos yet. Make some from its ideas first, then come back.",
    previewHeading: "Preview",
    previewNote: "Each video, in this order, with the exact time it will go live.",
    previewEmpty: "Choose at least one video to see when each goes live.",
    columns: { order: "#", video: "Video", slot: "Slot", live: "Goes live (Asia/Kolkata)" },
    slotLabel: (day: number, time: string) => `Day ${day} at ${time}`,
    tooSoon: "Too soon: YouTube needs at least 15 minutes. Move the first day later.",
    capacity: (videos: number, room: number) =>
      `${videos} videos do not fit: this grid has room for ${room}. Add a time, add days, or untick some videos.`,
    saveDraft: "Save draft",
    saving: "Saving…",
    saved: "Draft saved.",
    activate: "Activate schedule",
    activating: "Activating…",
    activated: "Schedule activated. The uploads have started.",
    activateNote:
      "Activate confirms that these videos go live on enabled platforms at those times, with no review step. A confirmed platform schedule must be changed on that platform.",
    needKids: "Answer the made-for-kids question to activate.",
    needFit: "Choose the videos and a grid they fit in to continue.",
    needLead: "Move the first day later: every YouTube video must be at least 15 minutes away.",
    needFuture: "Move the first day later: every enabled Instagram video must be at least 20 minutes away.",
    statusHeading: "Schedule status",
    status: {
      pending: "Waiting",
      scheduling: "Uploading",
      scheduled: "Scheduled",
      published: "Posted",
      failed: "Needs attention",
      skipped: "Skipped",
    } as Record<string, string>,
    // An Instagram slot not yet at its time, and one being posted now: the YouTube
    // words ("Waiting"/"Uploading") would misdescribe what is happening.
    waitingToPost: "Waiting for its time",
    posting: "Posting",
    running: "Working through the videos. This panel updates itself; you can close it and come back.",
    statusDone: (done: number, total: number) => `${done} of ${total} are scheduled or posted.`,
    openOnYouTube: "Open on YouTube",
    openOnInstagram: "Open on Instagram",
    runAgain: "Run again",
    runAgainNote:
      "Picks up where it stopped. Videos that are already scheduled or posted are skipped, never published twice. If a video stopped for you, check the platform and retry it from its own Publish panel first.",
    planAnother: "Plan another week",
    loading: "Loading…",
    loadError: "The schedule could not be loaded.",
    saveError: "The draft could not be saved.",
    activateError: "The schedule could not be activated.",
  },
  engineModal: {
    title: "Choose your generation engine",
    subtitle:
      "BookReel runs its generation pipeline on your account — pick Claude, Codex, or Gemini, then connect it.",
    defaultHint: "Default: server's configured engine",
    skipForNow: "Skip for now",
    connectedBadge: "Connected",
    needsSetupBadge: "Needs setup",
    checkingBadge: "Checking…",
    selectedBadge: "Selected",
    useEngine: (label: string) => `Use ${label}`,
    saveAndConnect: (label: string) => `Connect ${label}`,
    saving: "Saving…",
    recheck: "Check connection",
    geminiModelHeading: "Choose Gemini model",
    geminiModelHint: "Select which Gemini model powers book analysis, script writing, and page vision.",
    apiKeyLabel: (label: string) => `${label} API key`,
    apiKeyPlaceholder: {
      "claude-cli": "Paste Anthropic API key (optional if Claude CLI is signed in)",
      "codex-cli": "Paste OpenAI API key (or run codex login in terminal)",
      gemini: "Paste Gemini API key from Google AI Studio (AIza…)",
    } as Record<string, string>,
    setupHelp: {
      "claude-cli":
        "Sign in with `claude login` in your terminal to use your Claude Code CLI subscription, or configure an Anthropic environment.",
      "codex-cli":
        "Sign in with `codex login` in your terminal to use your OpenAI Codex CLI session, or paste an OpenAI API key below.",
      gemini:
        "Paste a Gemini API key from Google AI Studio (or set GEMINI_API_KEY in .env.local) to run book analysis, scripts, and vision on Gemini 2.5.",
    } as Record<string, string>,
    close: "Close",
  },
  enginePanel: {
    heading: "Generation engine",
    summaryUnknown: "Engine",
    summary: (label: string) => `Engine · ${label}`,
    geminiModelLabel: "Gemini model",
    hint: "Powers book analysis, idea finding, script writing, grounding checks, visual planning, and publishing copy. Never silently falls back to another provider.",
    chooseButton: "Choose engine…",
    recheckButton: "Recheck",
    connected: "Connected",
    notConnected: "Needs setup",
    saveKeyButton: "Save key",
    clearKeyButton: "Remove saved key",
    keySavedNote: "API key saved on this server.",
  },
} as const;

/**
 * What the music panel offers. Each list is a hand-copy of a vocabulary that lives
 * in a module this one cannot import (see the header), and each is compared with
 * its source by `tests/music-moods.test.mts` so a copy that drifts is a failing
 * test rather than a picker offering a choice the server refuses.
 */
export interface MusicOption {
  id: string;
  label: string;
  note: string;
}

/**
 * The first choice, and not a mood: take it from the video's own theme, which is
 * how the bed was chosen before there was a picker. `id` must equal the `"auto"`
 * that `settings/keys.ts` accepts.
 */
export const AUTO_MUSIC_MOOD: MusicOption = {
  id: "auto",
  label: "Follows the theme",
  note: "Each video's music comes from its own theme",
};

/** Ids are the keys of `MOODS` in `media/moods.ts`, in its order. */
export const MUSIC_MOOD_OPTIONS: MusicOption[] = [
  { id: "terminal", label: "Terminal", note: "dark, sparse, unhurried" },
  { id: "spotlight", label: "Spotlight", note: "driving, punchy" },
  { id: "blueprint", label: "Blueprint", note: "calm, documentary" },
  { id: "editorial", label: "Editorial", note: "warm, gentle" },
  { id: "vista", label: "Vista", note: "wide, cinematic" },
  { id: "tension", label: "Tension", note: "tense, forward-leaning" },
  { id: "resolve", label: "Resolve", note: "resolute, hymn-like" },
  { id: "nocturne", label: "Nocturne", note: "nocturnal, intimate" },
  { id: "momentum", label: "Momentum", note: "bright, propulsive" },
  { id: "stark", label: "Stark", note: "austere, open fifths" },
];

/**
 * The layers `renderPad` adds, by tier. The value is what is stored, so it is the
 * string `settings/keys.ts` would write back: "0", "1", "2".
 */
export const MUSIC_INTENSITIES: MusicOption[] = [
  { id: "0", label: "Pad", note: "The pad alone: the sound every earlier video has." },
  { id: "1", label: "Bass", note: "The pad with a low bass line under each chord." },
  { id: "2", label: "Full", note: "Bass, a soft arpeggio, and a pulse at each chord change." },
];

/** Ids are `off` and the keys of `DUCK_PROFILES` in `media/ffmpeg.ts`. */
export const MUSIC_DUCKS: MusicOption[] = [
  { id: "off", label: "Off", note: "the bed stays at one level" },
  { id: "light", label: "Light", note: "steps back a little" },
  { id: "normal", label: "Normal", note: "steps back under every spoken phrase" },
  { id: "strong", label: "Strong", note: "all but disappears under speech" },
];

/** The level slider's range, in dB. `musicLevel` in `settings/keys.ts` accepts exactly this. */
export const MUSIC_LEVEL_RANGE = { min: -40, max: -13, step: 1 } as const;

export type GenerationEngineId = "claude-cli" | "codex-cli" | "gemini";

export interface GenerationEngineOption {
  id: GenerationEngineId;
  label: string;
  description: string;
  shortNote: string;
}

export const GENERATION_ENGINES: GenerationEngineOption[] = [
  {
    id: "claude-cli",
    label: "Claude",
    description: "Anthropic's Claude powers the generation pipeline",
    shortNote: "Anthropic Claude via signed-in Claude Code CLI",
  },
  {
    id: "codex-cli",
    label: "Codex",
    description: "OpenAI's models power the generation pipeline",
    shortNote: "OpenAI models via Codex CLI or OpenAI API key",
  },
  {
    id: "gemini",
    label: "Gemini",
    description: "Google's Gemini 2.5 powers the generation pipeline",
    shortNote: "Google Gemini via Gemini API key or Gemini CLI",
  },
];

export type GeminiModelId =
  | "gemini-4-argon"
  | "gemini-3.8-flash"
  | "gemini-3.7-flash"
  | "gemini-3.6-flash"
  | "gemini-3.1-flash-lite"
  | "gemini-flash-lite-latest"
  | "gemini-3.5-flash"
  | "gemini-3.5-flash-lite"
  | "gemini-3.1-pro-preview"
  | "gemini-3-pro-preview"
  | "gemini-2.5-pro"
  | "gemini-2.5-flash"
  | "gemini-2.5-flash-lite"
  | "gemma-4-31b-it";

export interface GeminiModelOption {
  id: GeminiModelId;
  label: string;
  tag: string;
  note: string;
}

export const DEFAULT_GEMINI_MODEL_ID: GeminiModelId = "gemini-3.8-flash";

export const GEMINI_MODELS: GeminiModelOption[] = [
  {
    id: "gemini-3.8-flash",
    label: "Gemini 3.8 Flash",
    tag: "3.8 Flash",
    note: "Recommended · Latest fast multimodal model",
  },
  {
    id: "gemini-4-argon",
    label: "Gemini 4 Argon",
    tag: "4.0 Argon",
    note: "Next-gen Gemini 4 model",
  },
  {
    id: "gemini-3.7-flash",
    label: "Gemini 3.7 Flash",
    tag: "3.7 Flash",
    note: "High-speed multimodal reasoning",
  },
  {
    id: "gemini-3.6-flash",
    label: "Gemini 3.6 Flash",
    tag: "3.6 Flash",
    note: "Fast high-quota multimodal model",
  },
  {
    id: "gemini-3.1-flash-lite",
    label: "Gemini 3.1 Flash-Lite",
    tag: "3.1 Lite",
    note: "High-throughput lightweight model",
  },
  {
    id: "gemini-3.5-flash",
    label: "Gemini 3.5 Flash",
    tag: "3.5 Flash",
    note: "Balanced speed & reasoning",
  },
  {
    id: "gemini-3.5-flash-lite",
    label: "Gemini 3.5 Flash-Lite",
    tag: "3.5 Lite",
    note: "Fast lightweight multimodal",
  },
  {
    id: "gemini-3.1-pro-preview",
    label: "Gemini 3.1 Pro",
    tag: "3.1 Pro",
    note: "Deep reasoning for complex books",
  },
  {
    id: "gemini-2.5-pro",
    label: "Gemini 2.5 Pro",
    tag: "2.5 Pro",
    note: "High-precision thinking model",
  },
  {
    id: "gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    tag: "2.5 Flash",
    note: "Legacy 2.5 multimodal model",
  },
];
