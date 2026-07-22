import { Notice, Plugin, TFile, requestUrl } from "obsidian";

interface MercenaiSyncConnection {
  endpoint: string;
  knowledgeBaseId: string;
}

interface MercenaiPluginData {
  connection?: MercenaiSyncConnection & { token?: string };
}

const CONNECTION_TOKEN_SECRET_ID = "mercenai-vault-sync-token";
const MAX_FILES = 300;
const MAX_CHARACTERS_PER_FILE = 200_000;
const SYNC_DEBOUNCE_MS = 1_200;

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
      const noteFiles = this.app.vault.getMarkdownFiles().filter(supportedNote);
      if (noteFiles.length > MAX_FILES) {
        throw new Error(`This vault has more than ${MAX_FILES} Markdown notes. Nothing was synchronized.`);
      }
      const files = (
        await Promise.all(noteFiles.map(async (file) => ({
          path: file.path,
          content: (await this.app.vault.cachedRead(file)).trim().slice(0, MAX_CHARACTERS_PER_FILE)
        })))
      ).filter((file) => file.content.length > 0);
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
          files
        }),
        throw: false
      });
      const payload = response.json as { message?: string } | undefined;
      if (response.status < 200 || response.status >= 300) {
        throw new Error(payload?.message || `MERCENAI sync failed with status ${response.status}.`);
      }
      if (showSuccess) new Notice(payload?.message || "MERCENAI vault sync complete.");
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
