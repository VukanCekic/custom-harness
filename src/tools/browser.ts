import { BrowserClaw, type CrawlPage } from "browserclaw";
import type { Tool } from "./types.js";
import fs from "node:fs";

export interface BrowserToolArgs {
  action?: "open" | "snapshot" | "click" | "type" | "press" | "wait" | "eval" | "close";
  command?: string;
  url?: string;
  ref?: string;
  text?: string;
  key?: string;
  ms?: number;
  js?: string;
}

let browser: BrowserClaw | null = null;
let page: CrawlPage | null = null;

function findChrome(): string | undefined {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe` : "",
    "/usr/bin/google-chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  ];
  return candidates.find(p => p && fs.existsSync(p));
}

async function getPage(): Promise<CrawlPage> {
  if (browser && page) {
    try {
      const pw = await page.playwrightPage();
      if (pw.isClosed()) {
        await closeBrowser();
      }
    } catch {
      await closeBrowser();
    }
  }

  if (!browser || !page) {
    const chromePath = findChrome();
    browser = await BrowserClaw.launch({
      executablePath: chromePath,
      headless: process.env.HEADLESS === "true", // Visible window by default
      chromeArgs: ["--start-maximized", "--new-window"]
    });
    page = await browser.currentPage();
    const pw = await page.playwrightPage();
    await pw.bringToFront().catch(() => {});
  }
  return page;
}

export async function closeBrowser(): Promise<void> {
  if (browser) {
    const b = browser;
    browser = null;
    page = null;
    await b.stop().catch(() => { });
  }
}

// Clean up Chrome process if Node exits
process.on("exit", () => {
  if (browser) browser.stop().catch(() => { });
});

export const browserTool: Tool<BrowserToolArgs, string> = {
  name: "browser",
  schema: {
    type: "function",
    function: {
      name: "browser",
      description:
        "Control a visible browser with browserclaw (snapshot + ref targeting). Actions: open, snapshot, click, type, press, wait, eval, close.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["open", "snapshot", "click", "type", "press", "wait", "eval", "close"],
            description: "Action to perform"
          },
          url: { type: "string", description: "URL for 'open'" },
          ref: { type: "string", description: "Element ref from snapshot (e.g. 'e1')" },
          text: { type: "string", description: "Text to type" },
          key: { type: "string", description: "Key to press (e.g. 'Enter')" },
          ms: { type: "number", description: "Milliseconds to wait" },
          js: { type: "string", description: "JavaScript to evaluate" },
          command: {
            type: "string",
            description: "Optional shorthand (e.g. 'open https://...', 'snapshot', 'click e1', 'type e1 text', 'press Enter')"
          }
        }
      }
    }
  },
  execute: async (args: BrowserToolArgs) => {
    let action = args.action;
    let url = args.url;
    let ref = args.ref;
    let text = args.text;
    let key = args.key;
    let ms = args.ms;
    let js = args.js;

    // Parse shorthand command if provided
    if (args.command) {
      const trimmed = args.command.trim();
      const parts = trimmed.split(/\s+/);
      const cmd = parts[0]?.toLowerCase();
      const rest = trimmed.slice(cmd.length).trim().replace(/^["']|["']$/g, "");

      if (cmd === "open" || cmd === "goto") {
        action = "open";
        url = rest;
      } else if (cmd === "snapshot" || cmd === "snap") {
        action = "snapshot";
      } else if (cmd === "click") {
        action = "click";
        ref = rest;
      } else if (cmd === "press") {
        action = "press";
        key = rest;
      } else if (cmd === "wait" || cmd === "sleep") {
        action = "wait";
        ms = parseInt(rest, 10);
      } else if (cmd === "eval" || cmd === "evaluate") {
        action = "eval";
        js = rest;
      } else if (cmd === "close" || cmd === "stop") {
        action = "close";
      } else if (cmd === "keyboard") {
        action = "type";
        text = rest.replace(/^type\s+/i, "");
      } else if (cmd === "type" || cmd === "fill") {
        action = "type";
        ref = parts[1];
        text = parts.slice(2).join(" ");
        if (!text) {
          text = ref;
          ref = undefined;
        }
      }
    }

    if (action === "close") {
      await closeBrowser();
      return "✓ Browser closed";
    }

    try {
      const p = await getPage();
      const cleanRef = ref?.replace(/^@/, "");

      switch (action) {
        case "open": {
          if (!url) return "Error: url is required";
          const target = url.startsWith("http") ? url : `https://${url}`;
          await p.goto(target);
          const pw = await p.playwrightPage();
          await pw.bringToFront().catch(() => {});
          return `Navigated to ${await p.url()} (${await p.title()})`;
        }

        case "snapshot": {
          const { snapshot } = await p.snapshot({ interactive: true, compact: true });
          return snapshot || "(empty page)";
        }

        case "click": {
          if (!cleanRef) return "Error: ref is required for click";
          await p.click(cleanRef);
          return `✓ Clicked ${cleanRef}`;
        }

        case "type": {
          if (cleanRef) {
            await p.type(cleanRef, text || "");
            return `✓ Typed into ${cleanRef}`;
          }
          const pw = await p.playwrightPage();
          await pw.keyboard.type(text || "");
          return `✓ Typed "${text}"`;
        }

        case "press": {
          if (!key) return "Error: key is required";
          await p.press(key);
          return `✓ Pressed ${key}`;
        }

        case "wait": {
          await p.waitFor({ timeMs: ms || 1000 });
          return `✓ Waited ${ms || 1000}ms`;
        }

        case "eval": {
          if (!js) return "Error: js expression is required";
          const res = await p.evaluate(js);
          return typeof res === "object" ? JSON.stringify(res, null, 2) : String(res);
        }

        default:
          return `Error: Unknown action "${action}". Available: open, snapshot, click, type, press, wait, eval, close.`;
      }
    } catch (err: any) {
      return `Browser error: ${err.message || String(err)}`;
    }
  }
};
