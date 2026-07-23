import { Notice, Plugin, TFile, requestUrl } from "obsidian";

interface MercenaiSyncConnection {
  endpoint: string;
  knowledgeBaseId: string;
}

interface MercenaiPluginData {
  connection?: MercenaiSyncConnection & { token?: string };
}

const CONNECTION_TOKEN_SECRET_ID = "mercenai-vault-sync-token";
const MAX_CHARACTERS_PER_FILE = 200_000;
const MAX_FILES_PER_BATCH = 250;
const MAX_CHARACTERS_PER_BATCH = 1_500_000;
const MAX_KNOWLEDGE_CHUNKS_PER_BATCH = 550;
const SYNC_DEBOUNCE_MS = 1_200;
const SYNC_PROTOCOL_VERSION = 2;

type SyncFile = {
  path: string;
  content: string;
};

function supportedNote(file: TFile): boolean {
  return file.extension.toLowerCase() === "md";
}

function validEndpoint(value: string): string | null {
  try {
    const endpoint = new URL(value);
    const localHttp = endpoint.protocol === "http:" && ["localhost", "127.0.0.1"].includes(endpoint.hostname);
    return endpoint.protocol === "https:" || localHttp ? endpoint.toString() : null;
  } catch {
    return null;
  }
}

function createSyncId(): string {
  return crypto.randomUUID();
}

function estimatedKnowledgeChunks(content: string): number {
  const cleaned = content
    .replace(/\u0000/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
  if (!cleaned) return 0;

  const sectionWordCounts: number[] = [];
  let wordCount = 0;
  const flush = () => {
    if (wordCount > 0) sectionWordCounts.push(wordCount);
    wordCount = 0;
  };

  for (const rawLine of cleaned.split("\n")) {
    const line = rawLine.trim();
    if (/^#{1,6}\s+(.+)$/.test(line)) {
      flush();
      continue;
    }
    if (!line) {
      if (wordCount >= 90) flush();
      continue;
    }
    wordCount += line.split(/\s+/).filter(Boolean).length;
  }
  flush();

  return Math.min(2_000, sectionWordCounts.reduce((total, words) => {
    return total + (words <= 180 ? 1 : 1 + Math.ceil((words - 180) / 150));
  }, 0));
}

function buildSyncBatches(files: SyncFile[]): SyncFile[][] {
  const batches: SyncFile[][] = [];
  let batch: SyncFile[] = [];
  let batchCharacters = 0;
  let batchChunks = 0;

  for (const file of files) {
    const fileChunks = estimatedKnowledgeChunks(file.content);
    if (
      batch.length > 0 &&
      (
        batch.length >= MAX_FILES_PER_BATCH ||
        batchCharacters + file.content.length > MAX_CHARACTERS_PER_BATCH ||
        batchChunks + fileChunks > MAX_KNOWLEDGE_CHUNKS_PER_BATCH
      )
    ) {
      batches.push(batch);
      batch = [];
      batchCharacters = 0;
      batchChunks = 0;
    }
    batch.push(file);
    batchCharacters += file.content.length;
    batchChunks += fileChunks;
  }

  if (batch.length > 0 || batches.length === 0) batches.push(batch);
  return batches;
}

export default class MercenaiVaultSyncPlugin extends Plugin {
  private connection: MercenaiSyncConnection | null = null;
  private syncTimer: number | null = null;
  private syncInFlight = false;
  private syncQueued = false;

  async onload(): Promise<void> {
    const data = (await this.loadData()) as MercenaiPluginData | null;
    const storedConnection = data?.connection;
    const storedEndpoint = validEndpoint(storedConnection?.endpoint || "");
    if (storedConnection && storedEndpoint && storedConnection.knowledgeBaseId?.trim()) {
      this.connection = {
        endpoint: storedEndpoint,
        knowledgeBaseId: storedConnection.knowledgeBaseId.trim()
      };
      const legacyToken = storedConnection.token?.trim();
      if (legacyToken) {
        this.app.secretStorage.setSecret(CONNECTION_TOKEN_SECRET_ID, legacyToken);
        await this.saveData({ connection: this.connection } satisfies MercenaiPluginData);
      }
    }

    this.registerObsidianProtocolHandler("mercenai-sync", async (parameters) => {
      const endpoint = validEndpoint(parameters.endpoint || "");
      const token = (parameters.token || "").trim();
      const knowledgeBaseId = (parameters.knowledgeBaseId || "").trim();
      if (!endpoint || !token || !knowledgeBaseId) {
        new Notice("MERCENAI could not validate this Obsidian connection.");
        return;
      }

      this.app.secretStorage.setSecret(CONNECTION_TOKEN_SECRET_ID, token);
      this.connection = { endpoint, knowledgeBaseId };
      await this.saveData({ connection: this.connection } satisfies MercenaiPluginData);
      new Notice("MERCENAI connected. Synchronizing this vault now.");
      await this.synchronizeVault(true);
    });

    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(this.app.vault.on("create", (file) => {
        if (file instanceof TFile && supportedNote(file)) this.queueSync();
      }));
      this.registerEvent(this.app.vault.on("modify", (file) => {
        if (file instanceof TFile && supportedNote(file)) this.queueSync();
      }));
      this.registerEvent(this.app.vault.on("rename", (file) => {
        if (file instanceof TFile && supportedNote(file)) this.queueSync();
      }));
      this.registerEvent(this.app.vault.on("delete", (file) => {
        if (file instanceof TFile && supportedNote(file)) this.queueSync();
      }));

      if (this.connection) this.queueSync();
    });
  }

  onunload(): void {
    if (this.syncTimer !== null) window.clearTimeout(this.syncTimer);
  }

  private queueSync(): void {
    if (!this.connection) return;
    if (this.syncTimer !== null) window.clearTimeout(this.syncTimer);
    this.syncTimer = window.setTimeout(() => {
      this.syncTimer = null;
      void this.synchronizeVault(false);
    }, SYNC_DEBOUNCE_MS);
  }

  private async synchronizeVault(showSuccess: boolean): Promise<void> {
    if (!this.connection) return;
    if (this.syncInFlight) {
      this.syncQueued = true;
      return;
    }

    this.syncInFlight = true;
    try {
      const token = this.app.secretStorage.getSecret(CONNECTION_TOKEN_SECRET_ID)?.trim();
      if (!token) {
        throw new Error("MERCENAI connection is missing. Reconnect this vault from the MERCENAI dashboard.");
      }
      const capabilityUrl = new URL(this.connection.endpoint);
      capabilityUrl.searchParams.set("capability", "batched-vault-sync");
      capabilityUrl.searchParams.set("knowledgeBaseId", this.connection.knowledgeBaseId);
      const capabilityResponse = await requestUrl({
        url: capabilityUrl.toString(),
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        throw: false
      });
      const capability = capabilityResponse.json as { syncProtocol?: number } | undefined;
      if (capabilityResponse.status < 200 || capabilityResponse.status >= 300 || capability?.syncProtocol !== SYNC_PROTOCOL_VERSION) {
        throw new Error("MERCENAI vault sync is not ready on this server yet. No notes were synchronized.");
      }
      const noteFiles = this.app.vault.getMarkdownFiles().filter(supportedNote);
      const files = (
        await Promise.all(noteFiles.map(async (file) => ({
          path: file.path,
          content: (await this.app.vault.cachedRead(file)).trim().slice(0, MAX_CHARACTERS_PER_FILE)
        })))
      ).filter((file) => file.content.length > 0);
      const batches = buildSyncBatches(files);
      const retainedPaths = files.map((file) => file.path);
      const syncId = createSyncId();

      for (const [batchIndex, batch] of batches.entries()) {
        const finalBatch = batchIndex === batches.length - 1;
        const response = await requestUrl({
          url: this.connection.endpoint,
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            knowledgeBaseId: this.connection.knowledgeBaseId,
            manifestComplete: true,
            syncId,
            batchIndex,
            batchCount: batches.length,
            finalBatch,
            ...(finalBatch ? { retainedPaths } : {}),
            files: batch
          }),
          throw: false
        });
        const payload = response.json as { message?: string } | undefined;
        if (response.status < 200 || response.status >= 300) {
          throw new Error(payload?.message || `MERCENAI sync failed with status ${response.status}.`);
        }
      }
      if (showSuccess) {
        new Notice(`${files.length.toLocaleString()} Obsidian note${files.length === 1 ? "" : "s"} synchronized.`);
      }
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "MERCENAI vault sync failed.");
    } finally {
      this.syncInFlight = false;
      if (this.syncQueued) {
        this.syncQueued = false;
        this.queueSync();
      }
    }
  }
}
