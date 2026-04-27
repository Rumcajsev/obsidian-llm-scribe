import {
	App, ItemView, MarkdownRenderer, Menu, Plugin, PluginSettingTab, Setting,
	WorkspaceLeaf, Notice, requestUrl, setIcon, TFile, MarkdownView,
} from 'obsidian';
import * as https from 'https';
import * as http from 'http';
import { StateField, StateEffect, RangeSetBuilder } from '@codemirror/state';
import { EmbeddingStore, ChunkHit } from './embedding-store';
import { EditorView, Decoration, DecorationSet, WidgetType } from '@codemirror/view';

const VIEW_TYPE = 'kb-chat';

// ── Model lists ───────────────────────────────────────────────────────────────

const ANTHROPIC_MODELS: Record<string, string> = {
	'claude-opus-4-7':           'Opus 4.7',
	'claude-sonnet-4-6':         'Sonnet 4.6',
	'claude-haiku-4-5-20251001': 'Haiku 4.5',
	'claude-opus-4-5':           'Opus 4.5',
	'claude-sonnet-4-5':         'Sonnet 4.5',
	'claude-haiku-3-5':          'Haiku 3.5',
};

// ── Settings ──────────────────────────────────────────────────────────────────

type EditMode = 'never' | 'on_request' | 'proactive';
type Provider = 'anthropic' | 'litellm';

interface KbChatSettings {
	provider: Provider;
	anthropicApiKey: string;
	anthropicModel: string;
	litellmBaseUrl: string;
	litellmApiKey: string;
	litellmChatModel: string;
	litellmEmbedModel: string;
	shiftEnterToSend: boolean;
	basePrompt: string;
	editMode: EditMode;
	createMode: EditMode;
	appendMode: EditMode;
	voyageApiKey: string;
	voyageModel: string;
	semanticResultCount: number;
}

const DEFAULT_SETTINGS: KbChatSettings = {
	provider: 'anthropic',
	anthropicApiKey: '',
	anthropicModel: 'claude-sonnet-4-6',
	litellmBaseUrl: 'http://localhost:4000',
	litellmApiKey: '',
	litellmChatModel: '',
	litellmEmbedModel: '',
	shiftEnterToSend: false,
	basePrompt: 'You are a helpful thinking partner.',
	editMode: 'on_request',
	createMode: 'on_request',
	appendMode: 'on_request',
	voyageApiKey: '',
	voyageModel: 'voyage-3-lite',
	semanticResultCount: 7,
};

interface CreateProposal {
	path: string;
	title: string;
	content: string;
}

interface Modification {
	path: string;
	operation: 'append' | 'edit';
	content: string;
	heading?: string;
}

// ── Message / API types ───────────────────────────────────────────────────────

interface Message {
	role: 'user' | 'assistant';
	content: string;
	timestamp?: number;
}

// Anthropic
type AnthropicContentBlock =
	| { type: 'text'; text: string }
	| { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
	| { type: 'tool_result'; tool_use_id: string; content: string };

type AnthropicMessage = { role: 'user' | 'assistant'; content: string | AnthropicContentBlock[] };

interface AnthropicResponse {
	content: AnthropicContentBlock[];
	stop_reason: string;
}

// ── Streaming fetch via Node https ───────────────────────────────────────────

interface StreamChunk {
	type: string;
	index?: number;
	delta?: { type: string; text?: string; partial_json?: string; stop_reason?: string };
	content_block?: { type: string; id?: string; name?: string };
}

function anthropicStream(
	apiKey: string,
	body: string,
	onEvent: (ev: StreamChunk) => void,
	signal?: AbortSignal,
): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) { resolve(); return; }
		const req = https.request({
			hostname: 'api.anthropic.com',
			port: 443,
			path: '/v1/messages',
			method: 'POST',
			headers: {
				'x-api-key': apiKey,
				'anthropic-version': '2023-06-01',
				'content-type': 'application/json',
			},
		}, (res) => {
			if (res.statusCode !== 200) {
				let raw = '';
				res.on('data', (c: Buffer) => { raw += c.toString(); });
				res.on('end', () => {
					try {
						const err = JSON.parse(raw) as { error?: { message?: string } };
						reject(new Error(err.error?.message ?? `HTTP ${res.statusCode}`));
					} catch {
						reject(new Error(`HTTP ${res.statusCode}`));
					}
				});
				return;
			}

			let buf = '';
			res.on('data', (chunk: Buffer) => {
				buf += chunk.toString();
				const lines = buf.split('\n');
				buf = lines.pop() ?? '';
				for (const line of lines) {
					if (!line.startsWith('data: ')) continue;
					const raw = line.slice(6).trim();
					if (!raw || raw === '[DONE]') continue;
					try { onEvent(JSON.parse(raw) as StreamChunk); } catch {}
				}
			});
			res.on('end', resolve);
			res.on('error', (err) => { if (signal?.aborted) resolve(); else reject(err); });
		});
		signal?.addEventListener('abort', () => { req.destroy(); resolve(); });
		req.on('error', (err) => { if (signal?.aborted) resolve(); else reject(err); });
		req.write(body);
		req.end();
	});
}

// ── Streaming fetch via Node http/https (OpenAI-compatible) ──────────────────

type OAIRole = 'system' | 'user' | 'assistant' | 'tool';

type OAIMessage =
	| { role: 'system'; content: string }
	| { role: 'user'; content: string }
	| { role: 'assistant'; content: string | null; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> }
	| { role: 'tool'; tool_call_id: string; content: string };

interface OAIStreamChunk {
	choices: Array<{
		delta: {
			content?: string | null;
			tool_calls?: Array<{
				index: number;
				id?: string;
				type?: string;
				function?: { name?: string; arguments?: string };
			}>;
		};
		finish_reason?: string | null;
	}>;
}

function openaiStream(
	baseUrl: string,
	apiKey: string,
	body: string,
	onEvent: (ev: OAIStreamChunk) => void,
	signal?: AbortSignal,
): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) { resolve(); return; }
		const url = new URL('/chat/completions', baseUrl.replace(/\/$/, ''));
		const isHttps = url.protocol === 'https:';
		const transport = isHttps ? https : http;
		const port = url.port ? parseInt(url.port) : (isHttps ? 443 : 80);

		const headers: Record<string, string> = { 'content-type': 'application/json' };
		if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

		const req = transport.request({
			hostname: url.hostname,
			port,
			path: url.pathname + url.search,
			method: 'POST',
			headers,
		}, (res) => {
			if (res.statusCode !== 200) {
				let raw = '';
				res.on('data', (c: Buffer) => { raw += c.toString(); });
				res.on('end', () => {
					try {
						const err = JSON.parse(raw) as { error?: { message?: string } };
						reject(new Error(err.error?.message ?? `HTTP ${res.statusCode}`));
					} catch {
						reject(new Error(`HTTP ${res.statusCode}`));
					}
				});
				return;
			}

			let buf = '';
			res.on('data', (chunk: Buffer) => {
				buf += chunk.toString();
				const lines = buf.split('\n');
				buf = lines.pop() ?? '';
				for (const line of lines) {
					if (!line.startsWith('data: ')) continue;
					const raw = line.slice(6).trim();
					if (!raw || raw === '[DONE]') continue;
					try { onEvent(JSON.parse(raw) as OAIStreamChunk); } catch {}
				}
			});
			res.on('end', resolve);
			res.on('error', (err) => { if (signal?.aborted) resolve(); else reject(err); });
		});
		signal?.addEventListener('abort', () => { req.destroy(); resolve(); });
		req.on('error', (err) => { if (signal?.aborted) resolve(); else reject(err); });
		req.write(body);
		req.end();
	});
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toOAITool(t: { name: string; description: string; input_schema: any }) {
	return { type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } };
}

// ── CM6: added-lines widget ───────────────────────────────────────────────────

class AddedLinesWidget extends WidgetType {
	constructor(private readonly lines: string[]) { super(); }

	toDOM(): HTMLElement {
		const wrap = document.createElement('div');
		for (const line of this.lines) {
			const el = document.createElement('div');
			el.className = 'kb-diff-added';
			el.textContent = line === '' ? '\u00a0' : line;
			wrap.appendChild(el);
		}
		return wrap;
	}

	eq(other: AddedLinesWidget): boolean {
		return (
			other.lines.length === this.lines.length &&
			other.lines.every((l, i) => l === this.lines[i])
		);
	}
}

// ── CM6: state field ──────────────────────────────────────────────────────────

const setProposalEffect = StateEffect.define<DecorationSet | null>();

const proposalField = StateField.define<DecorationSet>({
	create: () => Decoration.none,
	update(decos, tr) {
		for (const effect of tr.effects) {
			if (effect.is(setProposalEffect)) return effect.value ?? Decoration.none;
		}
		return decos.map(tr.changes);
	},
	provide: f => EditorView.decorations.from(f),
});

// ── Diff ──────────────────────────────────────────────────────────────────────

type DiffOp = { op: 'keep' } | { op: 'remove' } | { op: 'add'; text: string };

function computeDiff(origLines: string[], propLines: string[]): DiffOp[] {
	const m = origLines.length, n = propLines.length;
	const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
	for (let i = 1; i <= m; i++)
		for (let j = 1; j <= n; j++)
			dp[i][j] = origLines[i - 1] === propLines[j - 1]
				? dp[i - 1][j - 1] + 1
				: Math.max(dp[i - 1][j], dp[i][j - 1]);

	const ops: DiffOp[] = [];
	let i = m, j = n;
	while (i > 0 || j > 0) {
		if (i > 0 && j > 0 && origLines[i - 1] === propLines[j - 1]) {
			ops.unshift({ op: 'keep' }); i--; j--;
		} else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
			ops.unshift({ op: 'add', text: propLines[j - 1] }); j--;
		} else {
			ops.unshift({ op: 'remove' }); i--;
		}
	}
	return ops;
}

function buildDecorations(cmDoc: EditorView['state']['doc'], ops: DiffOp[]): DecorationSet {
	type Spec =
		| { pos: number; order: number; kind: 'line' }
		| { pos: number; order: number; kind: 'widget'; lines: string[]; side: number };

	const specs: Spec[] = [];
	let origLine = 0;
	let pending: string[] = [];
	let specOrder = 0;

	function flushPending() {
		if (!pending.length) return;
		const atStart = origLine === 0;
		const pos = atStart ? (cmDoc.lines >= 1 ? cmDoc.line(1).from : 0) : cmDoc.line(origLine).to;
		specs.push({ pos, order: specOrder++, kind: 'widget', lines: [...pending], side: atStart ? -1 : 1 });
		pending = [];
	}

	for (const op of ops) {
		if (op.op === 'add') {
			pending.push(op.text);
		} else {
			flushPending();
			if (op.op === 'remove') {
				specs.push({ pos: cmDoc.line(origLine + 1).from, order: specOrder++, kind: 'line' });
			}
			origLine++;
		}
	}
	flushPending();

	specs.sort((a, b) => a.pos !== b.pos ? a.pos - b.pos : a.order - b.order);

	const builder = new RangeSetBuilder<Decoration>();
	for (const s of specs) {
		if (s.kind === 'line') {
			builder.add(s.pos, s.pos, Decoration.line({ class: 'kb-diff-removed' }));
		} else {
			builder.add(s.pos, s.pos, Decoration.widget({
				widget: new AddedLinesWidget(s.lines),
				block: true,
				side: s.side,
			}));
		}
	}
	return builder.finish();
}


// ── Tool definitions ──────────────────────────────────────────────────────────

const ANTHROPIC_SEARCH_TOOL = {
	name: 'search_notes',
	description: 'Semantically search the vault for notes related to a query. Use this when the user\'s question might be answered by their notes, before creating a new note (to check for existing ones), or to find the right note to modify.',
	input_schema: {
		type: 'object',
		properties: {
			query: { type: 'string', description: 'A natural language description of what to search for.' },
		},
		required: ['query'],
	},
};

const ANTHROPIC_CREATE_TOOL = {
	name: 'create_notes',
	description: 'Propose creating one or more new notes in the vault. Each item is shown as a separate proposal for the user to confirm individually.',
	input_schema: {
		type: 'object',
		properties: {
			notes: {
				type: 'array',
				items: {
					type: 'object',
					properties: {
						path: { type: 'string', description: 'Full vault path including .md extension (e.g. "Areas/Health/Meditation.md"). Default to the same folder as the current note unless context suggests otherwise.' },
						title: { type: 'string', description: 'Title of the note, used as the H1 heading.' },
						content: { type: 'string', description: 'Initial markdown content. Omit the H1 title — it is added automatically. Can be empty.' },
					},
					required: ['path', 'title', 'content'],
				},
			},
		},
		required: ['notes'],
	},
};

const ANTHROPIC_MODIFY_TOOL = {
	name: 'modify_notes',
	description: 'Propose appending content to or editing one or more existing notes. Each item is shown as a separate proposal for the user to confirm individually. Use "append" to add new content without touching existing content. Use "edit" only when existing content needs to change — the user will see a diff and the full note will be replaced, so use it carefully.',
	input_schema: {
		type: 'object',
		properties: {
			modifications: {
				type: 'array',
				items: {
					type: 'object',
					properties: {
						path: { type: 'string', description: 'Full vault path of the note.' },
						operation: { type: 'string', enum: ['append', 'edit'], description: '"append" adds content without affecting existing content. "edit" replaces the entire note — use only when existing content must change.' },
						content: { type: 'string', description: 'For append: markdown content to add. For edit: the complete new note content.' },
						heading: { type: 'string', description: 'For append only: optional heading name to append under. If omitted, content is appended at the end.' },
					},
					required: ['path', 'operation', 'content'],
				},
			},
		},
		required: ['modifications'],
	},
};

// ── Append helper ─────────────────────────────────────────────────────────────

const HISTORY_CHAR_LIMIT = 40_000;

function trimHistory(messages: Message[]): Message[] {
	let total = messages.reduce((sum, m) => sum + m.content.length, 0);
	let start = 0;
	// Drop oldest user+assistant pairs until under the limit
	while (total > HISTORY_CHAR_LIMIT && start + 1 < messages.length) {
		total -= messages[start].content.length + messages[start + 1].content.length;
		start += 2;
	}
	return messages.slice(start);
}

function appendToSection(noteContent: string, heading: string | undefined, newContent: string): string {
	const trimmed = noteContent.trimEnd();
	if (!heading) return trimmed + '\n\n' + newContent;

	const lines = noteContent.split('\n');
	const re = new RegExp(`^(#{1,6})\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i');
	const hi = lines.findIndex(l => re.test(l));
	if (hi === -1) return trimmed + '\n\n' + newContent;

	const level = lines[hi].match(/^(#{1,6})/)![1].length;
	let sectionEnd = lines.length;
	for (let i = hi + 1; i < lines.length; i++) {
		const m = lines[i].match(/^(#{1,6})\s/);
		if (m && m[1].length <= level) { sectionEnd = i; break; }
	}

	// Find last non-blank line within the section to insert after
	let ins = sectionEnd;
	while (ins > hi + 1 && !lines[ins - 1].trim()) ins--;

	const before = lines.slice(0, ins).join('\n');
	const after = sectionEnd < lines.length ? '\n\n' + lines.slice(sectionEnd).join('\n') : '';
	return before + '\n\n' + newContent + after;
}

// ── ChatView ──────────────────────────────────────────────────────────────────

class ChatView extends ItemView {
	private plugin: KbChatPlugin;
	private messages: Message[] = [];
	private inputEl!: HTMLTextAreaElement;
	private messagesEl!: HTMLElement;
	private sessionBarEl!: HTMLElement;
	private contextPillsEl!: HTMLElement;
	private modelIndicatorEl!: HTMLElement;
	private isBusy = false;
	private abortController: AbortController | null = null;
	private stopBtnEl!: HTMLButtonElement;
	private activeFilePath: string | null = null;
	private currentSessionPath: string | null = null;
	private currentNotePath: string | null = null;
	private standaloneMode = false;
	private sessionTitle: string | null = null;
	private contextFiles: TFile[] = [];

	constructor(leaf: WorkspaceLeaf, plugin: KbChatPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType() { return VIEW_TYPE; }
	getDisplayText() { return 'KB Chat'; }
	getIcon() { return 'message-circle'; }

	get activeSessionPath() { return this.currentSessionPath; }

	async onOpen() {
		this.buildUI();
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', () => {
				const file = this.app.workspace.getActiveFile();
				const path = file?.path ?? null;
				if (path === this.activeFilePath) return;
				this.activeFilePath = path;
				if (this.standaloneMode) return;
				this.switchToNote(file);
			})
		);
		const initialFile = this.app.workspace.getActiveFile();
		this.activeFilePath = initialFile?.path ?? null;
		await this.switchToNote(initialFile);
	}

	private buildUI() {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass('kb-chat-container');

		this.sessionBarEl = container.createDiv('kb-session-bar');
		this.sessionBarEl.addEventListener('click', (e) => this.openSessionMenu(e));

		this.messagesEl = container.createDiv('kb-chat-messages');

		const inputArea = container.createDiv('kb-chat-input-area');

		this.contextPillsEl = inputArea.createDiv('kb-context-pills');
		this.setupDragDrop(container);

		const hint = this.plugin.settings.shiftEnterToSend ? 'Shift+Enter to send' : 'Enter to send';
		this.inputEl = inputArea.createEl('textarea', {
			attr: { placeholder: `Ask… (${hint})` },
		});
		this.inputEl.addEventListener('keydown', (e) => {
			const sendKey = this.plugin.settings.shiftEnterToSend ? (e.key === 'Enter' && e.shiftKey) : (e.key === 'Enter' && !e.shiftKey);
			if (sendKey) { e.preventDefault(); this.sendMessage(); }
		});

		const inputFooter = inputArea.createDiv('kb-input-footer');
		this.modelIndicatorEl = inputFooter.createDiv('kb-model-indicator');
		this.updateModelIndicator();
		this.modelIndicatorEl.addEventListener('click', (e) => this.openModelMenu(e));

		this.stopBtnEl = inputFooter.createEl('button', { cls: 'kb-stop-btn' });
		setIcon(this.stopBtnEl.createSpan('kb-stop-icon'), 'square');
		this.stopBtnEl.createSpan({ text: 'Stop' });
		this.stopBtnEl.style.display = 'none';
		this.stopBtnEl.addEventListener('click', () => this.abortController?.abort());
	}

	// ── Session management ────────────────────────────────────────────────────

	private async switchToNote(file: TFile | null) {
		this.standaloneMode = false;
		this.currentNotePath = file?.path ?? null;
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
			if (f instanceof TFile) this.addContextFile(f);
		}
		await this.updateSessionBar();
	}

	async openExternalSession(sessionPath: string, notePath: string | null) {
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
			if (f instanceof TFile) this.addContextFile(f);
		}
		await this.updateSessionBar();
	}

	private async listSessions(notePath: string | null): Promise<string[]> {
		const dir = notePath ? `.chats/${notePath.replace(/\.md$/, '')}` : '.chats/_global';
		if (!(await this.app.vault.adapter.exists(dir))) return [];
		try {
			const listing = await this.app.vault.adapter.list(dir);
			return listing.files.filter(f => f.endsWith('.md')).sort();
		} catch { return []; }
	}

	private async loadSession(path: string) {
		this.messages = [];
		this.messagesEl.empty();
		this.currentSessionPath = path;
		this.sessionTitle = null;
		if (!(await this.app.vault.adapter.exists(path))) return;
		const raw = await this.app.vault.adapter.read(path);
		const titleMatch = raw.match(/^<!-- TITLE: (.+?) -->/);
		if (titleMatch) this.sessionTitle = titleMatch[1];
		const re = /<!-- MSG:(user|assistant):(\d+) -->\n([\s\S]*?)<!-- \/MSG -->/g;
		let match;
		while ((match = re.exec(raw)) !== null)
			this.messages.push({ role: match[1] as 'user' | 'assistant', content: match[3].trimEnd(), timestamp: parseInt(match[2]) });
		for (const msg of this.messages)
			this.renderMessage(msg.role, msg.content, msg.timestamp);
		this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
	}

	private async saveSession() {
		if (!this.messages.length) return;
		if (!this.currentSessionPath) {
			const dir = this.currentNotePath ? `.chats/${this.currentNotePath.replace(/\.md$/, '')}` : '.chats/_global';
			const ts = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
			this.currentSessionPath = `${dir}/${ts}.md`;
			await this.ensureFolder(dir);
		}
		const msgs = this.messages.map(m =>
			`<!-- MSG:${m.role}:${m.timestamp ?? Date.now()} -->\n${m.content}\n<!-- /MSG -->`
		).join('\n\n');
		const content = this.sessionTitle ? `<!-- TITLE: ${this.sessionTitle} -->\n${msgs}` : msgs;
		await this.app.vault.adapter.write(this.currentSessionPath, content);
		await this.updateSessionBar();

		if (this.messages.length === 2 && !this.sessionTitle) {
			this.generateSessionTitle();
		}
	}

	private async updateSessionBar() {
		this.sessionBarEl.empty();
		const sessions = await this.listSessions(this.currentNotePath);
		const idx = this.currentSessionPath ? sessions.indexOf(this.currentSessionPath) : -1;

		let label: string;
		if (this.standaloneMode) {
			const titlePart = this.sessionTitle ? ` · ${this.sessionTitle}` : '';
			label = idx >= 0 ? `Standalone${titlePart} · ${this.sessionDateLabel(sessions[idx])}` : 'New standalone chat';
		} else if (!this.currentNotePath) {
			label = 'No note open';
		} else {
			const name = this.currentNotePath.split('/').pop()?.replace(/\.md$/, '') ?? '';
			if (idx >= 0) {
				const chatLabel = this.sessionTitle ?? `Chat ${idx + 1}${sessions.length > 1 ? ` of ${sessions.length}` : ''}`;
				label = `${name} · ${chatLabel} · ${this.sessionDateLabel(sessions[idx])}`;
			} else {
				label = `${name} · New chat`;
			}
		}

		this.sessionBarEl.createSpan({ text: label + ' ▾', cls: 'kb-session-label' });
	}

	private sessionDateLabel(path: string): string {
		const ts = path.split('/').pop()!.replace('.md', '').replace(/T(\d{2})-(\d{2})-\d{2}$/, 'T$1:$2:00');
		const d = new Date(ts);
		return isNaN(d.getTime()) ? '' : this.formatStamp(d.getTime());
	}

	private async openSessionMenu(e: MouseEvent) {
		const sessions = await this.listSessions(this.currentNotePath);
		const titles = await Promise.all(sessions.map(p => this.readSessionTitle(p)));
		const menu = new Menu();

		if (this.standaloneMode) {
			const activeFile = this.app.workspace.getActiveFile();
			menu.addItem(item => {
				item.setTitle(activeFile ? `Follow active note: ${activeFile.basename}` : 'Follow active note');
				if (activeFile) item.onClick(() => this.switchToNote(activeFile));
			});
			menu.addSeparator();
		}

		sessions.forEach((path, i) => {
			const label = titles[i] ? `${titles[i]} · ${this.sessionDateLabel(path)}` : `Chat ${i + 1} · ${this.sessionDateLabel(path)}`;
			menu.addItem(item => item
				.setTitle(label)
				.setChecked(path === this.currentSessionPath)
				.onClick(async () => {
					await this.loadSession(path);
					this.contextFiles = [];
					this.contextPillsEl.empty();
					if (this.currentNotePath) {
						const f = this.app.vault.getAbstractFileByPath(this.currentNotePath);
						if (f instanceof TFile) this.addContextFile(f);
					}
					await this.updateSessionBar();
				})
			);
		});

		if (sessions.length) menu.addSeparator();

		if (this.currentNotePath) {
			menu.addItem(item => item.setTitle('New chat for this note').onClick(() => this.startNewSession(false)));
		}
		menu.addItem(item => item.setTitle('New standalone chat').onClick(() => this.startNewSession(true)));

		if (!this.standaloneMode) {
			const standaloneSessions = await this.listSessions(null);
			if (standaloneSessions.length > 0) {
				const recent = standaloneSessions.slice(-5).reverse();
				const recentTitles = await Promise.all(recent.map(p => this.readSessionTitle(p)));
				menu.addSeparator();
				recent.forEach((path, i) => {
					const label = recentTitles[i] ?? this.sessionDateLabel(path);
					menu.addItem(item => item
						.setTitle(`Standalone · ${label}`)
						.onClick(() => this.openExternalSession(path, null))
					);
				});
			}
		}

		menu.showAtMouseEvent(e);
	}

	private async readSessionTitle(path: string): Promise<string | null> {
		try {
			const raw = await this.app.vault.adapter.read(path);
			const m = raw.match(/^<!-- TITLE: (.+?) -->/);
			return m ? m[1] : null;
		} catch { return null; }
	}

	private async generateSessionTitle() {
		if (this.messages.length < 2) return;
		const userMsg = this.messages[0].content.slice(0, 500);
		const assistantMsg = this.messages[1].content.slice(0, 500);
		const prompt = `Summarize this conversation in 4-7 words as a chat title. Reply with only the title, no quotes or trailing punctuation.\n\nUser: ${userMsg}\n\nAssistant: ${assistantMsg}`;

		const { provider, anthropicApiKey, anthropicModel, litellmBaseUrl, litellmApiKey, litellmChatModel } = this.plugin.settings;
		try {
			let title = '';
			if (provider === 'litellm') {
				const resp = await requestUrl({
					url: `${litellmBaseUrl.replace(/\/$/, '')}/chat/completions`,
					method: 'POST',
					headers: {
						...(litellmApiKey ? { 'Authorization': `Bearer ${litellmApiKey}` } : {}),
						'content-type': 'application/json',
					},
					body: JSON.stringify({ model: litellmChatModel, max_tokens: 30, messages: [{ role: 'user', content: prompt }] }),
					throw: false,
				});
				if (resp.status !== 200) return;
				const data = resp.json as { choices: Array<{ message: { content: string } }> };
				title = data.choices[0]?.message?.content?.trim() ?? '';
			} else {
				const resp = await requestUrl({
					url: 'https://api.anthropic.com/v1/messages',
					method: 'POST',
					headers: { 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
					body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 30, messages: [{ role: 'user', content: prompt }] }),
					throw: false,
				});
				if (resp.status !== 200) return;
				const data = resp.json as AnthropicResponse;
				title = (data.content.find(b => b.type === 'text') as { type: 'text'; text: string } | undefined)?.text?.trim() ?? '';
			}
			if (!title) return;
			this.sessionTitle = title;
			await this.saveSession();
		} catch { /* silently ignore */ }
	}

	// ── Context pills ─────────────────────────────────────────────────────────

	addContextFile(file: TFile) {
		if (file.extension !== 'md') return;
		if (this.contextFiles.some(f => f.path === file.path)) return;
		this.contextFiles.push(file);
		this.renderContextPill(file);
	}

	private renderContextPill(file: TFile) {
		const pill = this.contextPillsEl.createDiv('kb-context-pill');
		const iconEl = pill.createSpan('kb-pill-icon');
		setIcon(iconEl, 'file-text');
		pill.createSpan({ text: file.basename, cls: 'kb-pill-name' });
		const x = pill.createEl('button', { cls: 'kb-pill-remove' });
		setIcon(x, 'x');
		x.addEventListener('click', (ev) => {
			ev.stopPropagation();
			this.contextFiles = this.contextFiles.filter(f => f.path !== file.path);
			pill.remove();
		});
	}

	private setupDragDrop(container: HTMLElement) {
		let depth = 0;

		container.addEventListener('dragenter', (e) => {
			e.preventDefault();
			if (++depth === 1) container.addClass('kb-drag-over');
		});
		container.addEventListener('dragleave', () => {
			if (--depth === 0) container.removeClass('kb-drag-over');
		});
		container.addEventListener('dragover', (e) => {
			e.preventDefault();
			e.dataTransfer!.dropEffect = 'copy';
		});
		container.addEventListener('drop', (e) => {
			e.preventDefault();
			depth = 0;
			container.removeClass('kb-drag-over');

			// Obsidian stores dragged file in its drag manager
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const dm = (this.app as any).dragManager;
			const draggable = dm?.draggable;
			if (draggable?.type === 'file' && draggable.file instanceof TFile) {
				this.addContextFile(draggable.file);
				return;
			}
			if (draggable?.files) {
				for (const f of draggable.files)
					if (f instanceof TFile && f.extension === 'md') this.addContextFile(f);
				return;
			}

			// Fallback for external drags
			const text = e.dataTransfer?.getData('text/plain') ?? '';
			const byPath = this.app.vault.getAbstractFileByPath(text);
			const file = byPath instanceof TFile ? byPath
				: this.app.metadataCache.getFirstLinkpathDest(text, '') ?? null;
			if (file instanceof TFile) this.addContextFile(file);
		});
	}

	// ── System prompt ─────────────────────────────────────────────────────────

	private async resolveSemanticContext(userMessage: string): Promise<ChunkHit[]> {
		if (!this.plugin.canSearch()) return [];
		const { semanticResultCount } = this.plugin.settings;
		const ec = this.plugin.embeddingConfig();
		try {
			const recentUserMessages = this.messages
				.filter(m => m.role === 'user')
				.slice(-5)
				.map(m => m.content);
			const queryText = [
				...this.contextFiles.map(f => f.basename),
				...recentUserMessages,
				userMessage,
			].join('\n');
			const contextPaths = new Set(this.contextFiles.map(f => f.path));
			const hits = await this.plugin.embeddingStore.search(queryText, ec.apiKey, ec.model, semanticResultCount, ec.baseUrl);
			return hits.filter(h => !contextPaths.has(h.path));
		} catch {
			return [];
		}
	}

	private async buildSystemPrompt(userMessage: string, semanticHits: ChunkHit[]): Promise<string> {
		const base = this.plugin.settings.basePrompt.trim() || DEFAULT_SETTINGS.basePrompt;

		const contextBlocks = await Promise.all(this.contextFiles.map(async f => {
			const content = await this.app.vault.read(f);
			return `## ${f.basename} (path: ${f.path})\n\n${content}`;
		}));

		const multi = this.contextFiles.length > 1;
		let prompt = contextBlocks.length
			? `${base} The user has the following note${multi ? 's' : ''} as context:\n\n${contextBlocks.join('\n\n---\n\n')}\n\nHelp them think through ideas.`
			: base;

		if (semanticHits.length > 0) {
			// Group chunks by note, preserving top-score order of first appearance
			const byNote = new Map<string, ChunkHit[]>();
			for (const hit of semanticHits) {
				const arr = byNote.get(hit.path);
				if (arr) arr.push(hit);
				else byNote.set(hit.path, [hit]);
			}

			const relatedBlocks = (await Promise.all([...byNote.entries()].map(async ([path, hits]) => {
				const file = this.app.vault.getAbstractFileByPath(path);
				if (!(file instanceof TFile)) return null;
				const sections = hits
					.map(h => h.heading ? `### ${h.heading}\n\n${h.text}` : h.text)
					.join('\n\n');
				return `## ${file.basename} (path: ${path})\n\n${sections}`;
			}))).filter(Boolean) as string[];

			if (relatedBlocks.length > 0)
				prompt += `\n\n---\n\nRelevant notes from the vault (pre-fetched — use these directly to answer questions or identify notes to modify; only call search_notes if you need something not already shown here):\n\n${relatedBlocks.join('\n\n---\n\n')}`;
		}

		const canSearch = this.plugin.canSearch();
		const createMode = this.plugin.settings.createMode;
		const editMode = this.plugin.settings.editMode;
		const appendMode = this.plugin.settings.appendMode;
		const canCreate = createMode !== 'never';
		const canAppend = appendMode !== 'never';
		const canEdit = editMode !== 'never';

		if (canCreate || canAppend || canEdit) {
			const currentFolder = this.contextFiles[0]?.parent?.path;
			const folderHint = currentFolder ? ` Default new notes to the "${currentFolder}" folder unless context suggests a better location.` : '';

			const rules: string[] = [];

			if (canAppend) {
				rules.push(appendMode === 'proactive'
					? 'Use modify_notes (operation "append") when the conversation produces content clearly worth adding to an existing note — a decision, a key insight, or an action item. Prefer append over edit whenever possible.'
					: 'Use modify_notes (operation "append") only when the user explicitly asks to add content to a note. Prefer append over edit whenever possible.');
			}

			if (canEdit) {
				rules.push(editMode === 'proactive'
					? 'Use modify_notes (operation "edit") when existing note content needs meaningful revision based on what was discussed. Use sparingly — it replaces the entire note.'
					: 'Use modify_notes (operation "edit") only when the user explicitly asks to edit or rewrite a note. It replaces the entire note, so use it carefully.');
			}

			if (canCreate) {
				rules.push(createMode === 'proactive'
					? 'Use create_notes when the conversation produces something worth capturing as a new standalone note and no suitable note exists yet.'
					: 'Use create_notes only when the user explicitly asks to create a new note and no suitable note exists yet.');
			}

			if (canSearch) {
				rules.push('If the pre-fetched notes above don\'t fully answer the user\'s question, use search_notes to broaden the search.');
				if (canAppend || canEdit)
					rules.push('Before calling modify_notes, use the path shown in the note heading above if the note is already in context. Otherwise call search_notes first to get the exact vault path — it must not be guessed.');
				if (canCreate)
					rules.push('Before calling create_notes, call search_notes to confirm no suitable note already exists.');
				rules.push('Call the appropriate tool immediately after search_notes — no text in between.');
			}
			rules.push(`Never write text announcing what you are about to do with a tool — do not say "I'll create", "Creating now", or anything similar. Call the tool directly, then write any explanatory text after.${folderHint}`);

			prompt += '\n\nNote-writing rules:\n' + rules.map(r => `- ${r}`).join('\n');
		} else if (canSearch) {
			if (semanticHits.length > 0) {
				prompt += ' Relevant notes are already provided above — answer from them directly. Use search_notes only if you need something not covered there.';
			} else {
				prompt += ' Use the search_notes tool when the user\'s question might be answered by their notes.';
			}
		}

		return prompt;
	}

	private renderSemanticPreview(hits: ChunkHit[], msgEl: HTMLElement) {
		// Group hits by note path, preserving first-appearance order
		const byPath = new Map<string, ChunkHit[]>();
		for (const hit of hits) {
			const arr = byPath.get(hit.path);
			if (arr) arr.push(hit);
			else byPath.set(hit.path, [hit]);
		}

		const entries: Array<{ file: TFile; chunks: ChunkHit[] }> = [];
		for (const [path, chunks] of byPath) {
			const file = this.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) entries.push({ file, chunks });
		}
		if (!entries.length) return;

		let open = false;

		const indicator = msgEl.createDiv('kb-semantic-indicator');
		indicator.setText(`${entries.length} related`);

		const list = msgEl.createDiv('kb-semantic-list');
		list.style.display = 'none';

		indicator.addEventListener('click', () => {
			open = !open;
			list.style.display = open ? '' : 'none';
			indicator.toggleClass('is-open', open);
		});

		for (const { file, chunks } of entries) {
			const row = list.createDiv('kb-semantic-item');

			const nameEl = row.createSpan({ text: file.basename, cls: 'kb-semantic-name' });
			nameEl.addEventListener('click', () =>
				this.app.workspace.openLinkText(file.path, '', false)
			);

			// Build tooltip: one line per chunk — heading or first 60 chars of text
			const tooltipLines = chunks.map(c => {
				if (c.heading) return `› ${c.heading}`;
				const preview = c.text.replace(/\s+/g, ' ').trim().slice(0, 60);
				return `› ${preview}${c.text.length > 60 ? '…' : ''}`;
			});
			nameEl.setAttribute('title', tooltipLines.join('\n'));

			const addBtn = row.createEl('button', { cls: 'kb-semantic-add', attr: { title: 'Add to context' } });
			setIcon(addBtn, 'plus');
			addBtn.addEventListener('click', () => {
				this.addContextFile(file);
				addBtn.disabled = true;
				addBtn.empty();
				setIcon(addBtn, 'check');
			});
		}
	}

	private updateModelIndicator() {
		const { provider, anthropicModel, litellmChatModel } = this.plugin.settings;
		if (provider === 'litellm') {
			this.modelIndicatorEl.setText(`${litellmChatModel || 'LiteLLM'} ▾`);
		} else {
			const label = ANTHROPIC_MODELS[anthropicModel] ?? anthropicModel;
			this.modelIndicatorEl.setText(`Claude ${label} ▾`);
		}
	}

	private openModelMenu(e: MouseEvent) {
		const currentModel = this.plugin.settings.anthropicModel;
		const menu = new Menu();
		for (const [id, label] of Object.entries(ANTHROPIC_MODELS)) {
			menu.addItem(item => item
				.setTitle('Claude ' + label)
				.setChecked(id === currentModel)
				.onClick(async () => {
					this.plugin.settings.anthropicModel = id;
					await this.plugin.saveSettings();
					this.updateModelIndicator();
				})
			);
		}
		menu.showAtMouseEvent(e);
	}

	private async sendMessage() {
		if (this.isBusy) return;
		const text = this.inputEl.value.trim();
		if (!text) return;

		const { provider, anthropicApiKey, litellmBaseUrl } = this.plugin.settings;
		if (provider === 'anthropic' && !anthropicApiKey) {
			new Notice('Add your Anthropic API key in Settings → KB Chat');
			return;
		}
		if (provider === 'litellm' && !litellmBaseUrl) {
			new Notice('Add your LiteLLM base URL in Settings → KB Chat');
			return;
		}

		const editableFile = this.contextFiles.length === 1 && this.contextFiles[0].extension === 'md'
			? this.contextFiles[0] : null;
		let originalContent = '';
		if (editableFile) originalContent = await this.app.vault.read(editableFile);

		const semanticHits = await this.resolveSemanticContext(text);
		const system = await this.buildSystemPrompt(text, semanticHits);

		this.inputEl.value = '';
		// Clear minHeight from all previous AI messages so scrolling back through history is clean
		this.messagesEl.querySelectorAll<HTMLElement>('.kb-message-assistant').forEach(el => el.style.minHeight = '');

		this.messages.push({ role: 'user', content: text, timestamp: Date.now() });
		const userMsgEl = this.renderMessage('user', text);
		if (semanticHits.length > 0) this.renderSemanticPreview(semanticHits, userMsgEl);
		const { el: msgEl, textEl, stampEl } = this.renderPendingMessage();

		// Expand the pending message so the user message sits at the top of the viewport
		const spacer = this.messagesEl.clientHeight - userMsgEl.offsetHeight - 36;
		if (spacer > 0) msgEl.style.minHeight = `${spacer}px`;
		this.messagesEl.scrollTo({ top: userMsgEl.offsetTop - 12, behavior: 'smooth' });

		this.isBusy = true;
		this.inputEl.disabled = true;
		this.abortController = new AbortController();
		this.stopBtnEl.style.display = '';

		try {
			const caller = this.plugin.settings.provider === 'litellm'
				? this.callLiteLLM.bind(this)
				: this.callAnthropic.bind(this);
			const { text: reply, proposedCreates, proposedModifications } = await caller(
				system, trimHistory(this.messages.slice(0, -1)), text, editableFile,
				(chunk: string) => { this.renderMarkdownTo(textEl, chunk); },
				(status: string) => { textEl.setText(status); },
				this.abortController.signal,
			);

			const timestamp = Date.now();
			stampEl.setText(this.formatStamp(timestamp));

			const hasProposal = proposedCreates?.length || proposedModifications?.length;

			if (!hasProposal) {
				const displayText = reply || '(no response)';
				this.renderMarkdownTo(textEl, displayText);
				this.messages.push({ role: 'assistant', content: displayText, timestamp });
				await this.saveSession();
			} else {
				if (reply) this.renderMarkdownTo(textEl, reply);
				else textEl.empty();
				this.messages.push({ role: 'assistant', content: reply, timestamp });
				await this.saveSession();

				if (proposedCreates?.length) {
					for (const pc of proposedCreates) {
						this.renderProposalCard(msgEl, {
							icon: 'file-plus',
							actionLabel: 'Create note',
							target: pc.path,
							reason: '',
							content: pc.content,
							applyLabel: '✓ Create',
							onApply: async () => {
								const folder = pc.path.split('/').slice(0, -1).join('/');
								if (folder) await this.ensureFolder(folder);
								const full = `# ${pc.title}\n\n${pc.content}`.trimEnd();
								return await this.app.vault.create(pc.path, full);
							},
							onDismiss: () => {},
						});
					}
				}

				if (proposedModifications?.length) {
					for (const mod of proposedModifications) {
						if (mod.operation === 'edit') {
							if (editableFile && mod.path === editableFile.path) {
								this.plugin.showProposal(editableFile, originalContent, mod.content);
								this.renderProposalCard(msgEl, {
									icon: 'pencil',
									actionLabel: 'Edit note',
									target: editableFile.basename,
									reason: reply,
									isEdit: true,
									applyLabel: '✓ Apply changes',
									onApply: async () => {
										await this.plugin.applyProposal();
										return null;
									},
									onDismiss: () => { this.plugin.clearProposal(); },
								});
							} else {
								this.renderProposalCard(msgEl, {
									icon: 'pencil',
									actionLabel: 'Edit note',
									target: mod.path,
									reason: '',
									content: mod.content,
									isEdit: true,
									applyLabel: '✓ Apply changes',
									onApply: async () => {
										const file = this.app.vault.getAbstractFileByPath(mod.path);
										if (!(file instanceof TFile)) throw new Error(`Note not found: ${mod.path}`);
										await this.app.vault.modify(file, mod.content);
										return file;
									},
									onDismiss: () => {},
								});
							}
						} else {
							const target = mod.heading ? `${mod.path}  ›  ${mod.heading}` : mod.path;
							this.renderProposalCard(msgEl, {
								icon: 'list-plus',
								actionLabel: 'Append to note',
								target,
								reason: '',
								content: mod.content,
								applyLabel: '✓ Append',
								onApply: async () => {
									const file = this.app.vault.getAbstractFileByPath(mod.path);
									if (!(file instanceof TFile)) throw new Error(`Note not found: ${mod.path}`);
									const original = await this.app.vault.read(file);
									await this.app.vault.modify(file, appendToSection(original, mod.heading, mod.content));
									return file;
								},
								onDismiss: () => {},
							});
						}
					}
				}
			}
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			textEl.setText(`Error: ${msg}`);
		} finally {
			this.isBusy = false;
			this.abortController = null;
			this.stopBtnEl.style.display = 'none';
			this.inputEl.disabled = false;
			this.inputEl.focus();
		}
	}

	private async callAnthropic(
		system: string, history: Message[], userMessage: string, file: TFile | null,
		onChunk: (text: string) => void,
		onStatus: (text: string) => void,
		signal?: AbortSignal,
	): Promise<{ text: string; proposedCreates: CreateProposal[] | null; proposedModifications: Modification[] | null }> {
		const apiMessages: AnthropicMessage[] = [
			...history.map(m => ({ role: m.role, content: m.content })),
			{ role: 'user', content: userMessage },
		];
		const { semanticResultCount } = this.plugin.settings;
		const ec = this.plugin.embeddingConfig();
		const canSearch = this.plugin.canSearch();
		const canModify = this.plugin.settings.editMode !== 'never' || this.plugin.settings.appendMode !== 'never';
		const tools = [
			...(canSearch ? [ANTHROPIC_SEARCH_TOOL] : []),
			...(this.plugin.settings.createMode !== 'never' ? [ANTHROPIC_CREATE_TOOL] : []),
			...(canModify ? [ANTHROPIC_MODIFY_TOOL] : []),
		];
		let finalText = '';
		let proposedCreates: CreateProposal[] | null = null;
		let proposedModifications: Modification[] | null = null;

		for (let turn = 0; turn < 8; turn++) {
			type StreamBlock =
				| { type: 'text'; text: string }
				| { type: 'tool_use'; id: string; name: string; inputJson: string };

			const blockMap = new Map<number, StreamBlock>();
			let stopReason = '';
			let accText = '';

			await anthropicStream(
				this.plugin.settings.anthropicApiKey,
				JSON.stringify({
					model: this.plugin.settings.anthropicModel,
					max_tokens: 4096,
					stream: true,
					system, messages: apiMessages,
					...(tools.length ? { tools } : {}),
				}),
				(ev) => {
					switch (ev.type) {
						case 'content_block_start': {
							const cb = ev.content_block!;
							if (cb.type === 'text') blockMap.set(ev.index!, { type: 'text', text: '' });
							else if (cb.type === 'tool_use') blockMap.set(ev.index!, { type: 'tool_use', id: cb.id!, name: cb.name!, inputJson: '' });
							break;
						}
						case 'content_block_delta': {
							const b = blockMap.get(ev.index!);
							if (!b) break;
							if (ev.delta?.type === 'text_delta' && b.type === 'text') {
								const chunk = ev.delta.text ?? '';
								b.text += chunk;
								accText += chunk;
								onChunk(accText);
							} else if (ev.delta?.type === 'input_json_delta' && b.type === 'tool_use') {
								b.inputJson += ev.delta.partial_json ?? '';
							}
							break;
						}
						case 'message_delta':
							if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
							break;
					}
				},
				signal,
			);

			if (signal?.aborted) { finalText = accText; break; }

			const sortedBlocks = [...blockMap.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
			const contentBlocks: AnthropicContentBlock[] = sortedBlocks.map(b => {
				if (b.type === 'text') return { type: 'text', text: b.text };
				let input: Record<string, unknown> = {};
				try { input = JSON.parse(b.inputJson) as Record<string, unknown>; } catch {}
				return { type: 'tool_use', id: b.id, name: b.name, input };
			});
			apiMessages.push({ role: 'assistant', content: contentBlocks });

			if (stopReason !== 'tool_use') {
				finalText = accText;
				break;
			}

			// Show which tools are running before executing them
			const toolNames = contentBlocks.filter(b => b.type === 'tool_use').map(b => (b as { name: string }).name);
			const statusParts = toolNames.map(n => {
				if (n === 'search_notes') return 'Searching notes';
				if (n === 'create_notes') return 'Preparing note proposal';
				if (n === 'modify_notes') return 'Preparing edit proposal';
				return n;
			});
			onStatus(statusParts.join(' · ') + '…');

			const toolResults: AnthropicContentBlock[] = [];
			for (const block of contentBlocks) {
				if (block.type !== 'tool_use') continue;

				if (block.name === 'search_notes' && canSearch) {
					const query = (block.input as { query: string }).query;
					const hits = await this.plugin.embeddingStore.search(query, ec.apiKey, ec.model, semanticResultCount, ec.baseUrl);
					const results = hits.map(h => {
						const f = this.app.vault.getAbstractFileByPath(h.path);
						return {
							path: h.path,
							title: f instanceof TFile ? f.basename : h.path,
							heading: h.heading || undefined,
							content: h.text,
							relevance: Math.round(h.score * 100) / 100,
						};
					});
					toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(results) });
				} else if (block.name === 'create_notes') {
					const inp = block.input as { notes: Array<{ path: string; title: string; content: string }> };
					proposedCreates = inp.notes.map(n => ({ path: n.path, title: n.title, content: n.content ?? '' }));
					toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: 'Proposals shown to user.' });
				} else if (block.name === 'modify_notes') {
					const inp = block.input as { modifications: Array<{ path: string; operation: 'append' | 'edit'; content: string; heading?: string }> };
					proposedModifications = inp.modifications.map(m => ({ path: m.path, operation: m.operation, content: m.content, heading: m.heading }));
					toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: 'Proposals shown to user.' });
				} else {
					toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Unknown tool: ${block.name}` });
				}
			}
			if (toolResults.length) apiMessages.push({ role: 'user', content: toolResults });
		}

		return { text: finalText, proposedCreates, proposedModifications };
	}

	private async callLiteLLM(
		system: string, history: Message[], userMessage: string, _file: TFile | null,
		onChunk: (text: string) => void,
		onStatus: (text: string) => void,
		signal?: AbortSignal,
	): Promise<{ text: string; proposedCreates: CreateProposal[] | null; proposedModifications: Modification[] | null }> {
		const { litellmBaseUrl, litellmApiKey, semanticResultCount } = this.plugin.settings;
		const ec = this.plugin.embeddingConfig();
		const canSearch = this.plugin.canSearch();
		const canModify = this.plugin.settings.editMode !== 'never' || this.plugin.settings.appendMode !== 'never';
		const rawTools = [
			...(canSearch ? [ANTHROPIC_SEARCH_TOOL] : []),
			...(this.plugin.settings.createMode !== 'never' ? [ANTHROPIC_CREATE_TOOL] : []),
			...(canModify ? [ANTHROPIC_MODIFY_TOOL] : []),
		];
		const tools = rawTools.map(toOAITool);

		const oaiMessages: OAIMessage[] = [
			{ role: 'system', content: system },
			...history.map(m => ({ role: m.role as OAIRole, content: m.content } as OAIMessage)),
			{ role: 'user', content: userMessage },
		];

		let finalText = '';
		let proposedCreates: CreateProposal[] | null = null;
		let proposedModifications: Modification[] | null = null;

		for (let turn = 0; turn < 8; turn++) {
			// Accumulate streamed tool call fragments indexed by their position
			const toolCallMap = new Map<number, { id: string; name: string; arguments: string }>();
			let accText = '';
			let finishReason = '';

			await openaiStream(
				litellmBaseUrl,
				litellmApiKey,
				JSON.stringify({
					model: this.plugin.settings.litellmChatModel,
					max_tokens: 4096,
					stream: true,
					messages: oaiMessages,
					...(tools.length ? { tools } : {}),
				}),
				(ev) => {
					const choice = ev.choices?.[0];
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
								existing.arguments += tc.function?.arguments ?? '';
							} else {
								toolCallMap.set(tc.index, {
									id: tc.id ?? '',
									name: tc.function?.name ?? '',
									arguments: tc.function?.arguments ?? '',
								});
							}
						}
					}
				},
				signal,
			);

			if (signal?.aborted) { finalText = accText; break; }

			const toolCalls = [...toolCallMap.entries()]
				.sort((a, b) => a[0] - b[0])
				.map(([, tc]) => tc);

			if (finishReason !== 'tool_calls' || toolCalls.length === 0) {
				finalText = accText;
				break;
			}

			// Show which tools are running before executing them
			const statusParts = toolCalls.map(tc => {
				if (tc.name === 'search_notes') return 'Searching notes';
				if (tc.name === 'create_notes') return 'Preparing note proposal';
				if (tc.name === 'modify_notes') return 'Preparing edit proposal';
				return tc.name;
			});
			onStatus(statusParts.join(' · ') + '…');

			// Push assistant message with tool calls into history
			oaiMessages.push({
				role: 'assistant',
				content: accText || null,
				tool_calls: toolCalls.map(tc => ({
					id: tc.id,
					type: 'function' as const,
					function: { name: tc.name, arguments: tc.arguments },
				})),
			});

			// Execute tools and push results
			for (const tc of toolCalls) {
				let result = '';
				let parsed: Record<string, unknown> = {};
				try { parsed = JSON.parse(tc.arguments) as Record<string, unknown>; } catch {}

				if (tc.name === 'search_notes' && canSearch) {
					const query = parsed.query as string;
					const hits = await this.plugin.embeddingStore.search(query, ec.apiKey, ec.model, semanticResultCount, ec.baseUrl);
					const results = hits.map(h => {
						const f = this.app.vault.getAbstractFileByPath(h.path);
						return { path: h.path, title: f instanceof TFile ? f.basename : h.path, heading: h.heading || undefined, content: h.text, relevance: Math.round(h.score * 100) / 100 };
					});
					result = JSON.stringify(results);
				} else if (tc.name === 'create_notes') {
					const inp = parsed as { notes: Array<{ path: string; title: string; content: string }> };
					proposedCreates = inp.notes.map(n => ({ path: n.path, title: n.title, content: n.content ?? '' }));
					result = 'Proposals shown to user.';
				} else if (tc.name === 'modify_notes') {
					const inp = parsed as { modifications: Array<{ path: string; operation: 'append' | 'edit'; content: string; heading?: string }> };
					proposedModifications = inp.modifications.map(m => ({ path: m.path, operation: m.operation, content: m.content, heading: m.heading }));
					result = 'Proposals shown to user.';
				} else {
					result = `Unknown tool: ${tc.name}`;
				}

				oaiMessages.push({ role: 'tool', tool_call_id: tc.id, content: result });
			}
		}

		return { text: finalText, proposedCreates, proposedModifications };
	}

	private renderMessage(role: 'user' | 'assistant', text: string, timestamp?: number): HTMLElement {
		const el = this.messagesEl.createDiv(`kb-message kb-message-${role}`);
		el.createEl('div', { cls: 'kb-message-role', text: role === 'user' ? 'You' : 'AI' });
		const textEl = el.createEl('div', { cls: 'kb-message-text' });
		if (role === 'assistant') this.renderMarkdownTo(textEl, text);
		else textEl.setText(text);
		if (role === 'assistant' && timestamp)
			el.createEl('div', { cls: 'kb-message-stamp', text: this.formatStamp(timestamp) });
		return el;
	}

	private async ensureFolder(path: string) {
		const parts = path.split('/');
		let current = '';
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (!(await this.app.vault.adapter.exists(current)))
				await this.app.vault.adapter.mkdir(current);
		}
	}

	private renderPendingMessage() {
		const el = this.messagesEl.createDiv('kb-message kb-message-assistant');
		el.createEl('div', { cls: 'kb-message-role', text: 'AI' });
		const textEl = el.createEl('div', { cls: 'kb-message-text', text: '…' });
		const stampEl = el.createEl('div', { cls: 'kb-message-stamp' });
		return { el, textEl, stampEl };
	}

	private formatStamp(timestamp: number): string {
		const d = new Date(timestamp);
		const now = new Date();
		const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
		if (d.getFullYear() !== now.getFullYear())
			return `${d.getDate()} ${d.toLocaleString('default', { month: 'short' })} ${d.getFullYear()} · ${time}`;
		if (d.toDateString() !== now.toDateString())
			return `${d.getDate()} ${d.toLocaleString('default', { month: 'short' })} · ${time}`;
		return time;
	}

	private renderMarkdownTo(el: HTMLElement, text: string) {
		el.empty();
		MarkdownRenderer.render(this.app, text, el, '', this);
	}

	private renderProposalCard(
		msgEl: HTMLElement,
		opts: {
			icon: string;
			actionLabel: string;
			target: string;
			reason: string;
			content?: string;
			isEdit?: boolean;
			applyLabel: string;
			onApply: () => Promise<TFile | null>;
			onDismiss: () => void;
		},
	) {
		const card = msgEl.createDiv(opts.isEdit ? 'kb-proposal-card kb-proposal-card--edit' : 'kb-proposal-card');

		const header = card.createDiv('kb-card-header');
		const iconEl = header.createSpan('kb-card-icon');
		setIcon(iconEl, opts.icon);
		header.createSpan({ cls: 'kb-card-label', text: opts.actionLabel });

		card.createDiv({ cls: 'kb-card-target', text: opts.target });

		if (opts.reason) {
			const reasonEl = card.createDiv('kb-card-reason');
			MarkdownRenderer.render(this.app, opts.reason, reasonEl, '', this);
		}

		if (opts.content) {
			let open = false;
			const toggle = card.createEl('button', { cls: 'kb-card-preview-toggle' });
			const toggleIcon = toggle.createSpan('kb-card-toggle-icon');
			const toggleText = toggle.createSpan();
			const preview = card.createEl('pre', { cls: 'kb-card-preview' });
			const lines = opts.content.split('\n');
			preview.setText(lines.length > 12 ? lines.slice(0, 12).join('\n') + '\n…' : opts.content);
			const refreshToggle = () => {
				toggleIcon.empty();
				setIcon(toggleIcon, open ? 'chevron-down' : 'chevron-right');
				toggleText.setText(open ? 'Hide preview' : 'Show preview');
				preview.style.display = open ? '' : 'none';
			};
			refreshToggle();
			toggle.addEventListener('click', () => { open = !open; refreshToggle(); });
		}

		const actions = card.createDiv('kb-proposal-actions');
		const applyBtn = actions.createEl('button', { text: opts.applyLabel, cls: 'kb-apply-btn' });
		const dismissBtn = actions.createEl('button', { text: 'Dismiss', cls: 'kb-dismiss-btn' });
		const loadingText = opts.applyLabel.replace(/^✓ /, '') + '…';

		applyBtn.addEventListener('click', async () => {
			applyBtn.textContent = loadingText;
			applyBtn.disabled = true;
			dismissBtn.disabled = true;
			try {
				const result = await opts.onApply();
				actions.empty();
				if (result) {
					const link = actions.createEl('button', { cls: 'kb-created-link' });
					const linkIcon = link.createSpan('kb-created-link-icon');
					setIcon(linkIcon, 'file-text');
					link.createSpan({ text: result.basename });
					link.addEventListener('click', () => this.app.workspace.openLinkText(result.path, '', false));
				} else {
					actions.createEl('span', { cls: 'kb-applied-label', text: 'Applied.' });
				}
			} catch (e) {
				new Notice(e instanceof Error ? e.message : String(e));
				applyBtn.textContent = opts.applyLabel;
				applyBtn.disabled = false;
				dismissBtn.disabled = false;
			}
		});

		dismissBtn.addEventListener('click', () => { opts.onDismiss(); card.remove(); });
	}

	async onClose() {}
}

// ── History view ──────────────────────────────────────────────────────────────

const VIEW_TYPE_HISTORY = 'kb-chat-history';

interface HistoryEntry {
	sessionPath: string;
	notePath: string | null;
	noteBasename: string;
	title: string | null;
	mtime: number;
}

class ChatHistoryView extends ItemView {
	private plugin: KbChatPlugin;

	constructor(leaf: WorkspaceLeaf, plugin: KbChatPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType() { return VIEW_TYPE_HISTORY; }
	getDisplayText() { return 'Chat History'; }
	getIcon() { return 'history'; }

	async onOpen() { await this.refresh(); }

	async refresh() {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass('kb-history-container');

		const header = container.createDiv('kb-history-header');
		header.createSpan({ text: 'Chat History', cls: 'kb-history-title' });
		const refreshBtn = header.createEl('button', { cls: 'kb-history-refresh', attr: { title: 'Refresh' } });
		setIcon(refreshBtn, 'refresh-cw');
		refreshBtn.addEventListener('click', () => this.refresh());

		const scroll = container.createDiv('kb-history-scroll');

		const sessions = await this.loadSessions();
		if (sessions.length === 0) {
			scroll.createEl('p', { text: 'No chat history yet.', cls: 'kb-history-empty' });
			return;
		}

		const getChatView = () => {
			const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
			return leaf?.view instanceof ChatView ? leaf.view as ChatView : null;
		};

		for (const entry of sessions) {
			const item = scroll.createDiv('kb-history-item');
			if (getChatView()?.activeSessionPath === entry.sessionPath) item.addClass('is-active');

			const mainContent = item.createDiv('kb-history-item-main');
			mainContent.createDiv({ text: entry.title ?? 'Untitled', cls: 'kb-history-item-title-text' });

			const meta = mainContent.createDiv({ cls: 'kb-history-item-meta' });
			const typeLabel = meta.createSpan({
				text: entry.notePath ? entry.noteBasename : 'Standalone',
				cls: entry.notePath ? 'kb-history-item-type kb-history-item-type--note' : 'kb-history-item-type kb-history-item-type--standalone',
			});
			meta.createSpan({ text: '·', cls: 'kb-history-item-meta-sep' });
			meta.createSpan({ text: this.formatDate(entry.mtime), cls: 'kb-history-item-date' });

			const actions = item.createDiv('kb-history-item-actions');
			const deleteIcon = actions.createSpan({ cls: 'kb-history-item-delete', attr: { title: 'Delete session' } });
			setIcon(deleteIcon, 'trash-2');
			deleteIcon.addEventListener('click', async (e) => {
				e.stopPropagation();
				try {
					const moved = await this.app.vault.adapter.trashSystem(entry.sessionPath);
					if (!moved) await this.app.vault.adapter.trashLocal(entry.sessionPath);
					item.remove();
					if (sessions.length === 1) await this.refresh();
				} catch (err) {
					new Notice(`Failed to delete session: ${err instanceof Error ? err.message : String(err)}`);
				}
			});

			item.addEventListener('click', async () => {
				const chatView = getChatView();
				if (!chatView) return;
				await chatView.openExternalSession(entry.sessionPath, entry.notePath);
				this.plugin.activateView();
			});
		}
	}

	private formatDate(mtime: number): string {
		return this.formatStamp(mtime);
	}

	private formatStamp(timestamp: number): string {
		const d = new Date(timestamp);
		const now = new Date();
		const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
		if (d.getFullYear() !== now.getFullYear())
			return `${d.getDate()} ${d.toLocaleString('default', { month: 'short' })} ${d.getFullYear()} · ${time}`;
		if (d.toDateString() !== now.toDateString())
			return `${d.getDate()} ${d.toLocaleString('default', { month: 'short' })} · ${time}`;
		return time;
	}

	private async collectSessionFiles(dir: string): Promise<string[]> {
		if (!(await this.app.vault.adapter.exists(dir))) return [];
		const result: string[] = [];
		const listing = await this.app.vault.adapter.list(dir);
		result.push(...listing.files.filter(f => f.endsWith('.md')));
		for (const subdir of listing.folders)
			result.push(...await this.collectSessionFiles(subdir));
		return result;
	}

	private async readTitle(path: string): Promise<string | null> {
		try {
			const raw = await this.app.vault.adapter.read(path);
			const m = raw.match(/^<!-- TITLE: (.+?) -->/);
			return m ? m[1] : null;
		} catch { return null; }
	}

	private async loadSessions(): Promise<HistoryEntry[]> {
		const allPaths = await this.collectSessionFiles('.chats');

		const entries = await Promise.all(allPaths.map(async (sessionPath) => {
			const stat = await this.app.vault.adapter.stat(sessionPath);
			if (!stat) return null;

			const isStandalone = sessionPath.startsWith('.chats/_global/');
			const notePath = isStandalone ? null : sessionPath.replace(/^\.chats\//, '').replace(/\/[^/]+\.md$/, '') + '.md';
			const noteBasename = isStandalone ? 'Standalone' : (notePath!.split('/').pop()!.replace(/\.md$/, ''));

			const title = await this.readTitle(sessionPath);
			return {
				sessionPath,
				notePath,
				noteBasename,
				title,
				mtime: stat.mtime,
			} as HistoryEntry;
		}));

		return entries
			.filter((e): e is HistoryEntry => e !== null)
			.sort((a, b) => b.mtime - a.mtime);
	}
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export default class KbChatPlugin extends Plugin {
	settings!: KbChatSettings;
	embeddingStore!: EmbeddingStore;
	private activeProposal: { file: TFile; content: string } | null = null;
	private updateTimers = new Map<string, ReturnType<typeof setTimeout>>();

	async onload() {
		await this.loadSettings();

		this.embeddingStore = new EmbeddingStore(this.app, `${this.manifest.dir}/embeddings.json`);
		await this.embeddingStore.load();

		this.registerEditorExtension([proposalField]);
		this.registerView(VIEW_TYPE, (leaf) => new ChatView(leaf, this));
		this.registerView(VIEW_TYPE_HISTORY, (leaf) => new ChatHistoryView(leaf, this));
		this.addRibbonIcon('message-circle', 'KB Chat', () => this.activateView());
		this.addRibbonIcon('history', 'Chat History', () => this.activateHistoryView());
		this.addCommand({ id: 'open-kb-chat', name: 'Open KB Chat', callback: () => this.activateView() });
		this.addCommand({ id: 'open-kb-chat-history', name: 'Open Chat History', callback: () => this.activateHistoryView() });
		this.addCommand({
			id: 'start-standalone-chat',
			name: 'Start new standalone chat',
			callback: async () => {
				await this.activateView();
				const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
				if (leaf?.view instanceof ChatView) await (leaf.view as ChatView).startNewSession(true);
			},
		});
		this.addCommand({
			id: 'index-vault-semantic',
			name: 'Index vault for semantic search',
			callback: async () => {
				const { provider, voyageApiKey, litellmBaseUrl } = this.settings;
				if (provider === 'anthropic' && !voyageApiKey) {
					new Notice('Add your Voyage API key in Settings → KB Chat first.');
					return;
				}
				if (provider === 'litellm' && !litellmBaseUrl) {
					new Notice('Add your LiteLLM base URL in Settings → KB Chat first.');
					return;
				}
				const ec = this.embeddingConfig();
				const files = this.app.vault.getMarkdownFiles();
				new Notice(`KB Chat: indexing ${files.length} notes…`);
				await this.embeddingStore.index(
					files,
					ec.apiKey,
					ec.model,
					(completed, total) => {
						if (total > 0 && (completed % 25 === 0 || completed === total))
							new Notice(`KB Chat: indexed ${completed}/${total} notes`);
					},
					ec.baseUrl,
				);
				new Notice(`KB Chat: semantic index complete (${files.length} notes).`);
			},
		});
		this.addSettingTab(new KbChatSettingTab(this.app, this));

		// Incremental index updates
		const indexFile = async (file: TFile) => {
			if (!this.canSearch()) return;
			const ec = this.embeddingConfig();
			const content = await this.app.vault.read(file);
			await this.embeddingStore.update(file.path, file.stat.mtime, file.basename, content, ec.apiKey, ec.model, ec.baseUrl);
		};

		this.registerEvent(this.app.vault.on('create', (file) => {
			if (file instanceof TFile && file.extension === 'md') indexFile(file);
		}));
		this.registerEvent(this.app.vault.on('modify', (file) => {
			if (!(file instanceof TFile) || file.extension !== 'md') return;
			if (!this.canSearch()) return;
			const existing = this.updateTimers.get(file.path);
			if (existing) clearTimeout(existing);
			this.updateTimers.set(file.path, setTimeout(() => {
				this.updateTimers.delete(file.path);
				indexFile(file);
			}, 3000));
		}));
		this.registerEvent(this.app.vault.on('delete', (file) => {
			if (file instanceof TFile && file.extension === 'md')
				this.embeddingStore.remove(file.path);
		}));
		this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
			if (!(file instanceof TFile) || file.extension !== 'md') return;
			this.embeddingStore.remove(oldPath);
			indexFile(file);
		}));

		this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
			if (!(file instanceof TFile) || file.extension !== 'md') return;
			menu.addItem(item => item
				.setTitle('Add to chat context')
				.setIcon('message-circle')
				.onClick(() => {
					const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
					if (leaf?.view instanceof ChatView) (leaf.view as ChatView).addContextFile(file);
				})
			);
		}));
	}

	showProposal(file: TFile, originalContent: string, proposedContent: string) {
		this.activeProposal = { file, content: proposedContent };
		const cmView = this.getCmViewForFile(file);
		if (!cmView) return;
		const ops = computeDiff(originalContent.split('\n'), proposedContent.split('\n'));
		cmView.dispatch({ effects: setProposalEffect.of(buildDecorations(cmView.state.doc, ops)) });
	}

	async applyProposal() {
		if (!this.activeProposal) return;
		await this.app.vault.modify(this.activeProposal.file, this.activeProposal.content);
		this.clearProposal();
	}

	clearProposal() {
		const file = this.activeProposal?.file;
		this.activeProposal = null;
		if (file) this.getCmViewForFile(file)?.dispatch({ effects: setProposalEffect.of(null) });
	}

	private getCmViewForFile(file: TFile): EditorView | null {
		let found: EditorView | null = null;
		this.app.workspace.iterateAllLeaves(leaf => {
			if (leaf.view instanceof MarkdownView && leaf.view.file === file) {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				found = (leaf.view.editor as any).cm as EditorView;
			}
		});
		return found;
	}

	async activateView() {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
		if (!leaf) {
			leaf = workspace.getRightLeaf(false)!;
			await leaf.setViewState({ type: VIEW_TYPE, active: true });
		}
		workspace.revealLeaf(leaf);
	}

	async activateHistoryView() {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(VIEW_TYPE_HISTORY)[0];
		if (!leaf) {
			leaf = workspace.getRightLeaf(false)!;
			await leaf.setViewState({ type: VIEW_TYPE_HISTORY, active: true });
		}
		workspace.revealLeaf(leaf);
		const view = leaf.view;
		if (view instanceof ChatHistoryView) await view.refresh();
	}

	embeddingConfig(): { apiKey: string; model: string; baseUrl?: string } {
		const { provider, voyageApiKey, voyageModel, litellmBaseUrl, litellmApiKey, litellmEmbedModel } = this.settings;
		if (provider === 'litellm') return { apiKey: litellmApiKey, model: litellmEmbedModel || voyageModel, baseUrl: litellmBaseUrl };
		return { apiKey: voyageApiKey, model: voyageModel };
	}

	canSearch(): boolean {
		const { provider, voyageApiKey, litellmBaseUrl, litellmEmbedModel } = this.settings;
		const hasCredentials = provider === 'litellm' ? (!!litellmBaseUrl && !!litellmEmbedModel) : !!voyageApiKey;
		return hasCredentials && this.embeddingStore.isIndexed();
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

// ── Settings tab ──────────────────────────────────────────────────────────────

class KbChatSettingTab extends PluginSettingTab {
	plugin: KbChatPlugin;

	constructor(app: App, plugin: KbChatPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl('h2', { text: 'KB Chat' });

		new Setting(containerEl)
			.setName('Use Shift+Enter to send')
			.setDesc('When on, Shift+Enter sends and Enter adds a new line. When off (default), Enter sends.')
			.addToggle(toggle =>
				toggle
					.setValue(this.plugin.settings.shiftEnterToSend)
					.onChange(async (value) => {
						this.plugin.settings.shiftEnterToSend = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Base system prompt')
			.setDesc('The opening instruction sent to the AI on every request. Context notes and tool hints are appended automatically.')
			.addTextArea(area => {
				area.setPlaceholder(DEFAULT_SETTINGS.basePrompt)
					.setValue(this.plugin.settings.basePrompt)
					.onChange(async (v) => {
						this.plugin.settings.basePrompt = v;
						await this.plugin.saveSettings();
					});
				area.inputEl.rows = 4;
				area.inputEl.style.width = '100%';
			});

		new Setting(containerEl)
			.setName('Note editing')
			.setDesc('Controls when the AI may use the edit_note tool to propose changes to the open note.')
			.addDropdown(drop =>
				drop
					.addOption('never', 'Never — disable note editing')
					.addOption('on_request', 'On request only (default)')
					.addOption('proactive', 'Suggest when appropriate')
					.setValue(this.plugin.settings.editMode)
					.onChange(async (v) => {
						this.plugin.settings.editMode = v as EditMode;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Note creation')
			.setDesc('Controls when the AI may use the create_note tool to propose creating a new note.')
			.addDropdown(drop =>
				drop
					.addOption('never', 'Never — disable note creation')
					.addOption('on_request', 'On request only (default)')
					.addOption('proactive', 'Suggest when appropriate')
					.setValue(this.plugin.settings.createMode)
					.onChange(async (v) => {
						this.plugin.settings.createMode = v as EditMode;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Note appending')
			.setDesc('Controls when the AI may use the append_to_note tool to propose adding content to an existing note.')
			.addDropdown(drop =>
				drop
					.addOption('never', 'Never — disable note appending')
					.addOption('on_request', 'On request only (default)')
					.addOption('proactive', 'Suggest when appropriate')
					.setValue(this.plugin.settings.appendMode)
					.onChange(async (v) => {
						this.plugin.settings.appendMode = v as EditMode;
						await this.plugin.saveSettings();
					})
			);

		containerEl.createEl('h3', { text: 'AI provider' });

		new Setting(containerEl)
			.setName('Provider')
			.addDropdown(drop =>
				drop
					.addOption('anthropic', 'Anthropic (direct)')
					.addOption('litellm', 'LiteLLM')
					.setValue(this.plugin.settings.provider)
					.onChange(async (v) => {
						this.plugin.settings.provider = v as Provider;
						// Translate voyage model name when switching providers
						const { voyageModel } = this.plugin.settings;
						if (v === 'litellm' && !voyageModel.startsWith('voyage/'))
							this.plugin.settings.voyageModel = `voyage/${voyageModel}`;
						else if (v === 'anthropic' && voyageModel.startsWith('voyage/'))
							this.plugin.settings.voyageModel = voyageModel.replace('voyage/', '');
						await this.plugin.saveSettings();
						this.display();
					})
			);

		if (this.plugin.settings.provider === 'anthropic') {
			containerEl.createEl('h3', { text: 'Anthropic' });

			new Setting(containerEl)
				.setName('API key')
				.addText(text =>
					text.setPlaceholder('sk-ant-…').setValue(this.plugin.settings.anthropicApiKey)
						.onChange(async (v) => { this.plugin.settings.anthropicApiKey = v.trim(); await this.plugin.saveSettings(); })
				);

			new Setting(containerEl)
				.setName('Model')
				.addDropdown(drop => {
					for (const [id, label] of Object.entries(ANTHROPIC_MODELS)) drop.addOption(id, 'Claude ' + label);
					if (!(this.plugin.settings.anthropicModel in ANTHROPIC_MODELS))
						drop.addOption(this.plugin.settings.anthropicModel, this.plugin.settings.anthropicModel);
					drop.setValue(this.plugin.settings.anthropicModel);
					drop.onChange(async (v) => { this.plugin.settings.anthropicModel = v; await this.plugin.saveSettings(); });
				});
		} else {
			containerEl.createEl('h3', { text: 'LiteLLM' });

			new Setting(containerEl)
				.setName('Base URL')
				.setDesc('The URL where your LiteLLM proxy is running.')
				.addText(text =>
					text.setPlaceholder('http://localhost:4000')
						.setValue(this.plugin.settings.litellmBaseUrl)
						.onChange(async (v) => { this.plugin.settings.litellmBaseUrl = v.trim(); await this.plugin.saveSettings(); })
				);

			new Setting(containerEl)
				.setName('API key')
				.setDesc('Your LiteLLM master key. Leave blank if your instance has no auth.')
				.addText(text =>
					text.setPlaceholder('sk-…')
						.setValue(this.plugin.settings.litellmApiKey)
						.onChange(async (v) => { this.plugin.settings.litellmApiKey = v.trim(); await this.plugin.saveSettings(); })
				);

			// Model fetch + selection
			const modelSection = containerEl.createDiv();
			const renderModelSelectors = (allModels: string[]) => {
				modelSection.empty();
				const chatModels = allModels.filter(m => !/(embed|voyage|rerank)/i.test(m));
				const embedModels = allModels.filter(m => /(embed|voyage)/i.test(m));

				new Setting(modelSection)
					.setName('Chat model')
					.addDropdown(drop => {
						if (chatModels.length === 0) drop.addOption('', '— fetch models first —');
						for (const m of chatModels) drop.addOption(m, m);
						if (this.plugin.settings.litellmChatModel && !chatModels.includes(this.plugin.settings.litellmChatModel))
							drop.addOption(this.plugin.settings.litellmChatModel, this.plugin.settings.litellmChatModel);
						drop.setValue(this.plugin.settings.litellmChatModel);
						drop.onChange(async (v) => {
							this.plugin.settings.litellmChatModel = v;
							await this.plugin.saveSettings();
						});
					});

				new Setting(modelSection)
					.setName('Embedding model')
					.addDropdown(drop => {
						if (embedModels.length === 0) drop.addOption('', '— fetch models first —');
						for (const m of embedModels) drop.addOption(m, m);
						if (this.plugin.settings.litellmEmbedModel && !embedModels.includes(this.plugin.settings.litellmEmbedModel))
							drop.addOption(this.plugin.settings.litellmEmbedModel, this.plugin.settings.litellmEmbedModel);
						drop.setValue(this.plugin.settings.litellmEmbedModel);
						drop.onChange(async (v) => {
							this.plugin.settings.litellmEmbedModel = v;
							await this.plugin.saveSettings();
						});
					});
			};

			// Render with any previously saved models (empty on first load)
			const savedChat = this.plugin.settings.litellmChatModel;
			const savedEmbed = this.plugin.settings.litellmEmbedModel;
			const seedModels = [...new Set([savedChat, savedEmbed].filter(Boolean))];
			renderModelSelectors(seedModels);

			new Setting(containerEl)
				.setName('Available models')
				.setDesc('Fetch the list of models from your LiteLLM instance.')
				.addButton(btn =>
					btn.setButtonText('Fetch models').onClick(async () => {
						const { litellmBaseUrl, litellmApiKey } = this.plugin.settings;
						if (!litellmBaseUrl) { new Notice('Enter a LiteLLM base URL first.'); return; }
						btn.setButtonText('Fetching…');
						btn.setDisabled(true);
						try {
							const resp = await requestUrl({
								url: `${litellmBaseUrl.replace(/\/$/, '')}/v1/models`,
								method: 'GET',
								headers: { ...(litellmApiKey ? { 'Authorization': `Bearer ${litellmApiKey}` } : {}) },
								throw: false,
							});
							if (resp.status !== 200) throw new Error(`HTTP ${resp.status}`);
							const data = resp.json as { data: Array<{ id: string }> };
							const models = data.data.map(m => m.id).sort();
							renderModelSelectors(models);
							new Notice(`Fetched ${models.length} models.`);
						} catch (e) {
							new Notice(`Failed to fetch models: ${e instanceof Error ? e.message : String(e)}`);
						} finally {
							btn.setButtonText('Fetch models');
							btn.setDisabled(false);
						}
					})
				);
		}

		containerEl.createEl('h3', { text: 'Semantic search (Voyage AI)' });
		const voyageDesc = this.plugin.settings.provider === 'litellm'
			? 'Embeddings are routed through LiteLLM using the voyage model name below. Run "Index vault for semantic search" from the command palette after configuring LiteLLM.'
			: 'Voyage AI embeddings let the plugin find related notes across your vault and surface them as context. Run "Index vault for semantic search" from the command palette after adding your key.';
		containerEl.createEl('p', { text: voyageDesc, cls: 'setting-item-description' });

		if (this.plugin.settings.provider === 'anthropic') {
			new Setting(containerEl)
				.setName('API key')
				.addText(text =>
					text.setPlaceholder('pa-…').setValue(this.plugin.settings.voyageApiKey)
						.onChange(async (v) => { this.plugin.settings.voyageApiKey = v.trim(); await this.plugin.saveSettings(); })
				);
		}

		new Setting(containerEl)
			.setName('Model')
			.addDropdown(drop => {
				if (this.plugin.settings.provider === 'litellm') {
					drop
						.addOption('voyage/voyage-3-lite', 'voyage/voyage-3-lite (faster, cheaper)')
						.addOption('voyage/voyage-3', 'voyage/voyage-3 (higher quality)');
				} else {
					drop
						.addOption('voyage-3-lite', 'voyage-3-lite (faster, cheaper)')
						.addOption('voyage-3', 'voyage-3 (higher quality)');
				}
				drop.setValue(this.plugin.settings.voyageModel)
					.onChange(async (v) => { this.plugin.settings.voyageModel = v; await this.plugin.saveSettings(); });
			});

		new Setting(containerEl)
			.setName('Chunks to retrieve')
			.setDesc('How many matching chunks to pull per message. Multiple chunks from the same note are grouped together.')
			.addSlider(slider =>
				slider
					.setLimits(1, 15, 1)
					.setValue(this.plugin.settings.semanticResultCount)
					.setDynamicTooltip()
					.onChange(async (v) => { this.plugin.settings.semanticResultCount = v; await this.plugin.saveSettings(); })
			);

		const indexCount = this.plugin.embeddingStore.indexedCount();
		new Setting(containerEl)
			.setName('Index status')
			.setDesc(indexCount > 0 ? `${indexCount} notes indexed.` : 'Not indexed yet.')
			.addButton(btn =>
				btn.setButtonText('Re-index vault').onClick(async () => {
					const { provider, voyageApiKey, litellmBaseUrl } = this.plugin.settings;
					if (provider === 'anthropic' && !voyageApiKey) {
						new Notice('Add your Voyage API key first.');
						return;
					}
					if (provider === 'litellm' && !litellmBaseUrl) {
						new Notice('Add your LiteLLM base URL first.');
						return;
					}
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					(this.plugin.app as any).commands.executeCommandById('kb-chat:index-vault-semantic');
				})
			);
	}
}
