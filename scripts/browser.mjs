import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function openBrowser({
  url,
  outputDir,
  width = 1440,
  height = 1000,
} = {}) {
  const candidates = [
    process.env.ATK_BROWSER,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  const executable = candidates.find((p) => fs.existsSync(p));
  if (!executable)
    throw new Error(
      "No browser found. Set ATK_BROWSER to a Chromium/Chrome/Edge executable.",
    );
  fs.mkdirSync(outputDir, { recursive: true });
  const profile = fs.mkdtempSync(path.join(outputDir, "browser-"));
  const logfile = fs.openSync(path.join(outputDir, "browser.log"), "a");
  const child = spawn(
    executable,
    [
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      ...(process.platform === "linux" ? ["--no-sandbox"] : []),
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: ["ignore", logfile, logfile], windowsHide: true },
  );
  fs.closeSync(logfile);
  let port;
  for (let i = 0; i < 150; i++) {
    await sleep(100);
    try {
      port = Number(
        fs
          .readFileSync(path.join(profile, "DevToolsActivePort"), "utf8")
          .split("\n")[0],
      );
      break;
    } catch {}
  }
  if (!port) {
    child.kill();
    throw new Error("Browser did not expose its test endpoint");
  }
  const close = async () => {
    child.kill();
    await sleep(200);
    if (process.platform === "win32" && child.pid)
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
  };
  try {
    return await attachBrowser({ port, url, outputDir, width, height, close });
  } catch (error) {
    await close();
    throw error;
  }
}

export async function attachBrowser({ port, url, outputDir, width = 1440, height = 1000, close }) {
  const tabs = await fetch(`http://127.0.0.1:${port}/json`).then((r) =>
    r.json(),
  );
  const target = tabs.find((t) => t.type === "page"),
    socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let nextId = 1;
  const pending = new Map(),
    errors = [];
  socket.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id) {
      const item = pending.get(msg.id);
      pending.delete(msg.id);
      if (item) {
        clearTimeout(item.timer);
        if (msg.error) item.reject(new Error(msg.error.message));
        else item.resolve(msg.result);
      }
    }
    if (msg.method === "Runtime.exceptionThrown")
      errors.push(
        msg.params.exceptionDetails.text +
          ": " +
          (msg.params.exceptionDetails.exception?.description ?? ""),
      );
  });
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("Browser command timed out: " + method));
      }, 20000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  if (url) await send("Page.navigate", { url });
  async function evaluate(expression) {
    const result = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text,
      );
    return result.result?.value;
  }
  async function wait(expression, timeout = 10000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return;
      await sleep(80);
    }
    throw new Error("Browser condition timed out: " + expression);
  }
  return {
    send,
    evaluate,
    wait,
    errors,
    async click(text, { exact = false, within = "document" } = {}) {
      const target = `[...(${within}).querySelectorAll('button')].find(e=>${exact ? "(e.getAttribute('aria-label')||e.textContent.trim())===" : "e.textContent.includes("}${JSON.stringify(text)}${exact ? "" : ")"})`;
      await wait(`!!(${within}) && !!(${target}) && !(${target}).disabled`);
      await evaluate(
        `(()=>{const el=${target};if(!el)throw new Error('Button not found');el.scrollIntoView({block:'center'});el.click();})()`,
      );
    },
    async fill(name, value) {
      await evaluate(
        `(()=>{const el=document.querySelector('[name="'+${JSON.stringify(name)}+'"]');if(!el)throw new Error('Field not found');const p=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:el.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));})()`,
      );
    },
    async submit() {
      await evaluate(
        "document.querySelector('[role=dialog] form').requestSubmit()",
      );
    },
    async screenshot(name) {
      const result = await send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: false,
      });
      const file = path.join(outputDir, name + ".png");
      fs.writeFileSync(file, Buffer.from(result.data, "base64"));
      return file;
    },
    async close() {
      socket.close();
      await close?.();
    },
  };
}
