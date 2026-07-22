# MERCENAI Vault Sync

MERCENAI Vault Sync connects an Obsidian vault to a MERCENAI knowledge base. It reads Markdown notes through Obsidian's official Vault API and synchronizes them after the connection is started from the MERCENAI dashboard.

## Requirements

- Obsidian 1.11.4 or newer
- An active MERCENAI account
- An internet connection

## Install

Once the plugin is approved in the Obsidian Community Plugins directory:

1. Open **Settings** in Obsidian.
2. Select **Community plugins**, then **Browse**.
3. Search for **MERCENAI Vault Sync** and select **Install**.
4. Select **Enable**.

## Connect a vault

1. Open **Knowledge** in the MERCENAI dashboard.
2. Select the knowledge base that should receive the vault notes.
3. Select **Connect Obsidian**.
4. Allow the browser to open Obsidian.

The plugin synchronizes immediately, then synchronizes again when a Markdown note is created, modified, renamed, or deleted.

## Data and privacy

- Only non-empty Markdown files returned by Obsidian's Vault API are synchronized.
- The plugin sends each note's vault-relative path and Markdown content to the MERCENAI sync endpoint selected by the dashboard connection.
- The connection token is stored with Obsidian SecretStorage. It is not stored in the plugin's `data.json` file.
- The plugin does not modify vault files, read hidden files, or collect telemetry.
- A synchronization is rejected when a vault contains more than 300 Markdown notes. Each synchronized note is limited to 200,000 characters.

## Development

```bash
npm ci
npm run typecheck
npm run build
```

The production bundle is written to `main.js`.

## License

MIT
