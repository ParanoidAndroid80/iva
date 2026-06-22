# Changelog

## [0.1.3] - 2026-06-22

Patch: Telegram formatting, an English-first installer, low-end VPS support, and the OpenCode model fix.

- 💬 **Telegram formatting everywhere** — a single hardened markdown → Telegram-HTML converter now handles EVERY message: chat replies, nightly reports, the morning digest. Cron reports used to arrive as raw `**text**` with `---` and backticks. The converter never throws on any input and always emits valid HTML (balanced tags, escaping, rich formatting per the Telegram docs); on a Telegram rejection it self-heals without losing the message and without loops.
- 🌍 **Bilingual installer** — language is the very first question (English by default), and all of `install.sh` prints in the chosen language. The choice flows into the agent and the vault, so it's asked only once.
- 💾 **Auto-swap for low-end VPS** — on a box with <1.5 GB RAM and no swap, `eve build` was OOM-killed (exit 137, "Killed"). The installer now creates a 2 GB swapfile before building (idempotent, with a disk-space check). Iva installs even on a $4 DigitalOcean droplet (512 MB).
- 🤖 **OpenCode Go model fix** — Iva sent the model ID with the `opencode-go/` prefix and the endpoint replied "Model … is not supported". It now sends the bare ID (`deepseek-v4-pro`); existing `.env` files with the prefix are fixed automatically after `iva update`.
- 🌳 **Tree on update** — `iva update` shows the same ANSI willow as the install.

[0.1.3]: https://github.com/smixs/iva/releases/tag/v0.1.3

## [0.1.2] - 2026-06-21

Patch: reliable startup and web search.

- 🔌 **Your own port** — the server runs on a configurable `IVA_PORT` (default `8723`) instead of the commonly-taken `3000`. The bot no longer goes silent over a port conflict; old installs migrate automatically on `iva update`.
- 🔎 **Web search with a provider picker** — Tavily / Exa / Parallel / Brave, chosen at install (or `iva config`), one key per provider. DuckDuckGo was dropped — it served a captcha from server IPs.
- 🩺 **Diagnostics** — `iva doctor` checks the port and the active search key; a preflight port-availability check during setup.
- 🧹 **Green typecheck** — fixed `parse_mode` in the Telegram channel.

[0.1.2]: https://github.com/smixs/iva/releases/tag/v0.1.2

## [0.1.0] - 2026-06-20

First release. A personal AI agent with memory in Telegram, set up with a single command.

- 🎙️ Voice and video — transcribes speech in any language
- 🧠 Tree-shaped memory (day, week, month, year) — tidies itself up at night
- 🔎 Fast search over memory
- 🤖 Choice of model — which AI runs inside (OpenCode Go from $5/mo or Ollama Cloud, DeepSeek recommended)
- 🧩 Skills and connections via MCP
- 🎛️ Telegram commands: `/help` `/task` `/tasks` `/digest` `/new` `/restart`
- 🔒 Replies only to you, memory stays with you
- 🎭 Personality changes right in the conversation

[0.1.0]: https://github.com/smixs/iva/releases/tag/v0.1.0
