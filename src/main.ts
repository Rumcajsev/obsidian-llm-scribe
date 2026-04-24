import {
	App, ItemView, Plugin, PluginSettingTab, Setting,
	WorkspaceLeaf, Notice, requestUrl, TFile, MarkdownView,
} from 'obsidian';
import { StateField, StateEffect, RangeSetBuilder } from '@codemirror/state';
import { EditorView, Decoration, DecorationSet, WidgetType } from '@codemirror/view';

const VIEW_TYPE = 'kb-chat';

// ── Settings ──────────────────────────────────────────────────────────────────

interface KbChatSettings {
	provider: 'anthropic' | 'google';
	anthropicApiKey: string;
	anthropicModel: string;
	googleApiKey: string;
	googleModel: string;
}

const DEFAULT_SETTINGS: KbChatSettings = {
	provider: 'anthropic',
	anthropicApiKey: '',
	anthropicModel: 'claude-sonnet-4-6',
	googleApiKey: '',
	googleModel: 'gemini-2.0-flash',
};

// ── Message / API types ───────────────────────────────────────────────────────

interface Message {
	role: 'user' | 'assistant';
	content: string;
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

// Google Gemini
type GeminiPart =
	| { text: string }
	| { functionCall: { name: string; args: Record<string, unknown> } }
	| { functionResponse: { name: string; response: Record<string, unknown> } };

type GeminiContent = { role: 'user' | 'model'; parts: GeminiPart[] };

interface GeminiResponse {
	candidates: Array<{
		content: { role: string; parts: GeminiPart[] };
		finishReason: string;
	}>;
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

// ── SSE streaming helper ──────────────────────────────────────────────────────

async function* streamSSE(response: Response): AsyncGenerator<unknown> {
	const reader = response.body!.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split('\n');
		buffer = lines.pop() ?? '';
		for (const line of lines) {
			if (!line.startsWith('data: ')) continue;
			const data = line.slice(6).trim();
			if (data === '[DONE]') return;
			try { yield JSON.parse(data); } catch { /* skip malformed */ }
		}
	}
}

// ── Tool definition ───────────────────────────────────────────────────────────

const EDIT_NOTE_TOOL_SCHEMA = {
	name: 'edit_note',
	description: 'Propose a new version of the current note. The change will be previewed in the editor and the user will confirm before it is saved.',
	parameters: {
		type: 'object',
		properties: {
			content: {
				type: 'string',
				description: 'The complete new content for the note in markdown.',
			},
		},
		required: ['content'],
	},
};

const ANTHROPIC_EDIT_TOOL = {
	name: EDIT_NOTE_TOOL_SCHEMA.name,
	description: EDIT_NOTE_TOOL_SCHEMA.description,
	input_schema: EDIT_NOTE_TOOL_SCHEMA.parameters,
};

const GOOGLE_EDIT_TOOL = {
	function_declarations: [{
		name: EDIT_NOTE_TOOL_SCHEMA.name,
		description: EDIT_NOTE_TOOL_SCHEMA.description,
		parameters: EDIT_NOTE_TOOL_SCHEMA.parameters,
	}],
};

// ── ChatView ──────────────────────────────────────────────────────────────────

class ChatView extends ItemView {
	private plugin: KbChatPlugin;
	private messages: Message[] = [];
	private inputEl!: HTMLTextAreaElement;
	private messagesEl!: HTMLElement;
	private contextEl!: HTMLElement;
	private sendBtn!: HTMLButtonElement;
	private isBusy = false;

	constructor(leaf: WorkspaceLeaf, plugin: KbChatPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType() { return VIEW_TYPE; }
	getDisplayText() { return 'KB Chat'; }
	getIcon() { return 'message-circle'; }

	async onOpen() {
		this.buildUI();
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', () => this.updateContext())
		);
		this.updateContext();
	}

	private buildUI() {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass('kb-chat-container');
		this.contextEl = container.createDiv('kb-chat-context');
		this.messagesEl = container.createDiv('kb-chat-messages');
		const inputArea = container.createDiv('kb-chat-input-area');
		this.inputEl = inputArea.createEl('textarea', {
			attr: { placeholder: 'Ask about this note… (Cmd+Enter to send)' },
		});
		this.sendBtn = inputArea.createEl('button', { text: 'Send', cls: 'kb-send-btn' });
		this.sendBtn.addEventListener('click', () => this.sendMessage());
		this.inputEl.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) this.sendMessage();
		});
	}

	private updateContext() {
		const file = this.app.workspace.getActiveFile();
		this.contextEl.empty();
		const label = file ? file.basename : 'No file open';
		const cls = file ? 'kb-context-label' : 'kb-context-label kb-context-empty';
		this.contextEl.createEl('span', { text: label, cls });
	}

	private async sendMessage() {
		if (this.isBusy) return;
		const text = this.inputEl.value.trim();
		if (!text) return;

		const { provider, anthropicApiKey, googleApiKey } = this.plugin.settings;
		const activeKey = provider === 'anthropic' ? anthropicApiKey : googleApiKey;
		if (!activeKey) {
			new Notice(`Add your ${provider === 'anthropic' ? 'Anthropic' : 'Google'} API key in Settings → KB Chat`);
			return;
		}

		const file = this.app.workspace.getActiveFile();
		let originalContent = '';
		let system = 'You are a helpful thinking partner.';
		if (file) {
			originalContent = await this.app.vault.read(file);
			system = `You are a helpful thinking partner. The user has the following note open:\n\n# ${file.basename}\n\n${originalContent}\n\nHelp them think through ideas. When asked to edit or modify the note, use the edit_note tool — changes will be previewed before being saved.`;
		}

		this.inputEl.value = '';
		this.messages.push({ role: 'user', content: text });
		this.renderMessage('user', text);

		const { el: msgEl, textEl } = this.renderPendingMessage();
		this.isBusy = true;
		this.sendBtn.disabled = true;
		this.sendBtn.setText('…');

		try {
			const fn = provider === 'anthropic' ? this.callAnthropic.bind(this) : this.callGoogle.bind(this);
			const { text: reply, proposedContent } = await fn(system, this.messages.slice(0, -1), text, file, (chunk: string) => {
				textEl.setText(chunk);
				this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
			});

			const displayText = reply || (proposedContent ? 'Changes previewed in editor — apply or dismiss below.' : '(no response)');
			textEl.setText(displayText);

			if (proposedContent && file) {
				this.plugin.showProposal(file, originalContent, proposedContent);
				this.renderProposalActions(msgEl,
					async () => { await this.plugin.applyProposal(); this.messages.push({ role: 'assistant', content: displayText }); },
					() => { this.plugin.clearProposal(); this.messages.push({ role: 'assistant', content: displayText }); },
				);
			} else {
				this.messages.push({ role: 'assistant', content: displayText });
			}

			this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			textEl.setText(`Error: ${msg}`);
		} finally {
			this.isBusy = false;
			this.sendBtn.disabled = false;
			this.sendBtn.setText('Send');
		}
	}

	private async callAnthropic(
		system: string, history: Message[], userMessage: string, file: TFile | null,
		onText: (t: string) => void,
	): Promise<{ text: string; proposedContent: string | null }> {
		const apiMessages: AnthropicMessage[] = [
			...history.map(m => ({ role: m.role, content: m.content })),
			{ role: 'user', content: userMessage },
		];
		const tools = file ? [ANTHROPIC_EDIT_TOOL] : [];
		let finalText = '';
		let proposedContent: string | null = null;

		for (let turn = 0; turn < 5; turn++) {
			if (turn === 0) {
				// Stream first turn so text appears in real-time
				const response = await fetch('https://api.anthropic.com/v1/messages', {
					method: 'POST',
					headers: {
						'x-api-key': this.plugin.settings.anthropicApiKey,
						'anthropic-version': '2023-06-01',
						'content-type': 'application/json',
					},
					body: JSON.stringify({
						model: this.plugin.settings.anthropicModel,
						max_tokens: 4096, system, messages: apiMessages, stream: true,
						...(tools.length ? { tools } : {}),
					}),
				});

				if (!response.ok) {
					const err = await response.json() as { error?: { message?: string } };
					throw new Error(err.error?.message ?? response.statusText);
				}

				// Accumulate blocks by index to reconstruct content for history
				type Block = { type: string; text?: string; id?: string; name?: string; inputJson?: string };
				const blocks = new Map<number, Block>();
				let accumText = '';
				let stopReason = '';

				for await (const evt of streamSSE(response)) {
					const e = evt as Record<string, unknown>;
					if (e.type === 'content_block_start') {
						const cb = e.content_block as Record<string, unknown>;
						blocks.set(e.index as number, { type: cb.type as string, id: cb.id as string, name: cb.name as string, text: '', inputJson: '' });
					} else if (e.type === 'content_block_delta') {
						const d = e.delta as Record<string, unknown>;
						const b = blocks.get(e.index as number);
						if (b) {
							if (d.type === 'text_delta') { b.text = (b.text ?? '') + (d.text as string); accumText = b.text; onText(accumText); }
							if (d.type === 'input_json_delta') b.inputJson = (b.inputJson ?? '') + (d.partial_json as string);
						}
					} else if (e.type === 'message_delta') {
						stopReason = ((e.delta as Record<string, unknown>).stop_reason as string) ?? '';
					}
				}

				// Reconstruct content blocks for history
				const contentBlocks: AnthropicContentBlock[] = [];
				for (const [, b] of [...blocks.entries()].sort((a, z) => a[0] - z[0])) {
					if (b.type === 'text') contentBlocks.push({ type: 'text', text: b.text ?? '' });
					else if (b.type === 'tool_use') {
						try { contentBlocks.push({ type: 'tool_use', id: b.id!, name: b.name!, input: JSON.parse(b.inputJson ?? '{}') }); }
						catch { /* skip malformed */ }
					}
				}
				apiMessages.push({ role: 'assistant', content: contentBlocks });

				if (stopReason !== 'tool_use') { finalText = accumText; break; }

				const toolResults: AnthropicContentBlock[] = [];
				for (const b of contentBlocks) {
					if (b.type === 'tool_use' && b.name === 'edit_note') {
						proposedContent = (b.input as { content: string }).content;
						toolResults.push({ type: 'tool_result', tool_use_id: b.id, content: 'Proposal previewed in editor.' });
					}
				}
				apiMessages.push({ role: 'user', content: toolResults });
			} else {
				// Follow-up turns after tool use are short — non-streaming is fine
				const response = await requestUrl({
					url: 'https://api.anthropic.com/v1/messages',
					method: 'POST',
					headers: { 'x-api-key': this.plugin.settings.anthropicApiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
					body: JSON.stringify({ model: this.plugin.settings.anthropicModel, max_tokens: 1024, system, messages: apiMessages, ...(tools.length ? { tools } : {}) }),
					throw: false,
				});
				if (response.status !== 200) { const err = response.json as { error?: { message?: string } }; throw new Error(err.error?.message ?? `HTTP ${response.status}`); }
				const data = response.json as AnthropicResponse;
				apiMessages.push({ role: 'assistant', content: data.content });
				if (data.stop_reason !== 'tool_use') {
					finalText = (data.content.find(b => b.type === 'text') as { type: 'text'; text: string } | undefined)?.text ?? '';
					onText(finalText);
					break;
				}
				const toolResults: AnthropicContentBlock[] = [];
				for (const block of data.content) {
					if (block.type === 'tool_use' && block.name === 'edit_note') {
						proposedContent = (block.input as { content: string }).content;
						toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: 'Proposal previewed in editor.' });
					}
				}
				apiMessages.push({ role: 'user', content: toolResults });
			}
		}

		return { text: finalText, proposedContent };
	}

	private async callGoogle(
		system: string, history: Message[], userMessage: string, file: TFile | null,
		onText: (t: string) => void,
	): Promise<{ text: string; proposedContent: string | null }> {
		const contents: GeminiContent[] = [
			...history.map(m => ({ role: (m.role === 'user' ? 'user' : 'model') as 'user' | 'model', parts: [{ text: m.content }] })),
			{ role: 'user', parts: [{ text: userMessage }] },
		];
		const tools = file ? [GOOGLE_EDIT_TOOL] : [];
		let finalText = '';
		let proposedContent: string | null = null;
		const { googleApiKey, googleModel } = this.plugin.settings;

		// Stream first turn
		const response = await fetch(
			`https://generativelanguage.googleapis.com/v1beta/models/${googleModel}:streamGenerateContent?key=${googleApiKey}&alt=sse`,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					system_instruction: { parts: [{ text: system }] },
					contents,
					...(tools.length ? { tools } : {}),
					generationConfig: { maxOutputTokens: 4096 },
				}),
			}
		);

		if (!response.ok) {
			const err = await response.json() as { error?: { message?: string } };
			throw new Error(err.error?.message ?? response.statusText);
		}

		let accumText = '';
		let lastParts: GeminiPart[] = [];

		for await (const evt of streamSSE(response)) {
			const chunk = evt as GeminiResponse;
			const candidate = chunk.candidates?.[0];
			if (!candidate) continue;
			lastParts = candidate.content.parts;
			for (const part of lastParts) {
				if ('text' in part) { accumText += part.text; onText(accumText); }
			}
		}

		// Check last chunk for function call
		const funcCallPart = lastParts.find(p => 'functionCall' in p) as
			{ functionCall: { name: string; args: Record<string, unknown> } } | undefined;

		if (!funcCallPart) {
			finalText = accumText;
		} else if (funcCallPart.functionCall.name === 'edit_note' && file) {
			proposedContent = funcCallPart.functionCall.args.content as string;
			// Follow-up: let Claude confirm (non-streaming, quick)
			contents.push({ role: 'model', parts: lastParts });
			contents.push({ role: 'user', parts: [{ functionResponse: { name: 'edit_note', response: { result: 'Proposal previewed in editor.' } } }] });

			const followUp = await requestUrl({
				url: `https://generativelanguage.googleapis.com/v1beta/models/${googleModel}:generateContent?key=${googleApiKey}`,
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ system_instruction: { parts: [{ text: system }] }, contents, ...(tools.length ? { tools } : {}), generationConfig: { maxOutputTokens: 512 } }),
				throw: false,
			});
			if (followUp.status === 200) {
				const data = followUp.json as GeminiResponse;
				const textPart = data.candidates?.[0]?.content.parts.find(p => 'text' in p) as { text: string } | undefined;
				finalText = textPart?.text ?? '';
				onText(finalText);
			}
		}

		return { text: finalText, proposedContent };
	}

	private renderMessage(role: 'user' | 'assistant', text: string) {
		const el = this.messagesEl.createDiv(`kb-message kb-message-${role}`);
		el.createEl('div', { cls: 'kb-message-role', text: role === 'user' ? 'You' : 'AI' });
		el.createEl('div', { cls: 'kb-message-text', text });
		this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
	}

	private renderPendingMessage() {
		const el = this.messagesEl.createDiv('kb-message kb-message-assistant');
		el.createEl('div', { cls: 'kb-message-role', text: 'AI' });
		const textEl = el.createEl('div', { cls: 'kb-message-text', text: '…' });
		this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
		return { el, textEl };
	}

	private renderProposalActions(msgEl: HTMLElement, onApply: () => Promise<void>, onDismiss: () => void) {
		const actions = msgEl.createDiv('kb-proposal-actions');
		const applyBtn = actions.createEl('button', { text: '✓ Apply', cls: 'kb-apply-btn' });
		const dismissBtn = actions.createEl('button', { text: '✕ Dismiss', cls: 'kb-dismiss-btn' });
		applyBtn.addEventListener('click', async () => {
			actions.empty();
			actions.createEl('span', { text: 'Applied.', cls: 'kb-applied-label' });
			await onApply();
		});
		dismissBtn.addEventListener('click', () => { actions.remove(); onDismiss(); });
	}

	async onClose() {}
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export default class KbChatPlugin extends Plugin {
	settings!: KbChatSettings;
	private activeProposal: { file: TFile; content: string } | null = null;

	async onload() {
		await this.loadSettings();
		this.registerEditorExtension([proposalField]);
		this.registerView(VIEW_TYPE, (leaf) => new ChatView(leaf, this));
		this.addRibbonIcon('message-circle', 'KB Chat', () => this.activateView());
		this.addCommand({ id: 'open-kb-chat', name: 'Open KB Chat', callback: () => this.activateView() });
		this.addSettingTab(new KbChatSettingTab(this.app, this));
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
			.setName('Provider')
			.setDesc('Which AI provider to use')
			.addDropdown(drop =>
				drop
					.addOption('anthropic', 'Anthropic (Claude)')
					.addOption('google', 'Google (Gemini)')
					.setValue(this.plugin.settings.provider)
					.onChange(async (value) => {
						this.plugin.settings.provider = value as 'anthropic' | 'google';
						await this.plugin.saveSettings();
					})
			);

		containerEl.createEl('h3', { text: 'Anthropic' });

		new Setting(containerEl)
			.setName('API key')
			.addText(text =>
				text.setPlaceholder('sk-ant-…').setValue(this.plugin.settings.anthropicApiKey)
					.onChange(async (v) => { this.plugin.settings.anthropicApiKey = v.trim(); await this.plugin.saveSettings(); })
			);

		new Setting(containerEl)
			.setName('Model')
			.addText(text =>
				text.setValue(this.plugin.settings.anthropicModel)
					.onChange(async (v) => { this.plugin.settings.anthropicModel = v.trim(); await this.plugin.saveSettings(); })
			);

		containerEl.createEl('h3', { text: 'Google' });

		new Setting(containerEl)
			.setName('API key')
			.addText(text =>
				text.setPlaceholder('AIza…').setValue(this.plugin.settings.googleApiKey)
					.onChange(async (v) => { this.plugin.settings.googleApiKey = v.trim(); await this.plugin.saveSettings(); })
			);

		new Setting(containerEl)
			.setName('Model')
			.addText(text =>
				text.setValue(this.plugin.settings.googleModel)
					.onChange(async (v) => { this.plugin.settings.googleModel = v.trim(); await this.plugin.saveSettings(); })
			);
	}
}
