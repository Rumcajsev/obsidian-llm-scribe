var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main.ts
var main_exports = {};
__export(main_exports, {
  default: () => KbChatPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian2 = require("obsidian");
var https = __toESM(require("https"));
var http = __toESM(require("http"));
var import_state = require("@codemirror/state");

// src/embedding-store.ts
var import_obsidian = require("obsidian");
var SINGLE_THRESHOLD = 6e3;
var CHUNK_MAX = 1500;
var BATCH_SIZE = 50;
var OVERLAP_CHARS = 75;
function detectAttachments(content) {
  const re = /!?\[\[([^\]]+\.pdf)\]\]/gi;
  const found = [];
  let m;
  while ((m = re.exec(content)) !== null) found.push(m[1]);
  return [...new Set(found)];
}
function makePrefix(basename, heading) {
  return heading ? `${basename} > ${heading}

` : `${basename}

`;
}
function chunkNote(basename, content) {
  if (content.length <= SINGLE_THRESHOLD) {
    return [{ heading: "", text: makePrefix(basename, "") + content }];
  }
  const parts = content.split(/(?=\n#{2,3} )/);
  const sections = [];
  for (const part of parts) {
    const body = part.trim();
    if (!body) continue;
    const nl = body.indexOf("\n");
    const firstLine = (nl >= 0 ? body.slice(0, nl) : body).trim();
    const isHeading = /^#{2,3} /.test(firstLine);
    sections.push({
      heading: isHeading ? firstLine.replace(/^#+\s+/, "") : "",
      body
    });
  }
  const chunks = [];
  for (const sec of sections) {
    if (!sec.body.trim()) continue;
    const prefix = makePrefix(basename, sec.heading);
    if (sec.body.length <= CHUNK_MAX) {
      chunks.push({ heading: sec.heading, text: prefix + sec.body });
      continue;
    }
    const paras = sec.body.split(/\n\n+/);
    let acc = "";
    let overlap = "";
    for (const para of paras) {
      const addLen = acc ? acc.length + 2 + para.length : para.length;
      if (addLen > CHUNK_MAX && acc.length > 0) {
        chunks.push({ heading: sec.heading, text: prefix + acc.trim() });
        const tail = acc.slice(-OVERLAP_CHARS).trim();
        const spaceIdx = tail.indexOf(" ");
        overlap = spaceIdx > 0 ? tail.slice(spaceIdx + 1) : tail;
        acc = overlap ? overlap + "\n\n" + para : para;
      } else {
        acc = acc ? acc + "\n\n" + para : para;
      }
    }
    if (acc.trim()) chunks.push({ heading: sec.heading, text: prefix + acc.trim() });
  }
  return chunks.length > 0 ? chunks : [{ heading: "", text: makePrefix(basename, "") + content.slice(0, SINGLE_THRESHOLD) }];
}
function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
var EmbeddingStore = class {
  constructor(app, dbPath) {
    this.db = { version: 1, model: "", notes: {} };
    this.app = app;
    this.dbPath = dbPath;
  }
  async load() {
    try {
      if (await this.app.vault.adapter.exists(this.dbPath)) {
        const raw = await this.app.vault.adapter.read(this.dbPath);
        this.db = JSON.parse(raw);
      }
    } catch (e) {
      this.db = { version: 1, model: "", notes: {} };
    }
  }
  async save() {
    await this.app.vault.adapter.write(this.dbPath, JSON.stringify(this.db));
  }
  isIndexed() {
    return Object.keys(this.db.notes).length > 0;
  }
  indexedCount() {
    return Object.keys(this.db.notes).length;
  }
  async index(files, apiKey, model, onProgress, baseUrl) {
    var _a, _b;
    this.db.model = model;
    const toIndex = [];
    for (const file of files) {
      const content = await this.app.vault.read(file);
      const existing = this.db.notes[file.path];
      if (!existing || existing.mtime !== file.stat.mtime)
        toIndex.push({ file, content });
    }
    const validPaths = new Set(files.map((f) => f.path));
    for (const path of Object.keys(this.db.notes))
      if (!validPaths.has(path)) delete this.db.notes[path];
    if (toIndex.length === 0) {
      onProgress(0, 0);
      return;
    }
    const jobs = [];
    const noteData = /* @__PURE__ */ new Map();
    for (const { file, content } of toIndex) {
      const rawChunks = chunkNote(file.basename, content);
      const attachments = detectAttachments(content);
      noteData.set(file.path, {
        mtime: file.stat.mtime,
        attachments,
        chunks: rawChunks.map((c) => ({ ...c, embedding: [] }))
      });
      rawChunks.forEach(
        (c, idx) => jobs.push({ path: file.path, mtime: file.stat.mtime, attachments, idx, text: c.text, heading: c.heading })
      );
    }
    const chunkTotal = /* @__PURE__ */ new Map();
    const chunkDone = /* @__PURE__ */ new Map();
    for (const j of jobs) chunkTotal.set(j.path, ((_a = chunkTotal.get(j.path)) != null ? _a : 0) + 1);
    let completedNotes = 0;
    for (let i = 0; i < jobs.length; i += BATCH_SIZE) {
      const batch = jobs.slice(i, i + BATCH_SIZE);
      const embeddings = await this.embedTexts(batch.map((j) => j.text), apiKey, model, baseUrl);
      for (let k = 0; k < batch.length; k++) {
        const job = batch[k];
        noteData.get(job.path).chunks[job.idx].embedding = embeddings[k];
        const done = ((_b = chunkDone.get(job.path)) != null ? _b : 0) + 1;
        chunkDone.set(job.path, done);
        if (done === chunkTotal.get(job.path)) completedNotes++;
      }
      onProgress(completedNotes, toIndex.length);
    }
    for (const [path, entry] of noteData)
      this.db.notes[path] = entry;
    await this.save();
  }
  async update(path, mtime, basename, content, apiKey, model, baseUrl) {
    const rawChunks = chunkNote(basename, content);
    const attachments = detectAttachments(content);
    const embeddings = await this.embedTexts(rawChunks.map((c) => c.text), apiKey, model, baseUrl);
    this.db.notes[path] = {
      mtime,
      attachments,
      chunks: rawChunks.map((c, i) => ({ heading: c.heading, text: c.text, embedding: embeddings[i] }))
    };
    await this.save();
  }
  remove(path) {
    delete this.db.notes[path];
    this.save();
  }
  async search(queryText, apiKey, model, k, baseUrl) {
    const [queryVec] = await this.embedTexts([queryText], apiKey, model, baseUrl);
    const hits = [];
    for (const [path, entry] of Object.entries(this.db.notes)) {
      for (const chunk of entry.chunks) {
        if (!chunk.embedding.length) continue;
        const score = cosineSim(queryVec, chunk.embedding);
        const text = chunk.text.replace(/^[^\n]+\n\n/, "");
        hits.push({ path, score, heading: chunk.heading, text });
      }
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, k);
  }
  async embedTexts(texts, apiKey, model, baseUrl) {
    var _a, _b;
    const url = baseUrl ? `${baseUrl.replace(/\/$/, "")}/embeddings` : "https://api.voyageai.com/v1/embeddings";
    const resp = await (0, import_obsidian.requestUrl)({
      url,
      method: "POST",
      headers: {
        ...apiKey ? { "Authorization": `Bearer ${apiKey}` } : {},
        "content-type": "application/json"
      },
      body: JSON.stringify({ input: texts, model }),
      throw: false
    });
    if (resp.status !== 200) {
      const err = resp.json;
      throw new Error((_b = (_a = err.detail) != null ? _a : err.message) != null ? _b : `Voyage API error ${resp.status}`);
    }
    const data = resp.json;
    return data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
};

// src/main.ts
var import_view = require("@codemirror/view");
var VIEW_TYPE = "kb-chat";
var ANTHROPIC_MODELS = {
  "claude-opus-4-7": "Opus 4.7",
  "claude-sonnet-4-6": "Sonnet 4.6",
  "claude-haiku-4-5-20251001": "Haiku 4.5",
  "claude-opus-4-5": "Opus 4.5",
  "claude-sonnet-4-5": "Sonnet 4.5",
  "claude-haiku-3-5": "Haiku 3.5"
};
var DEFAULT_SETTINGS = {
  provider: "anthropic",
  anthropicApiKey: "",
  anthropicModel: "claude-sonnet-4-6",
  litellmBaseUrl: "http://localhost:4000",
  litellmApiKey: "",
  shiftEnterToSend: false,
  basePrompt: "You are a helpful thinking partner.",
  editMode: "on_request",
  createMode: "on_request",
  appendMode: "on_request",
  voyageApiKey: "",
  voyageModel: "voyage-3-lite",
  semanticResultCount: 7
};
function anthropicStream(apiKey, body, onEvent) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.anthropic.com",
      port: 443,
      path: "/v1/messages",
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      }
    }, (res) => {
      if (res.statusCode !== 200) {
        let raw = "";
        res.on("data", (c) => {
          raw += c.toString();
        });
        res.on("end", () => {
          var _a, _b;
          try {
            const err = JSON.parse(raw);
            reject(new Error((_b = (_a = err.error) == null ? void 0 : _a.message) != null ? _b : `HTTP ${res.statusCode}`));
          } catch (e) {
            reject(new Error(`HTTP ${res.statusCode}`));
          }
        });
        return;
      }
      let buf = "";
      res.on("data", (chunk) => {
        var _a;
        buf += chunk.toString();
        const lines = buf.split("\n");
        buf = (_a = lines.pop()) != null ? _a : "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const raw = line.slice(6).trim();
          if (!raw || raw === "[DONE]") continue;
          try {
            onEvent(JSON.parse(raw));
          } catch (e) {
          }
        }
      });
      res.on("end", resolve);
      res.on("error", reject);
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}
function openaiStream(baseUrl, apiKey, body, onEvent) {
  return new Promise((resolve, reject) => {
    const url = new URL("/chat/completions", baseUrl.replace(/\/$/, ""));
    const isHttps = url.protocol === "https:";
    const transport = isHttps ? https : http;
    const port = url.port ? parseInt(url.port) : isHttps ? 443 : 80;
    const headers = { "content-type": "application/json" };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    const req = transport.request({
      hostname: url.hostname,
      port,
      path: url.pathname + url.search,
      method: "POST",
      headers
    }, (res) => {
      if (res.statusCode !== 200) {
        let raw = "";
        res.on("data", (c) => {
          raw += c.toString();
        });
        res.on("end", () => {
          var _a, _b;
          try {
            const err = JSON.parse(raw);
            reject(new Error((_b = (_a = err.error) == null ? void 0 : _a.message) != null ? _b : `HTTP ${res.statusCode}`));
          } catch (e) {
            reject(new Error(`HTTP ${res.statusCode}`));
          }
        });
        return;
      }
      let buf = "";
      res.on("data", (chunk) => {
        var _a;
        buf += chunk.toString();
        const lines = buf.split("\n");
        buf = (_a = lines.pop()) != null ? _a : "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const raw = line.slice(6).trim();
          if (!raw || raw === "[DONE]") continue;
          try {
            onEvent(JSON.parse(raw));
          } catch (e) {
          }
        }
      });
      res.on("end", resolve);
      res.on("error", reject);
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}
function toOAITool(t) {
  return { type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } };
}
var AddedLinesWidget = class extends import_view.WidgetType {
  constructor(lines) {
    super();
    this.lines = lines;
  }
  toDOM() {
    const wrap = document.createElement("div");
    for (const line of this.lines) {
      const el = document.createElement("div");
      el.className = "kb-diff-added";
      el.textContent = line === "" ? "\xA0" : line;
      wrap.appendChild(el);
    }
    return wrap;
  }
  eq(other) {
    return other.lines.length === this.lines.length && other.lines.every((l, i) => l === this.lines[i]);
  }
};
var setProposalEffect = import_state.StateEffect.define();
var proposalField = import_state.StateField.define({
  create: () => import_view.Decoration.none,
  update(decos, tr) {
    var _a;
    for (const effect of tr.effects) {
      if (effect.is(setProposalEffect)) return (_a = effect.value) != null ? _a : import_view.Decoration.none;
    }
    return decos.map(tr.changes);
  },
  provide: (f) => import_view.EditorView.decorations.from(f)
});
function computeDiff(origLines, propLines) {
  const m = origLines.length, n = propLines.length;
  const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i2 = 1; i2 <= m; i2++)
    for (let j2 = 1; j2 <= n; j2++)
      dp[i2][j2] = origLines[i2 - 1] === propLines[j2 - 1] ? dp[i2 - 1][j2 - 1] + 1 : Math.max(dp[i2 - 1][j2], dp[i2][j2 - 1]);
  const ops = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && origLines[i - 1] === propLines[j - 1]) {
      ops.unshift({ op: "keep" });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.unshift({ op: "add", text: propLines[j - 1] });
      j--;
    } else {
      ops.unshift({ op: "remove" });
      i--;
    }
  }
  return ops;
}
function buildDecorations(cmDoc, ops) {
  const specs = [];
  let origLine = 0;
  let pending = [];
  let specOrder = 0;
  function flushPending() {
    if (!pending.length) return;
    const atStart = origLine === 0;
    const pos = atStart ? cmDoc.lines >= 1 ? cmDoc.line(1).from : 0 : cmDoc.line(origLine).to;
    specs.push({ pos, order: specOrder++, kind: "widget", lines: [...pending], side: atStart ? -1 : 1 });
    pending = [];
  }
  for (const op of ops) {
    if (op.op === "add") {
      pending.push(op.text);
    } else {
      flushPending();
      if (op.op === "remove") {
        specs.push({ pos: cmDoc.line(origLine + 1).from, order: specOrder++, kind: "line" });
      }
      origLine++;
    }
  }
  flushPending();
  specs.sort((a, b) => a.pos !== b.pos ? a.pos - b.pos : a.order - b.order);
  const builder = new import_state.RangeSetBuilder();
  for (const s of specs) {
    if (s.kind === "line") {
      builder.add(s.pos, s.pos, import_view.Decoration.line({ class: "kb-diff-removed" }));
    } else {
      builder.add(s.pos, s.pos, import_view.Decoration.widget({
        widget: new AddedLinesWidget(s.lines),
        block: true,
        side: s.side
      }));
    }
  }
  return builder.finish();
}
var ANTHROPIC_SEARCH_TOOL = {
  name: "search_notes",
  description: "Semantically search the vault for notes related to a query. Use this when the user's question might be answered by their notes, before creating a new note (to check for existing ones), or to find the right note to modify.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "A natural language description of what to search for." }
    },
    required: ["query"]
  }
};
var ANTHROPIC_CREATE_TOOL = {
  name: "create_notes",
  description: "Propose creating one or more new notes in the vault. Call this tool directly \u2014 do not describe the creation in text. Always use search_notes first to check no suitable note already exists. Each item is shown as a separate proposal for the user to confirm individually.",
  input_schema: {
    type: "object",
    properties: {
      notes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            path: { type: "string", description: 'Full vault path including .md extension (e.g. "Areas/Health/Meditation.md"). Default to the same folder as the current note unless context suggests otherwise.' },
            title: { type: "string", description: "Title of the note, used as the H1 heading." },
            content: { type: "string", description: "Initial markdown content. Omit the H1 title \u2014 it is added automatically. Can be empty." }
          },
          required: ["path", "title", "content"]
        }
      }
    },
    required: ["notes"]
  }
};
var ANTHROPIC_MODIFY_TOOL = {
  name: "modify_notes",
  description: 'Propose appending content to or editing one or more existing notes. Call this tool directly \u2014 do not describe the action in text. Use search_notes first to identify the right notes. Each item is shown as a separate proposal for the user to confirm individually. Use "append" to add new content without touching existing content. Use "edit" only when existing content needs to change \u2014 the user will see a diff and the full note will be replaced, so use it carefully.',
  input_schema: {
    type: "object",
    properties: {
      modifications: {
        type: "array",
        items: {
          type: "object",
          properties: {
            path: { type: "string", description: "Full vault path of the note." },
            operation: { type: "string", enum: ["append", "edit"], description: '"append" adds content without affecting existing content. "edit" replaces the entire note \u2014 use only when existing content must change.' },
            content: { type: "string", description: "For append: markdown content to add. For edit: the complete new note content." },
            heading: { type: "string", description: "For append only: optional heading name to append under. If omitted, content is appended at the end." }
          },
          required: ["path", "operation", "content"]
        }
      }
    },
    required: ["modifications"]
  }
};
function appendToSection(noteContent, heading, newContent) {
  const trimmed = noteContent.trimEnd();
  if (!heading) return trimmed + "\n\n" + newContent;
  const lines = noteContent.split("\n");
  const re = new RegExp(`^(#{1,6})\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i");
  const hi = lines.findIndex((l) => re.test(l));
  if (hi === -1) return trimmed + "\n\n" + newContent;
  const level = lines[hi].match(/^(#{1,6})/)[1].length;
  let sectionEnd = lines.length;
  for (let i = hi + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s/);
    if (m && m[1].length <= level) {
      sectionEnd = i;
      break;
    }
  }
  let ins = sectionEnd;
  while (ins > hi + 1 && !lines[ins - 1].trim()) ins--;
  const before = lines.slice(0, ins).join("\n");
  const after = sectionEnd < lines.length ? "\n\n" + lines.slice(sectionEnd).join("\n") : "";
  return before + "\n\n" + newContent + after;
}
var ChatView = class extends import_obsidian2.ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.messages = [];
    this.isBusy = false;
    this.activeFilePath = null;
    this.currentSessionPath = null;
    this.currentNotePath = null;
    this.standaloneMode = false;
    this.sessionTitle = null;
    this.contextFiles = [];
    this.plugin = plugin;
  }
  getViewType() {
    return VIEW_TYPE;
  }
  getDisplayText() {
    return "KB Chat";
  }
  getIcon() {
    return "message-circle";
  }
  get activeSessionPath() {
    return this.currentSessionPath;
  }
  async onOpen() {
    var _a;
    this.buildUI();
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        var _a2;
        const file = this.app.workspace.getActiveFile();
        const path = (_a2 = file == null ? void 0 : file.path) != null ? _a2 : null;
        if (path === this.activeFilePath) return;
        this.activeFilePath = path;
        if (this.standaloneMode) return;
        this.switchToNote(file);
      })
    );
    const initialFile = this.app.workspace.getActiveFile();
    this.activeFilePath = (_a = initialFile == null ? void 0 : initialFile.path) != null ? _a : null;
    await this.switchToNote(initialFile);
  }
  buildUI() {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("kb-chat-container");
    this.sessionBarEl = container.createDiv("kb-session-bar");
    this.sessionBarEl.addEventListener("click", (e) => this.openSessionMenu(e));
    this.messagesEl = container.createDiv("kb-chat-messages");
    const inputArea = container.createDiv("kb-chat-input-area");
    this.contextPillsEl = inputArea.createDiv("kb-context-pills");
    this.setupDragDrop(container);
    const hint = this.plugin.settings.shiftEnterToSend ? "Shift+Enter to send" : "Enter to send";
    this.inputEl = inputArea.createEl("textarea", {
      attr: { placeholder: `Ask\u2026 (${hint})` }
    });
    this.inputEl.addEventListener("keydown", (e) => {
      const sendKey = this.plugin.settings.shiftEnterToSend ? e.key === "Enter" && e.shiftKey : e.key === "Enter" && !e.shiftKey;
      if (sendKey) {
        e.preventDefault();
        this.sendMessage();
      }
    });
    this.modelIndicatorEl = inputArea.createDiv("kb-model-indicator");
    this.updateModelIndicator();
    this.modelIndicatorEl.addEventListener("click", (e) => this.openModelMenu(e));
  }
  // ── Session management ────────────────────────────────────────────────────
  async switchToNote(file) {
    var _a;
    this.standaloneMode = false;
    this.currentNotePath = (_a = file == null ? void 0 : file.path) != null ? _a : null;
    this.messages = [];
    this.messagesEl.empty();
    this.contextFiles = [];
    this.contextPillsEl.empty();
    this.currentSessionPath = null;
    this.sessionTitle = null;
    const sessions = await this.listSessions(this.currentNotePath);
    if (sessions.length > 0) await this.loadSession(sessions[sessions.length - 1]);
    if (file) this.addContextFile(file);
    await this.updateSessionBar();
  }
  async startNewSession(standalone = false) {
    if (standalone) {
      this.standaloneMode = true;
      this.currentNotePath = null;
    }
    this.messages = [];
    this.messagesEl.empty();
    this.currentSessionPath = null;
    this.contextFiles = [];
    this.contextPillsEl.empty();
    this.sessionTitle = null;
    if (!standalone && this.currentNotePath) {
      const f = this.app.vault.getAbstractFileByPath(this.currentNotePath);
      if (f instanceof import_obsidian2.TFile) this.addContextFile(f);
    }
    await this.updateSessionBar();
  }
  async openExternalSession(sessionPath, notePath) {
    this.standaloneMode = notePath === null;
    this.currentNotePath = notePath;
    this.messages = [];
    this.messagesEl.empty();
    this.contextFiles = [];
    this.contextPillsEl.empty();
    this.sessionTitle = null;
    await this.loadSession(sessionPath);
    if (notePath) {
      const f = this.app.vault.getAbstractFileByPath(notePath);
      if (f instanceof import_obsidian2.TFile) this.addContextFile(f);
    }
    await this.updateSessionBar();
  }
  async listSessions(notePath) {
    const dir = notePath ? `.chats/${notePath.replace(/\.md$/, "")}` : ".chats/_global";
    if (!await this.app.vault.adapter.exists(dir)) return [];
    try {
      const listing = await this.app.vault.adapter.list(dir);
      return listing.files.filter((f) => f.endsWith(".md")).sort();
    } catch (e) {
      return [];
    }
  }
  async loadSession(path) {
    this.messages = [];
    this.messagesEl.empty();
    this.currentSessionPath = path;
    this.sessionTitle = null;
    if (!await this.app.vault.adapter.exists(path)) return;
    const raw = await this.app.vault.adapter.read(path);
    const titleMatch = raw.match(/^<!-- TITLE: (.+?) -->/);
    if (titleMatch) this.sessionTitle = titleMatch[1];
    const re = /<!-- MSG:(user|assistant):(\d+) -->\n([\s\S]*?)<!-- \/MSG -->/g;
    let match;
    while ((match = re.exec(raw)) !== null)
      this.messages.push({ role: match[1], content: match[3].trimEnd(), timestamp: parseInt(match[2]) });
    for (const msg of this.messages)
      this.renderMessage(msg.role, msg.content, msg.timestamp);
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }
  async saveSession() {
    if (!this.messages.length) return;
    if (!this.currentSessionPath) {
      const dir = this.currentNotePath ? `.chats/${this.currentNotePath.replace(/\.md$/, "")}` : ".chats/_global";
      const ts = (/* @__PURE__ */ new Date()).toISOString().slice(0, 19).replace(/:/g, "-");
      this.currentSessionPath = `${dir}/${ts}.md`;
      await this.ensureFolder(dir);
    }
    const msgs = this.messages.map(
      (m) => {
        var _a;
        return `<!-- MSG:${m.role}:${(_a = m.timestamp) != null ? _a : Date.now()} -->
${m.content}
<!-- /MSG -->`;
      }
    ).join("\n\n");
    const content = this.sessionTitle ? `<!-- TITLE: ${this.sessionTitle} -->
${msgs}` : msgs;
    await this.app.vault.adapter.write(this.currentSessionPath, content);
    await this.updateSessionBar();
    if (this.messages.length === 2 && !this.sessionTitle) {
      this.generateSessionTitle();
    }
  }
  async updateSessionBar() {
    var _a, _b, _c;
    this.sessionBarEl.empty();
    const sessions = await this.listSessions(this.currentNotePath);
    const idx = this.currentSessionPath ? sessions.indexOf(this.currentSessionPath) : -1;
    let label;
    if (this.standaloneMode) {
      const titlePart = this.sessionTitle ? ` \xB7 ${this.sessionTitle}` : "";
      label = idx >= 0 ? `Standalone${titlePart} \xB7 ${this.sessionDateLabel(sessions[idx])}` : "New standalone chat";
    } else if (!this.currentNotePath) {
      label = "No note open";
    } else {
      const name = (_b = (_a = this.currentNotePath.split("/").pop()) == null ? void 0 : _a.replace(/\.md$/, "")) != null ? _b : "";
      if (idx >= 0) {
        const chatLabel = (_c = this.sessionTitle) != null ? _c : `Chat ${idx + 1}${sessions.length > 1 ? ` of ${sessions.length}` : ""}`;
        label = `${name} \xB7 ${chatLabel} \xB7 ${this.sessionDateLabel(sessions[idx])}`;
      } else {
        label = `${name} \xB7 New chat`;
      }
    }
    this.sessionBarEl.createSpan({ text: label + " \u25BE", cls: "kb-session-label" });
  }
  sessionDateLabel(path) {
    const ts = path.split("/").pop().replace(".md", "").replace(/T(\d{2})-(\d{2})-\d{2}$/, "T$1:$2:00");
    const d = new Date(ts);
    return isNaN(d.getTime()) ? "" : this.formatStamp(d.getTime());
  }
  async openSessionMenu(e) {
    const sessions = await this.listSessions(this.currentNotePath);
    const titles = await Promise.all(sessions.map((p) => this.readSessionTitle(p)));
    const menu = new import_obsidian2.Menu();
    if (this.standaloneMode) {
      const activeFile = this.app.workspace.getActiveFile();
      menu.addItem((item) => {
        item.setTitle(activeFile ? `Follow active note: ${activeFile.basename}` : "Follow active note");
        if (activeFile) item.onClick(() => this.switchToNote(activeFile));
      });
      menu.addSeparator();
    }
    sessions.forEach((path, i) => {
      const label = titles[i] ? `${titles[i]} \xB7 ${this.sessionDateLabel(path)}` : `Chat ${i + 1} \xB7 ${this.sessionDateLabel(path)}`;
      menu.addItem(
        (item) => item.setTitle(label).setChecked(path === this.currentSessionPath).onClick(async () => {
          await this.loadSession(path);
          this.contextFiles = [];
          this.contextPillsEl.empty();
          if (this.currentNotePath) {
            const f = this.app.vault.getAbstractFileByPath(this.currentNotePath);
            if (f instanceof import_obsidian2.TFile) this.addContextFile(f);
          }
          await this.updateSessionBar();
        })
      );
    });
    if (sessions.length) menu.addSeparator();
    if (this.currentNotePath) {
      menu.addItem((item) => item.setTitle("New chat for this note").onClick(() => this.startNewSession(false)));
    }
    menu.addItem((item) => item.setTitle("New standalone chat").onClick(() => this.startNewSession(true)));
    if (!this.standaloneMode) {
      const standaloneSessions = await this.listSessions(null);
      if (standaloneSessions.length > 0) {
        const recent = standaloneSessions.slice(-5).reverse();
        const recentTitles = await Promise.all(recent.map((p) => this.readSessionTitle(p)));
        menu.addSeparator();
        recent.forEach((path, i) => {
          var _a;
          const label = (_a = recentTitles[i]) != null ? _a : this.sessionDateLabel(path);
          menu.addItem(
            (item) => item.setTitle(`Standalone \xB7 ${label}`).onClick(() => this.openExternalSession(path, null))
          );
        });
      }
    }
    menu.showAtMouseEvent(e);
  }
  async readSessionTitle(path) {
    try {
      const raw = await this.app.vault.adapter.read(path);
      const m = raw.match(/^<!-- TITLE: (.+?) -->/);
      return m ? m[1] : null;
    } catch (e) {
      return null;
    }
  }
  async generateSessionTitle() {
    var _a, _b, _c, _d, _e, _f, _g;
    if (this.messages.length < 2) return;
    const userMsg = this.messages[0].content.slice(0, 500);
    const assistantMsg = this.messages[1].content.slice(0, 500);
    const prompt = `Summarize this conversation in 4-7 words as a chat title. Reply with only the title, no quotes or trailing punctuation.

User: ${userMsg}

Assistant: ${assistantMsg}`;
    const { provider, anthropicApiKey, anthropicModel, litellmBaseUrl, litellmApiKey } = this.plugin.settings;
    try {
      let title = "";
      if (provider === "litellm") {
        const resp = await (0, import_obsidian2.requestUrl)({
          url: `${litellmBaseUrl.replace(/\/$/, "")}/chat/completions`,
          method: "POST",
          headers: {
            ...litellmApiKey ? { "Authorization": `Bearer ${litellmApiKey}` } : {},
            "content-type": "application/json"
          },
          body: JSON.stringify({ model: anthropicModel, max_tokens: 30, messages: [{ role: "user", content: prompt }] }),
          throw: false
        });
        if (resp.status !== 200) return;
        const data = resp.json;
        title = (_d = (_c = (_b = (_a = data.choices[0]) == null ? void 0 : _a.message) == null ? void 0 : _b.content) == null ? void 0 : _c.trim()) != null ? _d : "";
      } else {
        const resp = await (0, import_obsidian2.requestUrl)({
          url: "https://api.anthropic.com/v1/messages",
          method: "POST",
          headers: { "x-api-key": anthropicApiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
          body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 30, messages: [{ role: "user", content: prompt }] }),
          throw: false
        });
        if (resp.status !== 200) return;
        const data = resp.json;
        title = (_g = (_f = (_e = data.content.find((b) => b.type === "text")) == null ? void 0 : _e.text) == null ? void 0 : _f.trim()) != null ? _g : "";
      }
      if (!title) return;
      this.sessionTitle = title;
      await this.saveSession();
    } catch (e) {
    }
  }
  // ── Context pills ─────────────────────────────────────────────────────────
  addContextFile(file) {
    if (file.extension !== "md") return;
    if (this.contextFiles.some((f) => f.path === file.path)) return;
    this.contextFiles.push(file);
    this.renderContextPill(file);
  }
  renderContextPill(file) {
    const pill = this.contextPillsEl.createDiv("kb-context-pill");
    const iconEl = pill.createSpan("kb-pill-icon");
    (0, import_obsidian2.setIcon)(iconEl, "file-text");
    pill.createSpan({ text: file.basename, cls: "kb-pill-name" });
    const x = pill.createEl("button", { cls: "kb-pill-remove" });
    (0, import_obsidian2.setIcon)(x, "x");
    x.addEventListener("click", (ev) => {
      ev.stopPropagation();
      this.contextFiles = this.contextFiles.filter((f) => f.path !== file.path);
      pill.remove();
    });
  }
  setupDragDrop(container) {
    let depth = 0;
    container.addEventListener("dragenter", (e) => {
      e.preventDefault();
      if (++depth === 1) container.addClass("kb-drag-over");
    });
    container.addEventListener("dragleave", () => {
      if (--depth === 0) container.removeClass("kb-drag-over");
    });
    container.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    });
    container.addEventListener("drop", (e) => {
      var _a, _b, _c;
      e.preventDefault();
      depth = 0;
      container.removeClass("kb-drag-over");
      const dm = this.app.dragManager;
      const draggable = dm == null ? void 0 : dm.draggable;
      if ((draggable == null ? void 0 : draggable.type) === "file" && draggable.file instanceof import_obsidian2.TFile) {
        this.addContextFile(draggable.file);
        return;
      }
      if (draggable == null ? void 0 : draggable.files) {
        for (const f of draggable.files)
          if (f instanceof import_obsidian2.TFile && f.extension === "md") this.addContextFile(f);
        return;
      }
      const text = (_b = (_a = e.dataTransfer) == null ? void 0 : _a.getData("text/plain")) != null ? _b : "";
      const byPath = this.app.vault.getAbstractFileByPath(text);
      const file = byPath instanceof import_obsidian2.TFile ? byPath : (_c = this.app.metadataCache.getFirstLinkpathDest(text, "")) != null ? _c : null;
      if (file instanceof import_obsidian2.TFile) this.addContextFile(file);
    });
  }
  // ── System prompt ─────────────────────────────────────────────────────────
  async resolveSemanticContext(userMessage) {
    if (!this.plugin.canSearch()) return [];
    const { semanticResultCount } = this.plugin.settings;
    const ec = this.plugin.embeddingConfig();
    try {
      const recentUserMessages = this.messages.filter((m) => m.role === "user").slice(-5).map((m) => m.content);
      const queryText = [
        ...this.contextFiles.map((f) => f.basename),
        ...recentUserMessages,
        userMessage
      ].join("\n");
      const contextPaths = new Set(this.contextFiles.map((f) => f.path));
      const hits = await this.plugin.embeddingStore.search(queryText, ec.apiKey, ec.model, semanticResultCount, ec.baseUrl);
      return hits.filter((h) => !contextPaths.has(h.path));
    } catch (e) {
      return [];
    }
  }
  async buildSystemPrompt(userMessage, semanticHits) {
    var _a, _b;
    const base = this.plugin.settings.basePrompt.trim() || DEFAULT_SETTINGS.basePrompt;
    const contextBlocks = await Promise.all(this.contextFiles.map(async (f) => {
      const content = await this.app.vault.read(f);
      return `## ${f.basename}

${content}`;
    }));
    const multi = this.contextFiles.length > 1;
    let editHint = "";
    if (this.contextFiles.length >= 1) {
      const mode = this.plugin.settings.editMode;
      if (mode === "on_request") {
        editHint = " Only use the modify_notes tool to edit notes when the user explicitly asks you to edit or update them.";
      } else if (mode === "proactive") {
        editHint = " You may proactively propose edits using the modify_notes tool when the conversation produces something clearly worth capturing: a decision reached, a significant refinement of an idea, a new section that naturally extends a note, or an action item that emerged. Do not suggest edits for minor clarifications or conversational exchanges.";
      }
    }
    let prompt = contextBlocks.length ? `${base} The user has the following note${multi ? "s" : ""} as context:

${contextBlocks.join("\n\n---\n\n")}

Help them think through ideas.${editHint}` : base;
    if (semanticHits.length > 0) {
      const byNote = /* @__PURE__ */ new Map();
      for (const hit of semanticHits) {
        const arr = byNote.get(hit.path);
        if (arr) arr.push(hit);
        else byNote.set(hit.path, [hit]);
      }
      const relatedBlocks = (await Promise.all([...byNote.entries()].map(async ([path, hits]) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof import_obsidian2.TFile)) return null;
        const sections = hits.map((h) => h.heading ? `### ${h.heading}

${h.text}` : h.text).join("\n\n");
        return `## ${file.basename}

${sections}`;
      }))).filter(Boolean);
      if (relatedBlocks.length > 0)
        prompt += `

---

Potentially related notes (retrieved by semantic search \u2014 reference if relevant, suggest [[wikilinks]] where appropriate):

${relatedBlocks.join("\n\n---\n\n")}`;
    }
    const canSearch = this.plugin.canSearch();
    if (canSearch)
      prompt += " Use the search_notes tool when the user's question might be answered by their notes, or before creating or appending to a note.";
    const createMode = this.plugin.settings.createMode;
    const editMode = this.plugin.settings.editMode;
    const appendMode = this.plugin.settings.appendMode;
    const canCreate = createMode !== "never";
    const canModify = editMode !== "never" || appendMode !== "never";
    if (canCreate || canModify) {
      const currentFolder = (_b = (_a = this.contextFiles[0]) == null ? void 0 : _a.parent) == null ? void 0 : _b.path;
      const folderHint = currentFolder ? ` Default new notes to the "${currentFolder}" folder unless context suggests a better location.` : "";
      const isProactive = createMode === "proactive" || editMode === "proactive" || appendMode === "proactive";
      const trigger = isProactive ? "When the conversation produces something worth saving" : "When the user asks to save something";
      let hint = ` ${trigger}, always use search_notes first, then immediately call the appropriate tool \u2014 no text between the search result and the tool call.`;
      if (canModify && canCreate)
        hint += ` Use modify_notes to append or edit existing notes (prefer append unless content must change), or create_notes if no suitable note exists.`;
      else if (canModify)
        hint += ` Use modify_notes to append or edit existing notes \u2014 prefer append unless existing content must change.`;
      else
        hint += ` Use create_notes if no suitable note exists.`;
      hint += ` Never write text that describes or announces what you are about to do with a tool \u2014 do not say "I'll create", "Creating now", "No existing note, so I will\u2026" or anything similar. Call the tool directly, then write any explanatory text after.${folderHint}`;
      prompt += hint;
    }
    return prompt;
  }
  renderSemanticPreview(hits, msgEl) {
    const seen = /* @__PURE__ */ new Set();
    const files = [];
    for (const hit of hits) {
      if (seen.has(hit.path)) continue;
      seen.add(hit.path);
      const file = this.app.vault.getAbstractFileByPath(hit.path);
      if (file instanceof import_obsidian2.TFile) files.push(file);
    }
    if (!files.length) return;
    let open = false;
    const indicator = msgEl.createDiv("kb-semantic-indicator");
    indicator.setText(`${files.length} related`);
    const list = msgEl.createDiv("kb-semantic-list");
    list.style.display = "none";
    indicator.addEventListener("click", () => {
      open = !open;
      list.style.display = open ? "" : "none";
      indicator.toggleClass("is-open", open);
    });
    for (const file of files) {
      const row = list.createDiv("kb-semantic-item");
      const nameEl = row.createSpan({ text: file.basename, cls: "kb-semantic-name" });
      nameEl.addEventListener(
        "click",
        () => this.app.workspace.openLinkText(file.path, "", false)
      );
      const addBtn = row.createEl("button", { cls: "kb-semantic-add", attr: { title: "Add to context" } });
      (0, import_obsidian2.setIcon)(addBtn, "plus");
      addBtn.addEventListener("click", () => {
        this.addContextFile(file);
        addBtn.disabled = true;
        addBtn.empty();
        (0, import_obsidian2.setIcon)(addBtn, "check");
      });
    }
  }
  updateModelIndicator() {
    var _a;
    const { anthropicModel } = this.plugin.settings;
    const label = (_a = ANTHROPIC_MODELS[anthropicModel]) != null ? _a : anthropicModel;
    this.modelIndicatorEl.setText(`Claude ${label} \u25BE`);
  }
  openModelMenu(e) {
    const currentModel = this.plugin.settings.anthropicModel;
    const menu = new import_obsidian2.Menu();
    for (const [id, label] of Object.entries(ANTHROPIC_MODELS)) {
      menu.addItem(
        (item) => item.setTitle("Claude " + label).setChecked(id === currentModel).onClick(async () => {
          this.plugin.settings.anthropicModel = id;
          await this.plugin.saveSettings();
          this.updateModelIndicator();
        })
      );
    }
    menu.showAtMouseEvent(e);
  }
  async sendMessage() {
    if (this.isBusy) return;
    const text = this.inputEl.value.trim();
    if (!text) return;
    const { provider, anthropicApiKey, litellmBaseUrl } = this.plugin.settings;
    if (provider === "anthropic" && !anthropicApiKey) {
      new import_obsidian2.Notice("Add your Anthropic API key in Settings \u2192 KB Chat");
      return;
    }
    if (provider === "litellm" && !litellmBaseUrl) {
      new import_obsidian2.Notice("Add your LiteLLM base URL in Settings \u2192 KB Chat");
      return;
    }
    const editableFile = this.contextFiles.length === 1 && this.contextFiles[0].extension === "md" ? this.contextFiles[0] : null;
    let originalContent = "";
    if (editableFile) originalContent = await this.app.vault.read(editableFile);
    const semanticHits = await this.resolveSemanticContext(text);
    const system = await this.buildSystemPrompt(text, semanticHits);
    this.inputEl.value = "";
    this.messagesEl.querySelectorAll(".kb-message-assistant").forEach((el) => el.style.minHeight = "");
    this.messages.push({ role: "user", content: text, timestamp: Date.now() });
    const userMsgEl = this.renderMessage("user", text);
    if (semanticHits.length > 0) this.renderSemanticPreview(semanticHits, userMsgEl);
    const { el: msgEl, textEl, stampEl } = this.renderPendingMessage();
    const spacer = this.messagesEl.clientHeight - userMsgEl.offsetHeight - 36;
    if (spacer > 0) msgEl.style.minHeight = `${spacer}px`;
    this.messagesEl.scrollTo({ top: userMsgEl.offsetTop - 12, behavior: "smooth" });
    this.isBusy = true;
    this.inputEl.disabled = true;
    try {
      const caller = this.plugin.settings.provider === "litellm" ? this.callLiteLLM.bind(this) : this.callAnthropic.bind(this);
      const { text: reply, proposedCreates, proposedModifications } = await caller(system, this.messages.slice(0, -1), text, editableFile, (chunk) => {
        this.renderMarkdownTo(textEl, chunk);
      });
      const timestamp = Date.now();
      stampEl.setText(this.formatStamp(timestamp));
      const hasProposal = (proposedCreates == null ? void 0 : proposedCreates.length) || (proposedModifications == null ? void 0 : proposedModifications.length);
      if (!hasProposal) {
        const displayText = reply || "(no response)";
        this.renderMarkdownTo(textEl, displayText);
        this.messages.push({ role: "assistant", content: displayText, timestamp });
        await this.saveSession();
      } else {
        textEl.empty();
        this.messages.push({ role: "assistant", content: reply, timestamp });
        await this.saveSession();
        if (proposedCreates == null ? void 0 : proposedCreates.length) {
          for (const pc of proposedCreates) {
            this.renderProposalCard(msgEl, {
              icon: "file-plus",
              actionLabel: "Create note",
              target: pc.path,
              reason: "",
              content: pc.content,
              applyLabel: "\u2713 Create",
              onApply: async () => {
                const folder = pc.path.split("/").slice(0, -1).join("/");
                if (folder) await this.ensureFolder(folder);
                const full = `# ${pc.title}

${pc.content}`.trimEnd();
                return await this.app.vault.create(pc.path, full);
              },
              onDismiss: () => {
              }
            });
          }
        }
        if (proposedModifications == null ? void 0 : proposedModifications.length) {
          for (const mod of proposedModifications) {
            if (mod.operation === "edit") {
              if (editableFile && mod.path === editableFile.path) {
                this.plugin.showProposal(editableFile, originalContent, mod.content);
                this.renderProposalCard(msgEl, {
                  icon: "pencil",
                  actionLabel: "Edit note",
                  target: editableFile.basename,
                  reason: reply,
                  isEdit: true,
                  applyLabel: "\u2713 Apply changes",
                  onApply: async () => {
                    await this.plugin.applyProposal();
                    return null;
                  },
                  onDismiss: () => {
                    this.plugin.clearProposal();
                  }
                });
              } else {
                this.renderProposalCard(msgEl, {
                  icon: "pencil",
                  actionLabel: "Edit note",
                  target: mod.path,
                  reason: "",
                  content: mod.content,
                  isEdit: true,
                  applyLabel: "\u2713 Apply changes",
                  onApply: async () => {
                    const file = this.app.vault.getAbstractFileByPath(mod.path);
                    if (!(file instanceof import_obsidian2.TFile)) throw new Error(`Note not found: ${mod.path}`);
                    await this.app.vault.modify(file, mod.content);
                    return file;
                  },
                  onDismiss: () => {
                  }
                });
              }
            } else {
              const target = mod.heading ? `${mod.path}  \u203A  ${mod.heading}` : mod.path;
              this.renderProposalCard(msgEl, {
                icon: "list-plus",
                actionLabel: "Append to note",
                target,
                reason: "",
                content: mod.content,
                applyLabel: "\u2713 Append",
                onApply: async () => {
                  const file = this.app.vault.getAbstractFileByPath(mod.path);
                  if (!(file instanceof import_obsidian2.TFile)) throw new Error(`Note not found: ${mod.path}`);
                  const original = await this.app.vault.read(file);
                  await this.app.vault.modify(file, appendToSection(original, mod.heading, mod.content));
                  return file;
                },
                onDismiss: () => {
                }
              });
            }
          }
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      textEl.setText(`Error: ${msg}`);
    } finally {
      this.isBusy = false;
      this.inputEl.disabled = false;
      this.inputEl.focus();
    }
  }
  async callAnthropic(system, history, userMessage, file, onChunk) {
    const apiMessages = [
      ...history.map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: userMessage }
    ];
    const { semanticResultCount } = this.plugin.settings;
    const ec = this.plugin.embeddingConfig();
    const canSearch = this.plugin.canSearch();
    const canModify = this.plugin.settings.editMode !== "never" || this.plugin.settings.appendMode !== "never";
    const tools = [
      ...canSearch ? [ANTHROPIC_SEARCH_TOOL] : [],
      ...this.plugin.settings.createMode !== "never" ? [ANTHROPIC_CREATE_TOOL] : [],
      ...canModify ? [ANTHROPIC_MODIFY_TOOL] : []
    ];
    let finalText = "";
    let proposedCreates = null;
    let proposedModifications = null;
    for (let turn = 0; turn < 8; turn++) {
      const blockMap = /* @__PURE__ */ new Map();
      let stopReason = "";
      let accText = "";
      await anthropicStream(
        this.plugin.settings.anthropicApiKey,
        JSON.stringify({
          model: this.plugin.settings.anthropicModel,
          max_tokens: turn === 0 ? 4096 : 1024,
          stream: true,
          system,
          messages: apiMessages,
          ...tools.length ? { tools } : {}
        }),
        (ev) => {
          var _a, _b, _c, _d, _e;
          switch (ev.type) {
            case "content_block_start": {
              const cb = ev.content_block;
              if (cb.type === "text") blockMap.set(ev.index, { type: "text", text: "" });
              else if (cb.type === "tool_use") blockMap.set(ev.index, { type: "tool_use", id: cb.id, name: cb.name, inputJson: "" });
              break;
            }
            case "content_block_delta": {
              const b = blockMap.get(ev.index);
              if (!b) break;
              if (((_a = ev.delta) == null ? void 0 : _a.type) === "text_delta" && b.type === "text") {
                const chunk = (_b = ev.delta.text) != null ? _b : "";
                b.text += chunk;
                accText += chunk;
                onChunk(accText);
              } else if (((_c = ev.delta) == null ? void 0 : _c.type) === "input_json_delta" && b.type === "tool_use") {
                b.inputJson += (_d = ev.delta.partial_json) != null ? _d : "";
              }
              break;
            }
            case "message_delta":
              if ((_e = ev.delta) == null ? void 0 : _e.stop_reason) stopReason = ev.delta.stop_reason;
              break;
          }
        }
      );
      const sortedBlocks = [...blockMap.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
      const contentBlocks = sortedBlocks.map((b) => {
        if (b.type === "text") return { type: "text", text: b.text };
        let input = {};
        try {
          input = JSON.parse(b.inputJson);
        } catch (e) {
        }
        return { type: "tool_use", id: b.id, name: b.name, input };
      });
      apiMessages.push({ role: "assistant", content: contentBlocks });
      if (stopReason !== "tool_use") {
        finalText = accText;
        break;
      }
      const toolResults = [];
      for (const block of contentBlocks) {
        if (block.type !== "tool_use") continue;
        if (block.name === "search_notes" && canSearch) {
          const query = block.input.query;
          const hits = await this.plugin.embeddingStore.search(query, ec.apiKey, ec.model, semanticResultCount, ec.baseUrl);
          const results = hits.map((h) => {
            const f = this.app.vault.getAbstractFileByPath(h.path);
            return {
              path: h.path,
              title: f instanceof import_obsidian2.TFile ? f.basename : h.path,
              heading: h.heading || void 0,
              content: h.text,
              relevance: Math.round(h.score * 100) / 100
            };
          });
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(results) });
        } else if (block.name === "create_notes") {
          const inp = block.input;
          proposedCreates = inp.notes.map((n) => {
            var _a;
            return { path: n.path, title: n.title, content: (_a = n.content) != null ? _a : "" };
          });
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: "Proposals shown to user." });
        } else if (block.name === "modify_notes") {
          const inp = block.input;
          proposedModifications = inp.modifications.map((m) => ({ path: m.path, operation: m.operation, content: m.content, heading: m.heading }));
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: "Proposals shown to user." });
        }
      }
      if (toolResults.length) apiMessages.push({ role: "user", content: toolResults });
    }
    return { text: finalText, proposedCreates, proposedModifications };
  }
  async callLiteLLM(system, history, userMessage, _file, onChunk) {
    const { litellmBaseUrl, litellmApiKey, semanticResultCount } = this.plugin.settings;
    const ec = this.plugin.embeddingConfig();
    const canSearch = this.plugin.canSearch();
    const canModify = this.plugin.settings.editMode !== "never" || this.plugin.settings.appendMode !== "never";
    const rawTools = [
      ...canSearch ? [ANTHROPIC_SEARCH_TOOL] : [],
      ...this.plugin.settings.createMode !== "never" ? [ANTHROPIC_CREATE_TOOL] : [],
      ...canModify ? [ANTHROPIC_MODIFY_TOOL] : []
    ];
    const tools = rawTools.map(toOAITool);
    const oaiMessages = [
      { role: "system", content: system },
      ...history.map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: userMessage }
    ];
    let finalText = "";
    let proposedCreates = null;
    let proposedModifications = null;
    for (let turn = 0; turn < 8; turn++) {
      const toolCallMap = /* @__PURE__ */ new Map();
      let accText = "";
      let finishReason = "";
      await openaiStream(
        litellmBaseUrl,
        litellmApiKey,
        JSON.stringify({
          model: this.plugin.settings.anthropicModel,
          max_tokens: turn === 0 ? 4096 : 1024,
          stream: true,
          messages: oaiMessages,
          ...tools.length ? { tools } : {}
        }),
        (ev) => {
          var _a, _b, _c, _d, _e, _f, _g, _h;
          const choice = (_a = ev.choices) == null ? void 0 : _a[0];
          if (!choice) return;
          if (choice.finish_reason) finishReason = choice.finish_reason;
          const delta = choice.delta;
          if (delta.content) {
            accText += delta.content;
            onChunk(accText);
          }
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const existing = toolCallMap.get(tc.index);
              if (existing) {
                existing.arguments += (_c = (_b = tc.function) == null ? void 0 : _b.arguments) != null ? _c : "";
              } else {
                toolCallMap.set(tc.index, {
                  id: (_d = tc.id) != null ? _d : "",
                  name: (_f = (_e = tc.function) == null ? void 0 : _e.name) != null ? _f : "",
                  arguments: (_h = (_g = tc.function) == null ? void 0 : _g.arguments) != null ? _h : ""
                });
              }
            }
          }
        }
      );
      const toolCalls = [...toolCallMap.entries()].sort((a, b) => a[0] - b[0]).map(([, tc]) => tc);
      if (finishReason !== "tool_calls" || toolCalls.length === 0) {
        finalText = accText;
        break;
      }
      oaiMessages.push({
        role: "assistant",
        content: accText || null,
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.arguments }
        }))
      });
      for (const tc of toolCalls) {
        let result = "";
        let parsed = {};
        try {
          parsed = JSON.parse(tc.arguments);
        } catch (e) {
        }
        if (tc.name === "search_notes" && canSearch) {
          const query = parsed.query;
          const hits = await this.plugin.embeddingStore.search(query, ec.apiKey, ec.model, semanticResultCount, ec.baseUrl);
          const results = hits.map((h) => {
            const f = this.app.vault.getAbstractFileByPath(h.path);
            return { path: h.path, title: f instanceof import_obsidian2.TFile ? f.basename : h.path, heading: h.heading || void 0, content: h.text, relevance: Math.round(h.score * 100) / 100 };
          });
          result = JSON.stringify(results);
        } else if (tc.name === "create_notes") {
          const inp = parsed;
          proposedCreates = inp.notes.map((n) => {
            var _a;
            return { path: n.path, title: n.title, content: (_a = n.content) != null ? _a : "" };
          });
          result = "Proposals shown to user.";
        } else if (tc.name === "modify_notes") {
          const inp = parsed;
          proposedModifications = inp.modifications.map((m) => ({ path: m.path, operation: m.operation, content: m.content, heading: m.heading }));
          result = "Proposals shown to user.";
        }
        oaiMessages.push({ role: "tool", tool_call_id: tc.id, content: result });
      }
    }
    return { text: finalText, proposedCreates, proposedModifications };
  }
  renderMessage(role, text, timestamp) {
    const el = this.messagesEl.createDiv(`kb-message kb-message-${role}`);
    el.createEl("div", { cls: "kb-message-role", text: role === "user" ? "You" : "AI" });
    const textEl = el.createEl("div", { cls: "kb-message-text" });
    if (role === "assistant") this.renderMarkdownTo(textEl, text);
    else textEl.setText(text);
    if (role === "assistant" && timestamp)
      el.createEl("div", { cls: "kb-message-stamp", text: this.formatStamp(timestamp) });
    return el;
  }
  async ensureFolder(path) {
    const parts = path.split("/");
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!await this.app.vault.adapter.exists(current))
        await this.app.vault.adapter.mkdir(current);
    }
  }
  renderPendingMessage() {
    const el = this.messagesEl.createDiv("kb-message kb-message-assistant");
    el.createEl("div", { cls: "kb-message-role", text: "AI" });
    const textEl = el.createEl("div", { cls: "kb-message-text", text: "\u2026" });
    const stampEl = el.createEl("div", { cls: "kb-message-stamp" });
    return { el, textEl, stampEl };
  }
  formatStamp(timestamp) {
    const d = new Date(timestamp);
    const now = /* @__PURE__ */ new Date();
    const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    if (d.getFullYear() !== now.getFullYear())
      return `${d.getDate()} ${d.toLocaleString("default", { month: "short" })} ${d.getFullYear()} \xB7 ${time}`;
    if (d.toDateString() !== now.toDateString())
      return `${d.getDate()} ${d.toLocaleString("default", { month: "short" })} \xB7 ${time}`;
    return time;
  }
  renderMarkdownTo(el, text) {
    el.empty();
    import_obsidian2.MarkdownRenderer.render(this.app, text, el, "", this);
  }
  renderProposalCard(msgEl, opts) {
    const card = msgEl.createDiv(opts.isEdit ? "kb-proposal-card kb-proposal-card--edit" : "kb-proposal-card");
    const header = card.createDiv("kb-card-header");
    const iconEl = header.createSpan("kb-card-icon");
    (0, import_obsidian2.setIcon)(iconEl, opts.icon);
    header.createSpan({ cls: "kb-card-label", text: opts.actionLabel });
    card.createDiv({ cls: "kb-card-target", text: opts.target });
    if (opts.reason) {
      const reasonEl = card.createDiv("kb-card-reason");
      import_obsidian2.MarkdownRenderer.render(this.app, opts.reason, reasonEl, "", this);
    }
    if (opts.content) {
      let open = false;
      const toggle = card.createEl("button", { cls: "kb-card-preview-toggle" });
      const toggleIcon = toggle.createSpan("kb-card-toggle-icon");
      const toggleText = toggle.createSpan();
      const preview = card.createEl("pre", { cls: "kb-card-preview" });
      const lines = opts.content.split("\n");
      preview.setText(lines.length > 12 ? lines.slice(0, 12).join("\n") + "\n\u2026" : opts.content);
      const refreshToggle = () => {
        toggleIcon.empty();
        (0, import_obsidian2.setIcon)(toggleIcon, open ? "chevron-down" : "chevron-right");
        toggleText.setText(open ? "Hide preview" : "Show preview");
        preview.style.display = open ? "" : "none";
      };
      refreshToggle();
      toggle.addEventListener("click", () => {
        open = !open;
        refreshToggle();
      });
    }
    const actions = card.createDiv("kb-proposal-actions");
    const applyBtn = actions.createEl("button", { text: opts.applyLabel, cls: "kb-apply-btn" });
    const dismissBtn = actions.createEl("button", { text: "Dismiss", cls: "kb-dismiss-btn" });
    const loadingText = opts.applyLabel.replace(/^✓ /, "") + "\u2026";
    applyBtn.addEventListener("click", async () => {
      applyBtn.textContent = loadingText;
      applyBtn.disabled = true;
      dismissBtn.disabled = true;
      try {
        const result = await opts.onApply();
        actions.empty();
        if (result) {
          const link = actions.createEl("button", { cls: "kb-created-link" });
          const linkIcon = link.createSpan("kb-created-link-icon");
          (0, import_obsidian2.setIcon)(linkIcon, "file-text");
          link.createSpan({ text: result.basename });
          link.addEventListener("click", () => this.app.workspace.openLinkText(result.path, "", false));
        } else {
          actions.createEl("span", { cls: "kb-applied-label", text: "Applied." });
        }
      } catch (e) {
        new import_obsidian2.Notice(e instanceof Error ? e.message : String(e));
        applyBtn.textContent = opts.applyLabel;
        applyBtn.disabled = false;
        dismissBtn.disabled = false;
      }
    });
    dismissBtn.addEventListener("click", () => {
      opts.onDismiss();
      card.remove();
    });
  }
  async onClose() {
  }
};
var VIEW_TYPE_HISTORY = "kb-chat-history";
var ChatHistoryView = class extends import_obsidian2.ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
  }
  getViewType() {
    return VIEW_TYPE_HISTORY;
  }
  getDisplayText() {
    return "Chat History";
  }
  getIcon() {
    return "history";
  }
  async onOpen() {
    await this.refresh();
  }
  async refresh() {
    var _a, _b;
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("kb-history-container");
    const header = container.createDiv("kb-history-header");
    header.createSpan({ text: "Chat History", cls: "kb-history-title" });
    const refreshBtn = header.createEl("button", { cls: "kb-history-refresh", attr: { title: "Refresh" } });
    (0, import_obsidian2.setIcon)(refreshBtn, "refresh-cw");
    refreshBtn.addEventListener("click", () => this.refresh());
    const scroll = container.createDiv("kb-history-scroll");
    const sessions = await this.loadSessions();
    if (sessions.length === 0) {
      scroll.createEl("p", { text: "No chat history yet.", cls: "kb-history-empty" });
      return;
    }
    const getChatView = () => {
      const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
      return (leaf == null ? void 0 : leaf.view) instanceof ChatView ? leaf.view : null;
    };
    for (const entry of sessions) {
      const item = scroll.createDiv("kb-history-item");
      if (((_a = getChatView()) == null ? void 0 : _a.activeSessionPath) === entry.sessionPath) item.addClass("is-active");
      const mainContent = item.createDiv("kb-history-item-main");
      mainContent.createDiv({ text: (_b = entry.title) != null ? _b : "Untitled", cls: "kb-history-item-title-text" });
      const meta = mainContent.createDiv({ cls: "kb-history-item-meta" });
      const typeLabel = meta.createSpan({
        text: entry.notePath ? entry.noteBasename : "Standalone",
        cls: entry.notePath ? "kb-history-item-type kb-history-item-type--note" : "kb-history-item-type kb-history-item-type--standalone"
      });
      meta.createSpan({ text: "\xB7", cls: "kb-history-item-meta-sep" });
      meta.createSpan({ text: this.formatDate(entry.mtime), cls: "kb-history-item-date" });
      const actions = item.createDiv("kb-history-item-actions");
      const deleteIcon = actions.createSpan({ cls: "kb-history-item-delete", attr: { title: "Delete session" } });
      (0, import_obsidian2.setIcon)(deleteIcon, "trash-2");
      deleteIcon.addEventListener("click", async (e) => {
        e.stopPropagation();
        try {
          const moved = await this.app.vault.adapter.trashSystem(entry.sessionPath);
          if (!moved) await this.app.vault.adapter.trashLocal(entry.sessionPath);
          item.remove();
          if (sessions.length === 1) await this.refresh();
        } catch (err) {
          new import_obsidian2.Notice(`Failed to delete session: ${err instanceof Error ? err.message : String(err)}`);
        }
      });
      item.addEventListener("click", async () => {
        const chatView = getChatView();
        if (!chatView) return;
        await chatView.openExternalSession(entry.sessionPath, entry.notePath);
        this.plugin.activateView();
      });
    }
  }
  formatDate(mtime) {
    return this.formatStamp(mtime);
  }
  formatStamp(timestamp) {
    const d = new Date(timestamp);
    const now = /* @__PURE__ */ new Date();
    const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    if (d.getFullYear() !== now.getFullYear())
      return `${d.getDate()} ${d.toLocaleString("default", { month: "short" })} ${d.getFullYear()} \xB7 ${time}`;
    if (d.toDateString() !== now.toDateString())
      return `${d.getDate()} ${d.toLocaleString("default", { month: "short" })} \xB7 ${time}`;
    return time;
  }
  async collectSessionFiles(dir) {
    if (!await this.app.vault.adapter.exists(dir)) return [];
    const result = [];
    const listing = await this.app.vault.adapter.list(dir);
    result.push(...listing.files.filter((f) => f.endsWith(".md")));
    for (const subdir of listing.folders)
      result.push(...await this.collectSessionFiles(subdir));
    return result;
  }
  async readTitle(path) {
    try {
      const raw = await this.app.vault.adapter.read(path);
      const m = raw.match(/^<!-- TITLE: (.+?) -->/);
      return m ? m[1] : null;
    } catch (e) {
      return null;
    }
  }
  async loadSessions() {
    const allPaths = await this.collectSessionFiles(".chats");
    const entries = await Promise.all(allPaths.map(async (sessionPath) => {
      const stat = await this.app.vault.adapter.stat(sessionPath);
      if (!stat) return null;
      const isStandalone = sessionPath.startsWith(".chats/_global/");
      const notePath = isStandalone ? null : sessionPath.replace(/^\.chats\//, "").replace(/\/[^/]+\.md$/, "") + ".md";
      const noteBasename = isStandalone ? "Standalone" : notePath.split("/").pop().replace(/\.md$/, "");
      const title = await this.readTitle(sessionPath);
      return {
        sessionPath,
        notePath,
        noteBasename,
        title,
        mtime: stat.mtime
      };
    }));
    return entries.filter((e) => e !== null).sort((a, b) => b.mtime - a.mtime);
  }
};
var KbChatPlugin = class extends import_obsidian2.Plugin {
  constructor() {
    super(...arguments);
    this.activeProposal = null;
    this.updateTimers = /* @__PURE__ */ new Map();
  }
  async onload() {
    await this.loadSettings();
    this.embeddingStore = new EmbeddingStore(this.app, `${this.manifest.dir}/embeddings.json`);
    await this.embeddingStore.load();
    this.registerEditorExtension([proposalField]);
    this.registerView(VIEW_TYPE, (leaf) => new ChatView(leaf, this));
    this.registerView(VIEW_TYPE_HISTORY, (leaf) => new ChatHistoryView(leaf, this));
    this.addRibbonIcon("message-circle", "KB Chat", () => this.activateView());
    this.addRibbonIcon("history", "Chat History", () => this.activateHistoryView());
    this.addCommand({ id: "open-kb-chat", name: "Open KB Chat", callback: () => this.activateView() });
    this.addCommand({ id: "open-kb-chat-history", name: "Open Chat History", callback: () => this.activateHistoryView() });
    this.addCommand({
      id: "start-standalone-chat",
      name: "Start new standalone chat",
      callback: async () => {
        await this.activateView();
        const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
        if ((leaf == null ? void 0 : leaf.view) instanceof ChatView) await leaf.view.startNewSession(true);
      }
    });
    this.addCommand({
      id: "index-vault-semantic",
      name: "Index vault for semantic search",
      callback: async () => {
        const { provider, voyageApiKey, litellmBaseUrl } = this.settings;
        if (provider === "anthropic" && !voyageApiKey) {
          new import_obsidian2.Notice("Add your Voyage API key in Settings \u2192 KB Chat first.");
          return;
        }
        if (provider === "litellm" && !litellmBaseUrl) {
          new import_obsidian2.Notice("Add your LiteLLM base URL in Settings \u2192 KB Chat first.");
          return;
        }
        const ec = this.embeddingConfig();
        const files = this.app.vault.getMarkdownFiles();
        new import_obsidian2.Notice(`KB Chat: indexing ${files.length} notes\u2026`);
        await this.embeddingStore.index(
          files,
          ec.apiKey,
          ec.model,
          (completed, total) => {
            if (total > 0 && (completed % 25 === 0 || completed === total))
              new import_obsidian2.Notice(`KB Chat: indexed ${completed}/${total} notes`);
          },
          ec.baseUrl
        );
        new import_obsidian2.Notice(`KB Chat: semantic index complete (${files.length} notes).`);
      }
    });
    this.addSettingTab(new KbChatSettingTab(this.app, this));
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (!(file instanceof import_obsidian2.TFile) || file.extension !== "md") return;
      if (!this.canSearch()) return;
      const existing = this.updateTimers.get(file.path);
      if (existing) clearTimeout(existing);
      this.updateTimers.set(file.path, setTimeout(async () => {
        this.updateTimers.delete(file.path);
        const ec = this.embeddingConfig();
        const content = await this.app.vault.read(file);
        await this.embeddingStore.update(file.path, file.stat.mtime, file.basename, content, ec.apiKey, ec.model, ec.baseUrl);
      }, 3e3));
    }));
    this.registerEvent(this.app.vault.on("delete", (file) => {
      if (file instanceof import_obsidian2.TFile && file.extension === "md")
        this.embeddingStore.remove(file.path);
    }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (file instanceof import_obsidian2.TFile && file.extension === "md")
        this.embeddingStore.remove(oldPath);
    }));
    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
      if (!(file instanceof import_obsidian2.TFile) || file.extension !== "md") return;
      menu.addItem(
        (item) => item.setTitle("Add to chat context").setIcon("message-circle").onClick(() => {
          const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
          if ((leaf == null ? void 0 : leaf.view) instanceof ChatView) leaf.view.addContextFile(file);
        })
      );
    }));
  }
  showProposal(file, originalContent, proposedContent) {
    this.activeProposal = { file, content: proposedContent };
    const cmView = this.getCmViewForFile(file);
    if (!cmView) return;
    const ops = computeDiff(originalContent.split("\n"), proposedContent.split("\n"));
    cmView.dispatch({ effects: setProposalEffect.of(buildDecorations(cmView.state.doc, ops)) });
  }
  async applyProposal() {
    if (!this.activeProposal) return;
    await this.app.vault.modify(this.activeProposal.file, this.activeProposal.content);
    this.clearProposal();
  }
  clearProposal() {
    var _a, _b;
    const file = (_a = this.activeProposal) == null ? void 0 : _a.file;
    this.activeProposal = null;
    if (file) (_b = this.getCmViewForFile(file)) == null ? void 0 : _b.dispatch({ effects: setProposalEffect.of(null) });
  }
  getCmViewForFile(file) {
    let found = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view instanceof import_obsidian2.MarkdownView && leaf.view.file === file) {
        found = leaf.view.editor.cm;
      }
    });
    return found;
  }
  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }
  async activateHistoryView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_HISTORY)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE_HISTORY, active: true });
    }
    workspace.revealLeaf(leaf);
    const view = leaf.view;
    if (view instanceof ChatHistoryView) await view.refresh();
  }
  embeddingConfig() {
    const { provider, voyageApiKey, voyageModel, litellmBaseUrl, litellmApiKey } = this.settings;
    if (provider === "litellm") return { apiKey: litellmApiKey, model: voyageModel, baseUrl: litellmBaseUrl };
    return { apiKey: voyageApiKey, model: voyageModel };
  }
  canSearch() {
    const { provider, voyageApiKey, litellmBaseUrl } = this.settings;
    const hasCredentials = provider === "litellm" ? !!litellmBaseUrl : !!voyageApiKey;
    return hasCredentials && this.embeddingStore.isIndexed();
  }
  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
};
var KbChatSettingTab = class extends import_obsidian2.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "KB Chat" });
    new import_obsidian2.Setting(containerEl).setName("Use Shift+Enter to send").setDesc("When on, Shift+Enter sends and Enter adds a new line. When off (default), Enter sends.").addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.shiftEnterToSend).onChange(async (value) => {
        this.plugin.settings.shiftEnterToSend = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian2.Setting(containerEl).setName("Base system prompt").setDesc("The opening instruction sent to the AI on every request. Context notes and tool hints are appended automatically.").addTextArea((area) => {
      area.setPlaceholder(DEFAULT_SETTINGS.basePrompt).setValue(this.plugin.settings.basePrompt).onChange(async (v) => {
        this.plugin.settings.basePrompt = v;
        await this.plugin.saveSettings();
      });
      area.inputEl.rows = 4;
      area.inputEl.style.width = "100%";
    });
    new import_obsidian2.Setting(containerEl).setName("Note editing").setDesc("Controls when the AI may use the edit_note tool to propose changes to the open note.").addDropdown(
      (drop) => drop.addOption("never", "Never \u2014 disable note editing").addOption("on_request", "On request only (default)").addOption("proactive", "Suggest when appropriate").setValue(this.plugin.settings.editMode).onChange(async (v) => {
        this.plugin.settings.editMode = v;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian2.Setting(containerEl).setName("Note creation").setDesc("Controls when the AI may use the create_note tool to propose creating a new note.").addDropdown(
      (drop) => drop.addOption("never", "Never \u2014 disable note creation").addOption("on_request", "On request only (default)").addOption("proactive", "Suggest when appropriate").setValue(this.plugin.settings.createMode).onChange(async (v) => {
        this.plugin.settings.createMode = v;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian2.Setting(containerEl).setName("Note appending").setDesc("Controls when the AI may use the append_to_note tool to propose adding content to an existing note.").addDropdown(
      (drop) => drop.addOption("never", "Never \u2014 disable note appending").addOption("on_request", "On request only (default)").addOption("proactive", "Suggest when appropriate").setValue(this.plugin.settings.appendMode).onChange(async (v) => {
        this.plugin.settings.appendMode = v;
        await this.plugin.saveSettings();
      })
    );
    containerEl.createEl("h3", { text: "AI provider" });
    new import_obsidian2.Setting(containerEl).setName("Provider").addDropdown(
      (drop) => drop.addOption("anthropic", "Anthropic (direct)").addOption("litellm", "LiteLLM").setValue(this.plugin.settings.provider).onChange(async (v) => {
        this.plugin.settings.provider = v;
        const { voyageModel } = this.plugin.settings;
        if (v === "litellm" && !voyageModel.startsWith("voyage/"))
          this.plugin.settings.voyageModel = `voyage/${voyageModel}`;
        else if (v === "anthropic" && voyageModel.startsWith("voyage/"))
          this.plugin.settings.voyageModel = voyageModel.replace("voyage/", "");
        await this.plugin.saveSettings();
        this.display();
      })
    );
    if (this.plugin.settings.provider === "anthropic") {
      containerEl.createEl("h3", { text: "Anthropic" });
      new import_obsidian2.Setting(containerEl).setName("API key").addText(
        (text) => text.setPlaceholder("sk-ant-\u2026").setValue(this.plugin.settings.anthropicApiKey).onChange(async (v) => {
          this.plugin.settings.anthropicApiKey = v.trim();
          await this.plugin.saveSettings();
        })
      );
      new import_obsidian2.Setting(containerEl).setName("Model").addDropdown((drop) => {
        for (const [id, label] of Object.entries(ANTHROPIC_MODELS)) drop.addOption(id, "Claude " + label);
        if (!(this.plugin.settings.anthropicModel in ANTHROPIC_MODELS))
          drop.addOption(this.plugin.settings.anthropicModel, this.plugin.settings.anthropicModel);
        drop.setValue(this.plugin.settings.anthropicModel);
        drop.onChange(async (v) => {
          this.plugin.settings.anthropicModel = v;
          await this.plugin.saveSettings();
        });
      });
    } else {
      containerEl.createEl("h3", { text: "LiteLLM" });
      new import_obsidian2.Setting(containerEl).setName("Base URL").setDesc("The URL where your LiteLLM proxy is running.").addText(
        (text) => text.setPlaceholder("http://localhost:4000").setValue(this.plugin.settings.litellmBaseUrl).onChange(async (v) => {
          this.plugin.settings.litellmBaseUrl = v.trim();
          await this.plugin.saveSettings();
        })
      );
      new import_obsidian2.Setting(containerEl).setName("API key").setDesc("Your LiteLLM master key. Leave blank if your instance has no auth.").addText(
        (text) => text.setPlaceholder("sk-\u2026").setValue(this.plugin.settings.litellmApiKey).onChange(async (v) => {
          this.plugin.settings.litellmApiKey = v.trim();
          await this.plugin.saveSettings();
        })
      );
      new import_obsidian2.Setting(containerEl).setName("Model").setDesc("Uses the same model selection as Anthropic above.").addDropdown((drop) => {
        for (const [id, label] of Object.entries(ANTHROPIC_MODELS)) drop.addOption(id, "Claude " + label);
        if (!(this.plugin.settings.anthropicModel in ANTHROPIC_MODELS))
          drop.addOption(this.plugin.settings.anthropicModel, this.plugin.settings.anthropicModel);
        drop.setValue(this.plugin.settings.anthropicModel);
        drop.onChange(async (v) => {
          this.plugin.settings.anthropicModel = v;
          await this.plugin.saveSettings();
        });
      });
    }
    containerEl.createEl("h3", { text: "Semantic search (Voyage AI)" });
    const voyageDesc = this.plugin.settings.provider === "litellm" ? 'Embeddings are routed through LiteLLM using the voyage model name below. Run "Index vault for semantic search" from the command palette after configuring LiteLLM.' : 'Voyage AI embeddings let the plugin find related notes across your vault and surface them as context. Run "Index vault for semantic search" from the command palette after adding your key.';
    containerEl.createEl("p", { text: voyageDesc, cls: "setting-item-description" });
    if (this.plugin.settings.provider === "anthropic") {
      new import_obsidian2.Setting(containerEl).setName("API key").addText(
        (text) => text.setPlaceholder("pa-\u2026").setValue(this.plugin.settings.voyageApiKey).onChange(async (v) => {
          this.plugin.settings.voyageApiKey = v.trim();
          await this.plugin.saveSettings();
        })
      );
    }
    new import_obsidian2.Setting(containerEl).setName("Model").addDropdown((drop) => {
      if (this.plugin.settings.provider === "litellm") {
        drop.addOption("voyage/voyage-3-lite", "voyage/voyage-3-lite (faster, cheaper)").addOption("voyage/voyage-3", "voyage/voyage-3 (higher quality)");
      } else {
        drop.addOption("voyage-3-lite", "voyage-3-lite (faster, cheaper)").addOption("voyage-3", "voyage-3 (higher quality)");
      }
      drop.setValue(this.plugin.settings.voyageModel).onChange(async (v) => {
        this.plugin.settings.voyageModel = v;
        await this.plugin.saveSettings();
      });
    });
    new import_obsidian2.Setting(containerEl).setName("Chunks to retrieve").setDesc("How many matching chunks to pull per message. Multiple chunks from the same note are grouped together.").addSlider(
      (slider) => slider.setLimits(1, 15, 1).setValue(this.plugin.settings.semanticResultCount).setDynamicTooltip().onChange(async (v) => {
        this.plugin.settings.semanticResultCount = v;
        await this.plugin.saveSettings();
      })
    );
    const indexCount = this.plugin.embeddingStore.indexedCount();
    new import_obsidian2.Setting(containerEl).setName("Index status").setDesc(indexCount > 0 ? `${indexCount} notes indexed.` : "Not indexed yet.").addButton(
      (btn) => btn.setButtonText("Re-index vault").onClick(async () => {
        const { provider, voyageApiKey, litellmBaseUrl } = this.plugin.settings;
        if (provider === "anthropic" && !voyageApiKey) {
          new import_obsidian2.Notice("Add your Voyage API key first.");
          return;
        }
        if (provider === "litellm" && !litellmBaseUrl) {
          new import_obsidian2.Notice("Add your LiteLLM base URL first.");
          return;
        }
        this.plugin.app.commands.executeCommandById("kb-chat:index-vault-semantic");
      })
    );
  }
};
