// The embedded browser pane's page host (desktop_plan §7). ONE WebContentsView
// (v1: single page), owned by main, composited over the renderer at the panel's
// rect. Sandboxed, own persistent partition, deny-by-default permissions, no
// webSecurity:false. D-INV-3: the view paints ABOVE all renderer DOM, so the
// renderer hides it (setVisible) under any overlay incl. the approval modal.
import { shell, WebContentsView } from "electron";

const NAV_EVENTS = [
  "did-navigate",
  "did-navigate-in-page",
  "page-title-updated",
  "did-start-loading",
  "did-stop-loading",
];

const round = (b) => ({
  x: Math.round(b.x),
  y: Math.round(b.y),
  width: Math.round(b.width),
  height: Math.round(b.height),
});

export function createBrowserHost({ getWindow, broadcast, partition }) {
  let view = null;
  let attachedTo = null;
  let lastBounds = { x: 0, y: 0, width: 0, height: 0 };

  const live = () => view && !view.webContents.isDestroyed();

  const emptyState = () => ({
    url: null,
    title: null,
    loading: false,
    canGoBack: false,
    canGoForward: false,
  });

  const emit = () => {
    if (!live()) {
      broadcast("agena:browser-state", emptyState());
      return;
    }
    const c = view.webContents;
    const nav = c.navigationHistory;
    broadcast("agena:browser-state", {
      url: c.getURL() || null,
      title: c.getTitle() || null,
      loading: c.isLoading(),
      canGoBack: nav.canGoBack(),
      canGoForward: nav.canGoForward(),
    });
  };

  const ensureView = () => {
    if (view) return;
    view = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        partition,
      },
    });
    const c = view.webContents;
    // target=_blank / window.open → stay in this pane.
    c.setWindowOpenHandler(({ url }) => {
      c.loadURL(url);
      return { action: "deny" };
    });
    // deny-by-default permissions.
    c.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    // no local-file access.
    c.on("will-navigate", (e, url) => {
      if (url.startsWith("file://")) e.preventDefault();
    });
    for (const ev of NAV_EVENTS) c.on(ev, () => emit());
  };

  const attach = (host, bounds) => {
    if (attachedTo === host) return;
    if (attachedTo) {
      try {
        attachedTo.contentView.removeChildView(view);
      } catch {
        /* window gone */
      }
    }
    host.contentView.addChildView(view);
    attachedTo = host;
    view.setBounds(round(bounds));
  };

  const open = async (url) => {
    const win = getWindow();
    if (!win) throw new Error("browser window is not available");
    ensureView();
    attach(win, lastBounds);
    view.setVisible(true);
    await view.webContents.loadURL(url);
    emit();
    return pageState(view.webContents);
  };

  const navigate = (action) => {
    if (!live()) return;
    const c = view.webContents;
    const nav = c.navigationHistory;
    switch (action?.kind) {
      case "back":
        if (nav.canGoBack()) nav.goBack();
        break;
      case "forward":
        if (nav.canGoForward()) nav.goForward();
        break;
      case "reload":
        c.reload();
        break;
      case "stop":
        c.stop();
        break;
      case "url":
        if (action.url) c.loadURL(action.url);
        break;
    }
  };

  const setBounds = (b) => {
    lastBounds = b;
    if (view) view.setBounds(round(b));
  };

  const setVisible = (v) => {
    if (view) view.setVisible(!!v);
  };

  const openDevTools = () => {
    if (live()) view.webContents.openDevTools({ mode: "detach" });
  };

  const destroyView = () => {
    if (!view) return;
    if (attachedTo) {
      try {
        attachedTo.contentView.removeChildView(view);
      } catch {
        /* window gone */
      }
    }
    if (!view.webContents.isDestroyed()) {
      try {
        view.webContents.close();
      } catch {
        /* already closing */
      }
    }
    view = null;
    attachedTo = null;
  };

  const openExternal = async () => {
    const url = live() ? view.webContents.getURL() : "";
    if (url) await shell.openExternal(url);
  };

  const close = () => {
    destroyView();
    emit();
  };

  const agentRequest = async (action) => {
    if (action.action === "open") return open(action.url);
    if (!live()) throw new Error("visible browser is not open");
    const c = view.webContents;
    switch (action.action) {
      case "read":
        return pageState(c, { includeHtml: !!action.includeHtml });
      case "screenshot":
        return pageState(c, {
          screenshot: await captureScreenshot(c, action.maxWidth ?? 1024),
        });
      case "click": {
        const value = action.selector
          ? await clickSelector(c, action.selector)
          : await clickPoint(c, action.x, action.y);
        await delay(100);
        return pageState(c, { value });
      }
      case "type": {
        const value = action.selector
          ? await typeSelector(c, action.selector, action.text, !!action.submit)
          : await typeFocused(c, action.text, !!action.submit);
        await delay(100);
        return pageState(c, { value });
      }
      case "evaluate": {
        const value = await evaluate(c, action.script);
        return pageState(c, { value });
      }
    }
  };

  return {
    open,
    navigate,
    setBounds,
    setVisible,
    openDevTools,
    openExternal,
    close,
    agentRequest,
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pageState(webContents, extras = {}) {
  const state = await webContents.executeJavaScript(
    `(() => {
      const text = document.body?.innerText ?? "";
      return {
        url: location.href,
        title: document.title,
        text: text.slice(0, 20000),
        ${extras.includeHtml ? "html: document.documentElement.outerHTML.slice(0, 50000)," : ""}
      };
    })()`,
    true,
  );
  return {
    url: String(state.url ?? webContents.getURL() ?? ""),
    title: String(state.title ?? webContents.getTitle() ?? ""),
    ...(typeof state.text === "string" ? { text: state.text } : {}),
    ...(typeof state.html === "string" ? { html: state.html } : {}),
    ...(extras.value !== undefined ? { value: extras.value } : {}),
    ...(extras.screenshot ? { screenshot: extras.screenshot } : {}),
  };
}

async function captureScreenshot(webContents, maxWidth) {
  const raw = await webContents.capturePage();
  const size = raw.getSize();
  const image =
    size.width > maxWidth ? raw.resize({ width: Math.round(maxWidth) }) : raw;
  const out = image.getSize();
  return {
    mimeType: "image/jpeg",
    base64: image.toJPEG(75).toString("base64"),
    width: out.width,
    height: out.height,
  };
}

function selectorScript(selector, body) {
  return `(() => {
    const selector = ${JSON.stringify(selector)};
    const el = document.querySelector(selector);
    if (!el) throw new Error("selector not found: " + selector);
    ${body}
  })()`;
}

async function clickSelector(webContents, selector) {
  return webContents.executeJavaScript(
    selectorScript(
      selector,
      `el.scrollIntoView({ block: "center", inline: "center" });
       const rect = el.getBoundingClientRect();
       el.click();
       return {
         selector,
         tagName: el.tagName,
         text: (el.innerText || el.value || "").slice(0, 1000),
         x: Math.round(rect.left + rect.width / 2),
         y: Math.round(rect.top + rect.height / 2)
       };`,
    ),
    true,
  );
}

async function clickPoint(webContents, x, y) {
  if (typeof x !== "number" || typeof y !== "number") {
    throw new Error("click requires selector or x/y");
  }
  const point = { x: Math.round(x), y: Math.round(y) };
  webContents.sendInputEvent({ type: "mouseMove", ...point });
  webContents.sendInputEvent({ type: "mouseDown", button: "left", ...point });
  webContents.sendInputEvent({ type: "mouseUp", button: "left", ...point });
  return point;
}

async function typeSelector(webContents, selector, text, submit) {
  return webContents.executeJavaScript(
    selectorScript(
      selector,
      `el.scrollIntoView({ block: "center", inline: "center" });
       el.focus();
       const text = ${JSON.stringify(text)};
       if ("value" in el) {
         el.value = text;
         el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
         el.dispatchEvent(new Event("change", { bubbles: true }));
       } else {
         el.textContent = text;
         el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
       }
       if (${submit ? "true" : "false"}) {
         const form = el.form || el.closest("form");
         if (form?.requestSubmit) form.requestSubmit();
         else if (form) form.submit();
       }
       return { selector, tagName: el.tagName, text };`,
    ),
    true,
  );
}

async function typeFocused(webContents, text, submit) {
  await webContents.insertText(text);
  if (submit) {
    webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
    webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
  }
  return { text, submitted: submit };
}

async function evaluate(webContents, script) {
  return webContents.executeJavaScript(
    `(async () => (0, eval)(${JSON.stringify(script)}))()`,
    true,
  );
}
