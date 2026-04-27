import { App, TFile, requestUrl } from 'obsidian';

interface ChunkEntry {
	heading: string;
	text: string;
	embedding: number[];
}

interface NoteEntry {
	mtime: number;
	attachments: string[];
	chunks: ChunkEntry[];
}

interface EmbeddingsDB {
	version: number;
	model: string;
	notes: Record<string, NoteEntry>;
}

export interface ChunkHit {
	path: string;
	score: number;
	heading: string;
	text: string; // chunk body, basename prefix already stripped
}

const SINGLE_THRESHOLD = 1800;
const CHUNK_TARGET     = 1200;
const CHUNK_MAX        = 1800;
const BATCH_SIZE       = 50;
const OVERLAP_CHARS    = 150;

function detectAttachments(content: string): string[] {
	const re = /!?\[\[([^\]]+\.pdf)\]\]/gi;
	const found: string[] = [];
	let m: RegExpExecArray | null;
	while ((m = re.exec(content)) !== null) found.push(m[1]);
	return [...new Set(found)];
}

function makePrefix(basename: string, heading: string): string {
	return heading ? `${basename} > ${heading}\n\n` : `${basename}\n\n`;
}

function tailOverlap(text: string): string {
	const tail = text.slice(-OVERLAP_CHARS).trim();
	const spaceIdx = tail.indexOf(' ');
	return spaceIdx > 0 ? tail.slice(spaceIdx + 1) : tail;
}

// Split dense text into sentence-sized blocks, each ≤ CHUNK_MAX.
function splitBySentence(text: string): string[] {
	const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z])/);
	const blocks: string[] = [];
	let acc = '';
	for (const s of sentences) {
		const addLen = acc ? acc.length + 1 + s.length : s.length;
		if (addLen > CHUNK_MAX && acc) {
			blocks.push(acc.trim());
			acc = s;
		} else {
			acc = acc ? acc + ' ' + s : s;
		}
	}
	if (acc.trim()) blocks.push(acc.trim());
	return blocks.length > 0 ? blocks : [text];
}

// Accumulate pre-split blocks up to CHUNK_TARGET, flushing with overlap.
function accumulateBlocks(
	blocks: string[],
	heading: string,
	prefix: string,
	out: Array<{ heading: string; text: string }>,
): void {
	let acc = '';
	for (const block of blocks) {
		if (!block.trim()) continue;
		const addLen = acc ? acc.length + 2 + block.length : block.length;
		if (addLen > CHUNK_TARGET && acc) {
			out.push({ heading, text: prefix + acc.trim() });
			const carry = tailOverlap(acc);
			acc = carry ? carry + '\n\n' + block : block;
		} else {
			acc = acc ? acc + '\n\n' + block : block;
		}
	}
	if (acc.trim()) out.push({ heading, text: prefix + acc.trim() });
}

// Level 3: paragraph split with sentence fallback for oversized paragraphs.
function splitByParagraphs(
	body: string,
	heading: string,
	prefix: string,
	out: Array<{ heading: string; text: string }>,
): void {
	const blocks: string[] = [];
	for (const para of body.split(/\n\n+/)) {
		if (!para.trim()) continue;
		if (para.length > CHUNK_MAX) {
			blocks.push(...splitBySentence(para));
		} else {
			blocks.push(para);
		}
	}
	accumulateBlocks(blocks, heading, prefix, out);
}

// Level 2: try H4/H5 split, fall through to paragraphs if none found.
function splitSection(
	basename: string,
	heading: string,
	body: string,
	out: Array<{ heading: string; text: string }>,
): void {
	const prefix = makePrefix(basename, heading);
	if (body.length <= CHUNK_MAX) {
		out.push({ heading, text: prefix + body });
		return;
	}

	const h45Parts = body.split(/(?=\n#{4,5} )/);
	if (h45Parts.length > 1) {
		for (const part of h45Parts) {
			const sub = part.trim();
			if (!sub) continue;
			const nl = sub.indexOf('\n');
			const firstLine = (nl >= 0 ? sub.slice(0, nl) : sub).trim();
			const isH45 = /^#{4,5} /.test(firstLine);
			const subHeading = isH45
				? (heading ? `${heading} > ${firstLine.replace(/^#+\s+/, '')}` : firstLine.replace(/^#+\s+/, ''))
				: heading;
			const subPrefix = makePrefix(basename, subHeading);
			if (sub.length <= CHUNK_MAX) {
				out.push({ heading: subHeading, text: subPrefix + sub });
			} else {
				splitByParagraphs(sub, subHeading, subPrefix, out);
			}
		}
		return;
	}

	splitByParagraphs(body, heading, prefix, out);
}

// Level 1: H2/H3 split, then delegate down the hierarchy.
function chunkNote(basename: string, content: string): Array<{ heading: string; text: string }> {
	if (content.length <= SINGLE_THRESHOLD) {
		return [{ heading: '', text: makePrefix(basename, '') + content }];
	}

	const out: Array<{ heading: string; text: string }> = [];

	for (const part of content.split(/(?=\n#{2,3} )/)) {
		const body = part.trim();
		if (!body) continue;
		const nl = body.indexOf('\n');
		const firstLine = (nl >= 0 ? body.slice(0, nl) : body).trim();
		const heading = /^#{2,3} /.test(firstLine) ? firstLine.replace(/^#+\s+/, '') : '';
		splitSection(basename, heading, body, out);
	}

	return out.length > 0
		? out
		: [{ heading: '', text: makePrefix(basename, '') + content.slice(0, CHUNK_MAX) }];
}

function cosineSim(a: number[], b: number[]): number {
	let dot = 0, na = 0, nb = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	const denom = Math.sqrt(na) * Math.sqrt(nb);
	return denom === 0 ? 0 : dot / denom;
}

export class EmbeddingStore {
	private app: App;
	private dbPath: string;
	private db: EmbeddingsDB = { version: 1, model: '', notes: {} };

	constructor(app: App, dbPath: string) {
		this.app = app;
		this.dbPath = dbPath;
	}

	async load(): Promise<void> {
		try {
			if (await this.app.vault.adapter.exists(this.dbPath)) {
				const raw = await this.app.vault.adapter.read(this.dbPath);
				this.db = JSON.parse(raw);
			}
		} catch {
			this.db = { version: 1, model: '', notes: {} };
		}
	}

	async save(): Promise<void> {
		await this.app.vault.adapter.write(this.dbPath, JSON.stringify(this.db));
	}

	isIndexed(): boolean {
		return Object.keys(this.db.notes).length > 0;
	}

	indexedCount(): number {
		return Object.keys(this.db.notes).length;
	}

	async index(
		files: TFile[],
		apiKey: string,
		model: string,
		onProgress: (completed: number, total: number) => void,
		baseUrl?: string,
	): Promise<void> {
		this.db.model = model;

		// Determine which files need (re-)embedding
		const toIndex: Array<{ file: TFile; content: string }> = [];
		for (const file of files) {
			const content = await this.app.vault.read(file);
			const existing = this.db.notes[file.path];
			if (!existing || existing.mtime !== file.stat.mtime)
				toIndex.push({ file, content });
		}

		// Prune entries for files no longer in the vault
		const validPaths = new Set(files.map(f => f.path));
		for (const path of Object.keys(this.db.notes))
			if (!validPaths.has(path)) delete this.db.notes[path];

		if (toIndex.length === 0) {
			onProgress(0, 0);
			return;
		}

		// Build flat list of chunk jobs
		type Job = { path: string; mtime: number; attachments: string[]; idx: number; text: string; heading: string };
		const jobs: Job[] = [];
		const noteData = new Map<string, {
			mtime: number;
			attachments: string[];
			chunks: Array<{ heading: string; text: string; embedding: number[] }>;
		}>();

		for (const { file, content } of toIndex) {
			const rawChunks = chunkNote(file.basename, content);
			const attachments = detectAttachments(content);
			noteData.set(file.path, {
				mtime: file.stat.mtime,
				attachments,
				chunks: rawChunks.map(c => ({ ...c, embedding: [] as number[] })),
			});
			rawChunks.forEach((c, idx) =>
				jobs.push({ path: file.path, mtime: file.stat.mtime, attachments, idx, text: c.text, heading: c.heading })
			);
		}

		// Track per-note chunk completion for accurate progress
		const chunkTotal = new Map<string, number>();
		const chunkDone = new Map<string, number>();
		for (const j of jobs) chunkTotal.set(j.path, (chunkTotal.get(j.path) ?? 0) + 1);

		let completedNotes = 0;

		for (let i = 0; i < jobs.length; i += BATCH_SIZE) {
			const batch = jobs.slice(i, i + BATCH_SIZE);
			const embeddings = await this.embedTexts(batch.map(j => j.text), apiKey, model, baseUrl);

			for (let k = 0; k < batch.length; k++) {
				const job = batch[k];
				noteData.get(job.path)!.chunks[job.idx].embedding = embeddings[k];
				const done = (chunkDone.get(job.path) ?? 0) + 1;
				chunkDone.set(job.path, done);
				if (done === chunkTotal.get(job.path)) completedNotes++;
			}

			onProgress(completedNotes, toIndex.length);
		}

		for (const [path, entry] of noteData)
			this.db.notes[path] = entry;

		await this.save();
	}

	async update(path: string, mtime: number, basename: string, content: string, apiKey: string, model: string, baseUrl?: string): Promise<void> {
		const rawChunks = chunkNote(basename, content);
		const attachments = detectAttachments(content);
		const embeddings = await this.embedTexts(rawChunks.map(c => c.text), apiKey, model, baseUrl);
		this.db.notes[path] = {
			mtime,
			attachments,
			chunks: rawChunks.map((c, i) => ({ heading: c.heading, text: c.text, embedding: embeddings[i] })),
		};
		await this.save();
	}

	remove(path: string): void {
		delete this.db.notes[path];
		this.save();
	}

	async search(queryText: string, apiKey: string, model: string, k: number, baseUrl?: string): Promise<ChunkHit[]> {
		const [queryVec] = await this.embedTexts([queryText], apiKey, model, baseUrl);
		const hits: ChunkHit[] = [];

		for (const [path, entry] of Object.entries(this.db.notes)) {
			for (const chunk of entry.chunks) {
				if (!chunk.embedding.length) continue;
				const score = cosineSim(queryVec, chunk.embedding);
				const text = chunk.text.replace(/^[^\n]+\n\n/, ''); // strip "basename\n\n" prefix
				hits.push({ path, score, heading: chunk.heading, text });
			}
		}

		return hits.sort((a, b) => b.score - a.score).slice(0, k);
	}

	private async embedTexts(texts: string[], apiKey: string, model: string, baseUrl?: string): Promise<number[][]> {
		const url = baseUrl
			? `${baseUrl.replace(/\/$/, '')}/embeddings`
			: 'https://api.voyageai.com/v1/embeddings';
		const resp = await requestUrl({
			url,
			method: 'POST',
			headers: {
				...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}),
				'content-type': 'application/json',
			},
			body: JSON.stringify({ input: texts, model }),
			throw: false,
		});

		if (resp.status !== 200) {
			const err = resp.json as { detail?: string; message?: string };
			throw new Error(err.detail ?? err.message ?? `Voyage API error ${resp.status}`);
		}

		const data = resp.json as { data: Array<{ embedding: number[]; index: number }> };
		return data.data.sort((a, b) => a.index - b.index).map(d => d.embedding);
	}
}
