// The embedded browser pane's page host (desktop_plan §7). WebContentsViews are
// owned by main; the active tab is composited over the renderer at the panel's
// rect. Sandboxed, own persistent partition, deny-by-default permissions, no
// webSecurity:false. D-INV-3: the view paints ABOVE all renderer DOM, so the
// renderer hides it (setVisible) under any overlay incl. the approval modal.
import { randomUUID } from "node:crypto";
import { shell, WebContentsView } from "electron";

const NAV_EVENTS = [
  "did-navigate",
  "did-navigate-in-page",
  "page-title-updated",
  "did-start-loading",
  "did-stop-loading",
];

// SECURITY: open/navigate URLs are agent/daemon-supplied (untrusted model
// output). Only web pages may load — loadURL is host-initiated so the
// will-navigate file:// guard below never sees it, and a file:// load plus
// the "read" action would disclose arbitrary local files to the agent.
const assertHttpUrl = (url) => {
  const protocol = new URL(url).protocol; // throws on garbage
  if (protocol !== "http:" && protocol !== "https:") {
    throw new Error(`refusing to load non-http(s) url (${protocol}//)`);
  }
};

const round = (b) => ({
  x: Math.round(b.x),
  y: Math.round(b.y),
  width: Math.round(b.width),
  height: Math.round(b.height),
});

export function createBrowserHost({ getWindow, broadcast, partition }) {
  const tabs = new Map();
  let activeTabId = null;
  let attachedView = null;
  let attachedTo = null;
  let lastBounds = { x: 0, y: 0, width: 0, height: 0 };

  const live = (tab) => tab && !tab.view.webContents.isDestroyed();
  const activeTab = () => tabs.get(activeTabId) ?? null;
  const tabState = (tab) => {
    const c = tab.view.webContents;
    const nav = c.navigationHistory;
    return {
      tabId: tab.tabId,
      url: c.getURL() || "",
      title: c.getTitle() || "New tab",
      loading: c.isLoading(),
      canGoBack: nav.canGoBack(),
      canGoForward: nav.canGoForward(),
    };
  };
  const listTabs = () => [...tabs.values()].filter(live).map(tabState);

  const emptyState = () => ({
    tabs: [],
    activeTabId: null,
    url: null,
    title: null,
    loading: false,
    canGoBack: false,
    canGoForward: false,
  });

  const emit = () => {
    const tab = activeTab();
    if (!live(tab)) {
      broadcast("agena:browser-state", emptyState());
      return;
    }
    const state = tabState(tab);
    broadcast("agena:browser-state", {
      tabs: listTabs(),
      activeTabId,
      url: state.url || null,
      title: state.title || null,
      loading: state.loading,
      canGoBack: state.canGoBack,
      canGoForward: state.canGoForward,
    });
  };

  const createTab = () => {
    const tabId = randomUUID();
    const view = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        partition,
      },
    });
    const c = view.webContents;
    const tab = { tabId, view };
    tabs.set(tabId, tab);
    // target=_blank / window.open → a new Agena tab (web URLs only).
    c.setWindowOpenHandler(({ url }) => {
      try {
        assertHttpUrl(url);
        void open(url, { newTab: true });
      } catch {
        // non-http(s) scheme — dropped
      }
      return { action: "deny" };
    });
    // deny-by-default permissions.
    c.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    // no local-file / custom-scheme access.
    c.on("will-navigate", (e, url) => {
      if (!/^https?:/i.test(url)) e.preventDefault();
    });
    for (const ev of NAV_EVENTS) c.on(ev, () => emit());
    return tab;
  };

  const attach = (tab) => {
    const host = getWindow();
    if (!host) throw new Error("browser window is not available");
    if (attachedTo && attachedView) {
      try {
        attachedTo.contentView.removeChildView(attachedView);
      } catch {
        /* window gone */
      }
    }
    host.contentView.addChildView(tab.view);
    attachedTo = host;
    attachedView = tab.view;
    tab.view.setBounds(round(lastBounds));
  };

  const activate = (tabId) => {
    const tab = tabs.get(tabId);
    if (!live(tab)) throw new Error(`unknown browser tab ${tabId}`);
    activeTabId = tabId;
    attach(tab);
    tab.view.setVisible(true);
    emit();
  };

  const open = async (url, { newTab = true } = {}) => {
    assertHttpUrl(url); // agent-supplied — the error surfaces to the requester
    const tab = !newTab && live(activeTab()) ? activeTab() : createTab();
    activate(tab.tabId);
    await tab.view.webContents.loadURL(url);
    emit();
    return pageState(tab.view.webContents, { tabId: tab.tabId });
  };

  const navigate = (action) => {
    if (action?.kind === "activate") return activate(action.tabId);
    if (action?.kind === "close") return closeTab(action.tabId);
    const tab = tabs.get(action?.tabId ?? activeTabId);
    if (!live(tab)) return;
    const c = tab.view.webContents;
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
        if (action.url) {
          assertHttpUrl(action.url);
          c.loadURL(action.url);
        }
        break;
    }
  };

  const setBounds = (b) => {
    lastBounds = b;
    const tab = activeTab();
    if (live(tab)) tab.view.setBounds(round(b));
  };

  const setVisible = (v) => {
    const tab = activeTab();
    if (live(tab)) tab.view.setVisible(!!v);
  };

  const openDevTools = () => {
    const tab = activeTab();
    if (live(tab)) tab.view.webContents.openDevTools({ mode: "detach" });
  };

  const destroyTab = (tab) => {
    if (!tab) return;
    if (attachedTo && attachedView === tab.view) {
      try {
        attachedTo.contentView.removeChildView(tab.view);
      } catch {
        /* window gone */
      }
    }
    if (!tab.view.webContents.isDestroyed()) {
      try {
        tab.view.webContents.close();
      } catch {
        /* already closing */
      }
    }
    tabs.delete(tab.tabId);
    if (attachedView === tab.view) {
      attachedView = null;
      attachedTo = null;
    }
  };

  const openExternal = async () => {
    const tab = activeTab();
    const url = live(tab) ? tab.view.webContents.getURL() : "";
    if (url) await shell.openExternal(url);
  };

  const closeTab = (tabId) => {
    const tab = tabs.get(tabId);
    if (!tab) return;
    const wasActive = activeTabId === tabId;
    destroyTab(tab);
    if (wasActive) {
      const next = [...tabs.values()].at(-1);
      activeTabId = next?.tabId ?? null;
      if (next) activate(next.tabId);
    }
    emit();
  };

  const close = () => {
    for (const tab of [...tabs.values()]) destroyTab(tab);
    activeTabId = null;
    emit();
  };

  const agentRequest = async (action) => {
    if (action.action === "open") return open(action.url, { newTab: true });
    if (action.action === "list") {
      const tab = activeTab();
      return {
        url: live(tab) ? tab.view.webContents.getURL() : "",
        title: live(tab) ? tab.view.webContents.getTitle() : "",
        tabs: listTabs(),
      };
    }
    if (action.action === "close") {
      closeTab(action.tabId);
      return { url: "", title: "", tabs: listTabs() };
    }
    const tab = tabs.get(action.tabId ?? activeTabId);
    if (!live(tab)) throw new Error("visible browser tab is not open");
    const c = tab.view.webContents;
    if (action.action === "navigate") {
      if (action.kind === "url" && action.url) {
        await c.loadURL(action.url);
      } else {
        navigate({ tabId: tab.tabId, kind: action.kind });
        await delay(100);
      }
      return pageState(c, { tabId: tab.tabId });
    }
    switch (action.action) {
      case "read":
        return pageState(c, {
          tabId: tab.tabId,
          includeHtml: !!action.includeHtml,
        });
      case "screenshot":
        return pageState(c, {
          tabId: tab.tabId,
          screenshot: await captureScreenshot(c, action.maxWidth ?? 1024),
        });
      case "click": {
        const value = action.selector
          ? await clickSelector(c, action.selector)
          : await clickPoint(c, action.x, action.y);
        await delay(100);
        return pageState(c, { tabId: tab.tabId, value });
      }
      case "type": {
        const value = action.selector
          ? await typeSelector(c, action.selector, action.text, !!action.submit)
          : await typeFocused(c, action.text, !!action.submit);
        await delay(100);
        return pageState(c, { tabId: tab.tabId, value });
      }
      case "evaluate": {
        const value = await evaluate(c, action.script);
        return pageState(c, { tabId: tab.tabId, value });
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
    ...(extras.tabId ? { tabId: extras.tabId } : {}),
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
