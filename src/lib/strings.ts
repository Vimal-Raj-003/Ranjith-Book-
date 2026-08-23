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

/** Visual themes. Only `marginalia` is built; the rest are announced, not offered. */
export interface ThemeOption {
  id: string;
  label: string;
  note: string;
  available: boolean;
  /** The music bed this theme's mood produces — see MOOD_TO_STYLE in pipeline.ts. */
  music: string;
}

export const VIDEO_THEMES: ThemeOption[] = [
  { id: "marginalia", label: "Marginalia", note: "Warm paper, hand-drawn marker", available: true, music: "Editorial — warm, gentle" },
  { id: "terminal", label: "Terminal", note: "Dark, developer-native", available: true, music: "Terminal — sparse, unhurried" },
  { id: "editorial", label: "Editorial", note: "Magazine feature", available: true, music: "Editorial — warm, gentle" },
  { id: "spotlight", label: "Spotlight", note: "Punchy, made for Shorts", available: true, music: "Spotlight — driving, punchy" },
  { id: "blueprint", label: "Blueprint", note: "Calm, documentary", available: true, music: "Blueprint — calm, documentary" },
];

export const strings = {
  app: {
    brand: "BookReel",
    tagline: "Book pages in, video out.",
    skipToContent: "Skip to main content",
  },
  nav: {
    label: "Sections",
    studio: "Studio",
    library: "Library",
    freeBooks: "Free books",
    queue: "Queue",
    comingSoon: "Soon",
    comingSoonHint: "Not built yet",
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
    workbench: "Studio",
    workbenchIntro: "Upload photographs of the pages you want, then watch the video build.",
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
    bookLinkHint:
      "If you add one, the description ends with this link and the video finishes on a buy-the-book card. Leave it blank and neither appears. Only web addresses starting http:// or https:// are kept — anything else is ignored, and your upload still goes through.",
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
    videoReady: "Your video is ready.",
    episodeLabel: (part: number, total: number) => (total > 1 ? `Episode ${part} of ${total}` : "Episode"),
    failed: "This run failed.",
    loadError: "This episode could not be loaded. It may have been removed.",
    select: (title: string) => `Show ${title} in the preview`,
    selected: "Showing in the preview",
    statusLabel: (status: string) =>
      ({
        QUEUED: "Queued",
        RUNNING: "Running",
        DONE: "Done",
        FAILED: "Failed",
      })[status] ?? status,
  },
  preview: {
    heading: "Preview",
    aspectNote: "9:16 — Shorts and Reels",
    none: "Nothing to preview yet. Start a run, or pick an episode from your library.",
    building: "The video appears here the moment the render finishes.",
    failed: "This run failed before a video was rendered.",
    unsupported: "Your browser cannot play this video. Download it instead.",
    download: "Download video",
  },
  publish: {
    heading: "Ready to post",
    youtubeTitle: "YouTube title",
    youtubeDescription: "YouTube description",
    hashtags: "Hashtags",
    instagram: "Instagram caption",
    empty: "Caption text for this episode is not available yet.",
    partial: "This episode has no description or hashtags saved, so only what exists is shown.",
    waiting: "The caption text is written partway through the run and appears here when it does.",
  },
  library: {
    heading: "Library",
    intro: "Every episode you have made, newest first.",
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
    displayOnly: "Display only — this cannot be changed yet.",
  },
  themePanel: {
    heading: "Theme",
    current: "In use",
    unavailable: "Coming soon",
    hint: "The theme applies to your next run. An episode keeps the theme it was made with, so changing this never re-skins a video that already exists.",
  },
  voicePanel: {
    heading: "Voice",
    selectLabel: "Narrator",
    hint: "Every render uses Charles. Choosing a different voice arrives with the voice settings release.",
    genderLabel: { female: "Female", male: "Male" } as Record<string, string>,
  },
  musicPanel: {
    heading: "Music",
    moodLabel: "Mood",
    moodUnknown: "Follows the selected theme",
    levelLabel: "Bed level",
    levelValue: "−22 LUFS (about 6 dB under the narration)",
    duckLabel: "Ducking",
    duckValue: "On — the bed steps back under every spoken phrase",
    hint: "The bed is synthesized here for every video, so it carries no licence and cannot be claimed. It follows the theme's mood; there is nothing to choose separately.",
  },
  thumbnails: {
    heading: "Thumbnails",
    empty: "No thumbnails for this episode yet.",
    pending: "Thumbnails are generated at the end of a run.",
    alt: (variant: string, aspect: string) => `${variant} thumbnail, ${aspect}`,
    aspectLabel: (aspect: string) => aspect,
    download: (variant: string) => `Download the ${variant} thumbnail`,
  },
  download: {
    heading: "Download",
    video: "Video (MP4)",
    unavailable: "Available once the render finishes.",
  },
} as const;
