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
  options: { profileRoot: string; env?: Record<string, string | undefined>; chromium?: boolean },
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
      clock,
      profileRoot: options.profileRoot,
      locate: () => (options.chromium === false ? null : "C:/fake/chromium/chrome.exe"),
      launch: async (profileDir, launchOptions) => {
        launches.push({ profileDir, options: launchOptions });
        return context;
      },
    },
  };
}
