/**
 * A scripted browser, for testing the publishers' LOGIC without a browser.
 *
 * It implements the small `PageLike` / `ContextLike` shapes the publishers are
 * written against (see `src/lib/publish/browser/engine.ts`), keyed by the exact
 * selector strings the publishers use. Nothing here talks to a real site, opens a
 * real window or sleeps: the clock is fake and advances only when something
 * sleeps, so a three-minute wait for a confirmation that never comes takes
 * microseconds.
 *
 * WHAT THIS CAN AND CANNOT PROVE. It proves the decisions: that nothing is
 * recorded as posted without a read-back, that a sign-in or a security check
 * stops the job without touching the page, that a wrong account is refused. It
 * cannot prove a selector matches YouTube Studio or Instagram today, because the
 * selectors are the very strings this fake is keyed on.
 */
import type {
  BrowserDeps,
  Clock,
  ContextLike,
  FileChooserLike,
  LaunchOptions,
  LocatorLike,
  PageLike,
} from "../../src/lib/publish/browser/engine";
import type { Spawner } from "../../src/lib/publish/browser/signin";
import { scriptedYouTubeSchedule } from "./schedule-controls.mjs";

type Thunk<T> = T | (() => T);
const val = <T,>(v: Thunk<T> | undefined, fallback: T): T =>
  v === undefined ? fallback : typeof v === "function" ? (v as () => T)() : v;

export interface FakeEl {
  visible?: Thunk<boolean>;
  enabled?: Thunk<boolean>;
  /** How many elements match. Defaults to 1 when visible, else 0. */
  count?: Thunk<number>;
  text?: Thunk<string>;
  value?: Thunk<string>;
  attrs?: Record<string, Thunk<string | null>>;
  /** For `nth(i)`: the attributes of the i-th match. */
  items?: Array<{ attrs?: Record<string, string | null> }> | (() => Array<{ attrs?: Record<string, string | null> }>);
  onClick?: () => void;
  onFill?: (value: string) => void;
  onFiles?: (files: string[]) => void;
}

class FakeLocator implements LocatorLike {
  constructor(
    private readonly page: FakePage,
    private readonly selector: string,
    private readonly index = 0,
  ) {}

  private get el(): FakeEl | undefined {
    return this.page.els.get(this.selector);
  }
  private shown(): boolean {
    const el = this.el;
    return el !== undefined && val(el.visible, true);
  }
  private requireShown(action: string): FakeEl {
    if (!this.shown()) throw new Error(`${action}: ${this.selector} is not visible (a real page would time out)`);
    return this.el as FakeEl;
  }

  first(): LocatorLike {
    return new FakeLocator(this.page, this.selector, 0);
  }
  nth(index: number): LocatorLike {
    return new FakeLocator(this.page, this.selector, index);
  }
  async count(): Promise<number> {
    const el = this.el;
    if (!el) return 0;
    if (el.items) return val(el.items, []).length;
    if (el.count !== undefined) return val(el.count, 0);
    return this.shown() ? 1 : 0;
  }
  async isVisible(): Promise<boolean> {
    return this.shown();
  }
  async isEnabled(): Promise<boolean> {
    const el = this.el;
    if (!el) throw new Error(`isEnabled: ${this.selector} is not on the page`);
    return val(el.enabled, true);
  }
  async click(): Promise<void> {
    const el = this.requireShown("click");
    this.page.actions.push(`click:${this.selector}`);
    el.onClick?.();
  }
  async fill(value: string): Promise<void> {
    const el = this.requireShown("fill");
    this.page.actions.push(`fill:${this.selector}=${value}`);
    if (el.onFill) el.onFill(value);
    else el.text = value;
  }
  async setInputFiles(files: string | string[]): Promise<void> {
    const el = this.el;
    if (!el || (await this.count()) === 0) throw new Error(`setInputFiles: ${this.selector} is not on the page`);
    const list = Array.isArray(files) ? files : [files];
    this.page.actions.push(`files:${this.selector}=${list.join(",")}`);
    el.onFiles?.(list);
  }
  async innerText(): Promise<string> {
    const el = this.el;
    if (!el) throw new Error(`innerText: ${this.selector} is not on the page`);
    return val(el.text, "");
  }
  async inputValue(): Promise<string> {
    const el = this.el;
    if (!el) throw new Error(`inputValue: ${this.selector} is not on the page`);
    return val(el.value, "");
  }
  async getAttribute(name: string): Promise<string | null> {
    const el = this.el;
    if (!el) throw new Error(`getAttribute: ${this.selector} is not on the page`);
    if (el.items) {
      const items = val(el.items, []);
      return items[this.index]?.attrs?.[name] ?? null;
    }
    return val(el.attrs?.[name], null);
  }
}

export class FakePage implements PageLike {
  currentUrl = "about:blank";
  titleText = "";
  readonly els = new Map<string, FakeEl>();
  /** Every action that touched the page, in order. `goto` is recorded too. */
  readonly actions: string[] = [];
  /** Called after `goto` records the navigation: a scenario moves the page here. */
  onGoto: (url: string, page: FakePage) => void = () => {};
  /** Throw from `goto` for a URL (an unreachable site). */
  gotoError: (url: string) => Error | null = () => null;
  onPress: (key: string) => void = () => {};

  def(selector: string, el: FakeEl): this {
    this.els.set(selector, el);
    return this;
  }

  /** Anything that acted on the page rather than just looking: a click, a fill, a file, a key. */
  touched(): string[] {
    return this.actions.filter((a) => !a.startsWith("goto:"));
  }

  async goto(url: string): Promise<unknown> {
    this.actions.push(`goto:${url}`);
    const err = this.gotoError(url);
    if (err) throw err;
    this.currentUrl = url;
    this.onGoto(url, this);
    return null;
  }
  url(): string {
    return this.currentUrl;
  }
  async title(): Promise<string> {
    return this.titleText;
  }
  locator(selector: string): LocatorLike {
    return new FakeLocator(this, selector);
  }
  keyboard = {
    press: async (key: string): Promise<unknown> => {
      this.actions.push(`press:${key}`);
      this.onPress(key);
      return null;
    },
  };
  async waitForEvent(): Promise<FileChooserLike> {
    return {
      setFiles: async (files) => {
        this.actions.push(`chooser:${Array.isArray(files) ? files.join(",") : files}`);
      },
    };
  }
}

export class FakeContext implements ContextLike {
  closed = false;
  private listeners: Array<() => void> = [];
  constructor(private readonly page: FakePage) {}
  pages(): PageLike[] {
    return [this.page];
  }
  async newPage(): Promise<PageLike> {
    return this.page;
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const l of this.listeners) l();
  }
  on(_event: "close", listener: () => void): unknown {
    this.listeners.push(listener);
    return this;
  }
}

/** A clock that only moves when something sleeps. */
export function fakeClock(): Clock & { elapsed(): number } {
  let t = 1_000_000;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    elapsed: () => t - 1_000_000,
  };
}

/**
 * The operator's OWN Chrome, as the engine sees it once attached: a context the
 * engine is handed WITHOUT a `close` (see `AttachedBrowser`), that still counts any
 * `close` that is called anyway. `closeCalls` must stay 0 on every outcome.
 *
 * It starts with one tab the operator already had open (`operatorTab`), which the
 * job must never navigate or touch; the job gets a NEW tab (`page`) from `newPage`.
 */
export class FakeChromeContext {
  closeCalls = 0;
  readonly opened: FakePage[] = [];
  constructor(
    private readonly page: FakePage,
    readonly operatorTab: FakePage,
  ) {}
  pages(): PageLike[] {
    return [this.operatorTab, ...this.opened];
  }
  async newPage(): Promise<PageLike> {
    this.opened.push(this.page);
    return this.page;
  }
  async close(): Promise<void> {
    this.closeCalls++;
  }
  on(): unknown {
    return this;
  }
}

export interface FakeChrome {
  deps: BrowserDeps;
  /** The endpoint of every attach, and how many arguments `connect` was called with. */
  connects: Array<{ endpoint: string; argCount: number }>;
  /** Every launch attempted. Attach mode must leave this empty -- a launch would be a silent fall back to Chromium. */
  launches: Array<{ profileDir: string; options: LaunchOptions }>;
  /** Every address asked about (the reachability probe). */
  probes: string[];
  disconnects: number;
  context: FakeChromeContext;
  operatorTab: FakePage;
  clock: ReturnType<typeof fakeClock>;
}

/**
 * `BrowserDeps` for the attach mode: `BOOKREEL_PUBLISH_CHROME_CDP` set, a `connect`
 * that hands over `FakeChromeContext`, a probe that answers like Chrome's
 * `/json/version`, and NO bundled Chromium (`locate` finds none), so anything that
 * quietly fell back to launching one would show up in `launches`.
 *
 * `chrome`: `up` (default) answers; `down` refuses both the probe and the attach;
 * `no-tab` attaches but cannot open a tab.
 */
export function fakeChrome(
  page: FakePage,
  options: {
    profileRoot: string;
    endpoint?: string;
    env?: Record<string, string | undefined>;
    chrome?: "up" | "down" | "no-tab";
  },
): FakeChrome {
  const endpoint = options.endpoint ?? "http://127.0.0.1:9222";
  const state = options.chrome ?? "up";
  const connects: FakeChrome["connects"] = [];
  const launches: FakeChrome["launches"] = [];
  const probes: string[] = [];
  const operatorTab = new FakePage();
  const context = new FakeChromeContext(page, operatorTab);
  if (state === "no-tab") {
    context.newPage = async () => {
      throw new Error("Target.createTarget failed");
    };
  }
  const clock = fakeClock();
  const result: FakeChrome = {
    connects,
    launches,
    probes,
    disconnects: 0,
    context,
    operatorTab,
    clock,
    deps: {
      env: { BOOKREEL_INSTAGRAM_PUBLISH_ENABLED: "1", BOOKREEL_PUBLISH_CHROME_CDP: endpoint, ...options.env },
      youtubeSchedule: scriptedYouTubeSchedule,
      youtubeReview: async p => ({ tags: p.metadata.tags ?? [], reason: "Fixture reviewer approved the synthetic general-audience script." }),
      clock,
      profileRoot: options.profileRoot,
      locate: () => null,
      launch: async (profileDir, launchOptions) => {
        launches.push({ profileDir, options: launchOptions });
        return new FakeContext(page);
      },
      connect: async (...args: [string, ...unknown[]]) => {
        connects.push({ endpoint: args[0], argCount: args.length });
        if (state === "down") throw new Error(`connect ECONNREFUSED ${args[0]}`);
        return {
          context,
          disconnect: async () => {
            result.disconnects++;
          },
        };
      },
      fetchImpl: (async (input: string | URL | Request) => {
        probes.push(String(input));
        if (state === "down") throw new TypeError("fetch failed");
        return new Response(
          JSON.stringify({ Browser: "Chrome/140.0.0.0", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/abc" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch,
    },
  };
  return result;
}

export interface FakeLaunches {
  deps: BrowserDeps;
  /** Every launch: the profile dir and the options it was given. */
  launches: Array<{ profileDir: string; options: LaunchOptions }>;
  context: FakeContext;
  clock: ReturnType<typeof fakeClock>;
}

/** `BrowserDeps` that launch a `FakeContext` on `page`, record the launch, and find a "Chromium". */
export function fakeBrowser(
  page: FakePage,
  options: {
    profileRoot: string;
    env?: Record<string, string | undefined>;
    chromium?: boolean;
    /** Channel mode (`BOOKREEL_PUBLISH_BROWSER_CHANNEL`): is the installed Chrome/Edge "found"? Default yes. */
    channelInstalled?: boolean;
    /** Make the launch itself throw, as Playwright does when the channel's browser is missing. */
    launchError?: Error;
  },
): FakeLaunches {
  const launches: FakeLaunches["launches"] = [];
  const context = new FakeContext(page);
  const clock = fakeClock();
  return {
    launches,
    context,
    clock,
    deps: {
      env: options.env ?? {},
      youtubeSchedule: scriptedYouTubeSchedule,
      youtubeReview: async p => ({ tags: p.metadata.tags ?? [], reason: "Fixture reviewer approved the synthetic general-audience script." }),
      clock,
      profileRoot: options.profileRoot,
      locate: () => (options.chromium === false ? null : "C:/fake/chromium/chrome.exe"),
      locateChannel: () => (options.channelInstalled === false ? null : "C:/fake/installed/chrome.exe"),
      launch: async (profileDir, launchOptions) => {
        launches.push({ profileDir, options: launchOptions });
        if (options.launchError) throw options.launchError;
        return context;
      },
    },
  };
}

export interface FakeSpawn {
  /** Every program the sign-in asked to start, with the exact argument list it was given. */
  spawns: Array<{ executable: string; argv: string[] }>;
  spawner: Spawner;
}

/**
 * A `Spawner` that starts NOTHING: it records the program and its arguments, so the
 * plain-Chrome command line can be asserted on without any Chrome existing. `fail`
 * makes it refuse, as the operating system does for a program that will not start.
 * `onSpawn` runs at the moment of the call, for "this had already happened by then" checks.
 */
export function fakeSpawner(options: { fail?: unknown; onSpawn?: () => void } = {}): FakeSpawn {
  const spawns: FakeSpawn["spawns"] = [];
  return {
    spawns,
    spawner: async (executable, argv) => {
      options.onSpawn?.();
      spawns.push({ executable, argv: [...argv] });
      if (options.fail !== undefined) throw options.fail;
    },
  };
}
