<div align="center">

# ViniPlay

**A powerful, self-hosted IPTV player with a modern web interface.**

Stream M3U playlists or Xtream Codes sources with EPG data, manage users, cast to your TV, and watch multiple channels at once.

Join my <a href="https://discord.gg/DXxvAw22Us">discord</a> to talk with the community.
<p>
    <img src="https://img.shields.io/badge/docker-ready-blue.svg?style=for-the-badge&logo=docker" alt="Docker Ready">
    <img src="https://img.shields.io/badge/platform-node-green.svg?style=for-the-badge&logo=node.js" alt="Node.js Backend">
</p>

</div>

---

ViniPlay turns your M3U playlists or Xtream Codes sources, together with their EPG data, into a polished, high-performance streaming experience. It runs in a Docker container with a Node.js backend that proxies or transcodes streams with FFmpeg, and a responsive vanilla JavaScript frontend.

The server-side backend resolves common CORS and browser compatibility issues by proxying or transcoding streams with FFmpeg, while the feature-rich frontend provides a user experience comparable to premium IPTV services.

### Main User Interface Flow
![Main User Interface Flow](images/viniplay-main%20ux-min.gif)

### Feature Snapshots

| TV Guide Page | Multi-View Page | Direct Player |
| :---: | :---: | :---: |
| ![TV Guide page](https://i.imgur.com/O7jk6X1.png) | ![Multi-View page](https://i.imgur.com/eE3R0Hr.png) <br> [View Animation](images/multiview.gif) | ![Direct player](https://i.imgur.com/ftmxvss.png) |

| DVR & Recording | Admin Activity Monitoring | Push Notifications |
| :---: | :---: | :---: |
| ![DVR](https://i.imgur.com/XVhT1pH.png) <br> [View Animation](images/DVR.gif) | ![Admin activity](https://i.imgur.com/4zaFF1v.png) | ![Notification](https://i.imgur.com/D4hFLoI.png) <br> [View Animation](images/notification.gif) |

| Powerful Settings | Responsive Mobile View | Favorite Manager |
| :---: | :---: | :---: |
| ![Settings](https://i.imgur.com/FxOFq88.png) | ![Mobile TV Guide view](https://i.imgur.com/j8LjxSf.png) | ![Favorite manager](https://i.imgur.com/kKCnkFg.png) <br> [View Animation](images/Favorites.gif) |


---

## ✨ Features

 - 👤 **Multi-User Management**: Secure the application with an admin account. Create, edit and manage standard user accounts, including DVR access and per-source/group restrictions.
 - 🏠 **Home**: Recently watched channels, favorites, reminders and upcoming recordings.
 - 📺 **Modern TV Guide**: A high-performance, virtualized EPG grid that handles thousands of channels and programs smoothly. Features include advanced search, channel favoriting, and a "Recents" category.
 - 🖼️ **Multi-View**: Drag, drop, and resize players on a grid to watch multiple streams simultaneously. Save and load custom layouts. "Immersive view" will hide all UI elements and only leave the players on the page to maximize the watching experience.
 - 🛜 **Chromecast Support**: Cast your streams directly to any Google Cast-enabled device on your network. The Cast device must be able to reach ViniPlay; use a cast profile when the source needs transcoding.
 - 🔔 **Push Notifications**: Set reminders for upcoming programs and receive push notifications in your browser. Browser push requires HTTPS or localhost; VAPID keys are generated automatically in `/data/vapid.json`.
 - ⚙️ **Powerful Transcoding - even with GPUs**: The backend uses FFmpeg to process streams, ensuring compatibility across modern browsers and devices. Create custom stream profiles to tailor transcoding settings. GPU transcoding is supported with NVIDIA NVENC, Intel QSV and VA-API (Intel and AMD/Radeon), and the matching profiles are detected automatically.
 - 📂 **Flexible Source Management**: Add M3U and EPG sources from remote URLs, Xtream Codes logins or uploaded files. Set automatic refresh intervals, and refresh a single source without re-downloading the others.
 - 🧭 **EPG matching and manual fixes**: Channels get guide data from a manual override, then `tvg-id`, then a normalized name ("US: ESPN2 HD" finds "ESPN 2"). In **Settings → Channel EPG**, admins can see channels with no guide data, review suggested matches, accept all Exact/Likely/AI picks at once, and leave Guesses for individual review. An optional OpenRouter model can settle the hard ones.
 - 🚀 **High Performance UI**: The frontend uses UI virtualization for the guide and efficient state management to keep the interface fast and responsive.
 - 🐳 **Dockerized Deployment**: The entire application is packaged in a single Docker container for simple deployment with Docker or Docker Compose.
 - ▶️ **Picture-in-Picture**: Pop out the player to keep watching while you work on other things.
 - 🎥 **DVR**: Record programs using FFmpeg. Schedule from the TV Guide, the DVR page, or the record button in the player. Set pre/post padding, a global concurrent-recording limit, a free-disk reserve and optional size-based retention. Create a **series recording** rule for a programme title to schedule every upcoming match on that channel. Watch an in-progress recording with live DVR chase play; completed `.ts` recordings are remuxed to MP4 on first play so the browser can seek in them. Completed recordings are private to their owner; admins can see all of them.
 - ⏪ **Live rewind**: When enabled in Settings → Playback & Downloads, ViniPlay keeps a shared rolling HLS buffer for each tuned channel so live TV can be paused, rewound and returned to live. It is off by default because it uses one upstream connection and disk per channel.
 - ⬇️ **Downloads**: Download a finished recording, movie or episode, or queue a whole season with **Download Season**. VOD downloads go through the server so the configured User-Agent and source permissions are respected.
 - 🔊 **Audio tracks**: For HTTP transcoded live streams, the player can probe the provider for alternate audio tracks and restart FFmpeg with the chosen one. Native/direct playback continues to use the browser's own audio-track list.
 - 📽️ **Direct player**: Play a direct stream URL (`.m3u8`, `.ts`, `.mp4`, `.mkv`, etc.) in the browser or through the server, with recent links and a debug console.
 - 👥 **Admin monitoring page**: Monitor users watching in real time, browse watch history, change a user's channel, check system health and broadcast messages to all users.
 - 📺 **On Demand (VOD)**: Browse Movies and Series from active XC providers in a scalable, filterable grid with search and pagination. VOD requires an XC source.

---

## 🚀 Getting Started

ViniPlay is designed for easy deployment using Docker.

### Prerequisites

-   Docker
-   Docker Compose (Recommended)
-   Node.js 18+ and npm only if you want to run the tests or rebuild the Tailwind CSS locally

### Method 1: Using Docker Compose (Recommended)

1.  **Create Project Files:** Create a directory for your ViniPlay setup and add a `docker-compose.yml` and a `.env` file. If you cloned the repository, copy the example first: `cp .env.example .env`.

    -   `docker-compose.yml`:

        ```yaml
        services:
          viniplay:
            image: ghcr.io/mynameiscfed/viniplay:latest
            container_name: viniplay
            ports:
              - "8998:8998"
            restart: unless-stopped
            volumes:
              - ./viniplay-data:/data
              - ./viniplay-dvr:/dvr
            env_file:
              - ./.env
        ```

    -   `.env` (copy `.env.example` and edit):

        ```dotenv
        # Replace this with a long, random, and secret string
        # e.g. generate one with: openssl rand -hex 32
        SESSION_SECRET=replace_this_with_a_very_long_random_and_secret_string

        # Contact address used by browser push services (must start with mailto:)
        VAPID_CONTACT_EMAIL=mailto:you@example.com

        # Optional: match the owner of your host data/DVR folders
        # PUID=1000
        # PGID=1000
        ```

        > **Security Note:** `SESSION_SECRET` signs session cookies, so use a long random value (for example from `openssl rand -hex 32`). If it is missing, too short, or still the example placeholder, ViniPlay generates a random secret and stores it in `/data/session-secret` (mode `0600`). Keep `.env` out of version control; it is ignored by git.

2.  **Start the Container:**

    ```bash
    docker compose up -d
    ```

    To build the image from source instead of pulling the prebuilt one, replace `image:` with `build: .` and run `docker compose up -d --build`.

    > If you use the repository's `docker-compose.yml` directly, note that it reserves one NVIDIA GPU by default. Remove its `deploy` block if you do not have the NVIDIA Container Toolkit; see [Hardware transcoding](#hardware-transcoding).

### Method 2: Using `docker` (build from source)

1.  **Build the Image:**

    ```bash
    docker build -t viniplay .
    ```

2.  **Run the Container:** Create the data and DVR directories and a `.env` file first (`cp .env.example .env`, then edit it). Then run the container:

    ```bash
    mkdir -p viniplay-data viniplay-dvr

    docker run -d \
      -p 8998:8998 \
      --name viniplay \
      --restart unless-stopped \
      --env-file ./.env \
      -v "$(pwd)/viniplay-data":/data \
      -v "$(pwd)/viniplay-dvr":/dvr \
      viniplay
    ```

### Prebuilt Image (CI/CD)

Pushes to `main` are tested, built and published by GitHub Actions (`.github/workflows/docker-image.yml`) to the GitHub Container Registry as a multi-architecture (`amd64` + `arm64`) image:

```bash
docker pull ghcr.io/mynameiscfed/viniplay:latest
```

Available tags: `latest` (the default branch), `main` (main branch builds), `sha-<short commit>`, and `1.2.3` / `1.2` when a `v1.2.3` git tag is pushed. Manual runs also publish a tag for the branch. Pull requests are built and tested but not published.

To run the same checks locally after `npm ci`: `npm test` (syntax checks plus unit tests) and `npm run test:container -- <image>` (boots the image and checks that it serves the app and contains `ffmpeg`/`ffprobe`).

### First-Time Setup

Once the container is running, open `http://localhost:8998` (replace `localhost` with the host name or IP if ViniPlay runs elsewhere). You will be prompted to create your initial **admin account**. Passwords must be at least 12 characters, and repeated failed logins from one address are temporarily blocked. After creating the admin account, you can log in and start configuring your sources in the **Settings** tab.

---

## 🛠️ Deployment Notes

### Running as a non-root user

The container drops root privileges at startup and runs ViniPlay (and every FFmpeg process it starts) as an unprivileged `viniplay` user, UID/GID `1000` by default. On startup it hands ownership of `/data` and `/dvr` to that user, so existing installs that were written as root keep working.

To match the owner of your host folders, set `PUID` and `PGID` in your `.env` file (for example `PUID=1001` and `PGID=1001`). If you map `/dev/dri` for Intel QSV / VA-API, the user is added to the group that owns the render device automatically. Setting `PUID=0` restores the old run-as-root behaviour, which is not recommended.

### Hardware transcoding

The image ships Jellyfin's FFmpeg build and the VA-API drivers, and detects available GPUs at runtime. The matching stream, recording and cast profiles then appear in Settings.

-   **NVIDIA:** install the NVIDIA Container Toolkit, then run with `--gpus all` (Docker) or the `deploy.resources.reservations.devices` block (Compose). The repository's compose file requests one NVIDIA GPU by default; remove that block if you do not have one, or `docker compose up` will fail.
-   **Intel QSV / VA-API (Intel and AMD):** pass the render device into the container, either with `--device /dev/dri:/dev/dri` or with a Compose `devices:` entry. The entrypoint adds the app user to the group that owns the device.

Select the generated profile in **Settings → Player Settings**, **DVR Settings** or **Chromecast Settings**.

### URL fetching and SSRF protection

ViniPlay checks client-supplied URLs before use. The image proxy (VOD posters and logos), the player `/stream` proxy, VOD duration probing, VOD downloads, audio-track probing and the source editor's **Test** button refuse loopback, link-local/cloud metadata and private LAN addresses such as `192.168.x.x`, re-checking every redirect. If your posters or sources live on your own network, add one of these to `.env`:

-   `SSRF_ALLOW_PRIVATE_NETWORKS=true` allows private LAN ranges (loopback and metadata addresses stay blocked).
-   `SSRF_ALLOWED_HOSTS=dispatcharr.lan,192.168.1.20` exempts specific hosts.

Private LAN sources need one of these settings for server-side playback, VOD probing and VOD downloads. Localhost names, loopback, link-local and cloud metadata IP literals remain blocked. If the media server runs on the same host as ViniPlay, expose it on a LAN address/hostname rather than `localhost`.

### Reverse proxies and `TRUST_PROXY`

ViniPlay ignores `X-Forwarded-For` unless you set `TRUST_PROXY` (same values as Express's `trust proxy`, e.g. `TRUST_PROXY=1` for one proxy hop). Without it, requests carrying a forwarded header are never treated as local-network for the unauthenticated `/stream` access used by Chromecast. Set it if you run behind Nginx, Traefik, or Cloudflare and want the real client IP in logs and local-network detection to keep working.

### Database notes

ViniPlay keeps users, sessions, DVR jobs, stream history, watch progress and the VOD catalogue in SQLite (`/data/viniplay.db`). The same directory also holds `settings.json`, the generated session secret, the downloaded sources, EPG caches, generated VAPID keys, the OpenRouter key and the image cache; DVR recordings live under `/dvr`.

The database runs in WAL mode, which makes writes much cheaper and lets reads proceed while a write is in progress. WAL keeps recent changes in two extra files next to the database, `viniplay.db-wal` and `viniplay.db-shm`. For a reliable backup, stop the container and copy `/data` and `/dvr`. If you copy while it runs, copy `viniplay.db`, `viniplay.db-wal` and `viniplay.db-shm` together.

WAL does not work reliably when `/data` is on a network share (NFS/SMB). In that case add `SQLITE_JOURNAL_MODE=DELETE` to `.env` to keep the classic rollback journal. Accepted values are `WAL` (default), `DELETE`, `TRUNCATE` and `PERSIST`.

Foreign keys are enforced, so deleting a user also removes their DVR jobs, notifications, push subscriptions, Multi-View layouts, watch progress and per-user settings. If something on your install relies on the old behaviour, set `SQLITE_FOREIGN_KEYS=off`. Stream history older than 90 days and notifications older than 30 days are deleted nightly; set `STREAM_HISTORY_RETENTION_DAYS` to change the first (`0` keeps it forever).

---

## 🔧 Configuration

Most day-to-day configuration is done in the web interface under **Settings**. Deployment-level options (`SESSION_SECRET`, `PUID`/`PGID`, `VAPID_CONTACT_EMAIL`, SSRF, SQLite and `TRUST_PROXY`) are environment variables described above.

-   **Guide Data Sources:** Add, edit and enable M3U and EPG sources from remote URLs, Xtream Codes logins or uploaded files.
-   **Processing:** A new active source is downloaded and merged as soon as you add it. Use the refresh button on a source's row to refresh just that source, or **Process Sources & View Guide** to download, parse and merge all active sources.
-   **Channel EPG (Admin):** A virtualized list of channels, filterable by status (including **Has a suggestion**), source and group, so large guides stay fast. **Suggest matches** proposes guide channels by name and labels them Exact, Likely, AI pick or Guess. **Accept all** permanently assigns the Exact, Likely and AI picks after a confirmation; Guesses (close ties, wrong time-shifts and AI disagreements) stay for manual review. Select rows to bulk accept or dismiss suggestions, or remove assignments; the pencil assigns a guide channel by hand, and a manual choice always wins over automatic matching. **Process Sources** builds the guide-channel list.
-   **AI Matching (Admin):** Tick **Also ask AI** in Channel EPG to send doubtful channels to a small model on [OpenRouter](https://openrouter.ai). Save your API key and pick a model (the list comes from OpenRouter, with prices) here, and use **Save & test** to check them with a real request. The key is stored in `/data/openrouter.json` and is never sent back in full; the UI only shows whether a key is saved and at most its last four characters. Requests contain the channel name, its group, and the candidate guide-channel ids and names; no stream URLs or credentials are sent. The model can only choose among matches ViniPlay already found.
-   **Player Settings:** Manage User-Agent strings, define FFmpeg stream profiles and choose an optional fallback profile tried once when the active profile keeps failing.
-   **Playback & Downloads (Admin):** Turn downloads on or off, limit concurrent VOD downloads, and enable live TV rewind with a 5–60 minute window and a per-channel disk cap. Keep rewind off if the provider only allows one connection or the `/dvr` volume is small.
-   **DVR Settings and Storage Management:** Choose the recording profile, pre/post buffers, the global simultaneous-recording limit, a free-disk reserve, a maximum recording length, size-based retention and how many days to keep old recordings.
-   **Chromecast Settings:** Choose the FFmpeg profile used when casting.
-   **App Settings, Log Management and Danger Zone:** EPG timezone correction, guide search scope, notification lead time, server logs, settings export/import and a full data reset.
-   **User Management (Admin):** Admins can create, edit and delete user accounts, grant DVR access and restrict which sources and groups each user can see. New passwords must be at least 12 characters; changing that user's password or deleting the account also ends their open sessions.

---

## 🏗️ Project Structure

The project is organized into a Node.js backend and a modular vanilla JavaScript frontend.

```
/
├── public/                          # Frontend static files
│   ├── js/
│   │   ├── main.js                  # Main application entry point
│   │   └── modules/                 # Modular JS components for each feature
│   │       ├── admin.js             # Admin activity, watch history and broadcasts
│   │       ├── api.js               # Backend API communication
│   │       ├── auth.js              # Login, logout and first-run setup
│   │       ├── cast.js              # Google Cast logic
│   │       ├── codecs.js            # Codec name labels
│   │       ├── dvr.js               # DVR page and timeshift playback
│   │       ├── epgai.js             # Settings > AI Matching
│   │       ├── epgmap.js            # Settings > Channel EPG
│   │       ├── focus.js             # Keyboard and remote-control navigation
│   │       ├── guide.js             # TV Guide logic and rendering
│   │       ├── home.js              # Home page
│   │       ├── icons.js             # SVG icon set
│   │       ├── multiview.js         # Multi-View grid and players
│   │       ├── notification.js      # Reminders and push notifications
│   │       ├── osd.js               # Player now/next card and channel list
│   │       ├── palette.js           # Search palette (press /)
│   │       ├── player.js            # Shared video player (mpegts.js and HLS.js)
│   │       ├── player_direct.js     # Direct player and recent links
│   │       ├── settings.js          # Settings page logic
│   │       ├── state.js             # Shared application state
│   │       ├── telemetry.js         # Client log telemetry
│   │       ├── ui.js                # Navigation, modals and global UI helpers
│   │       ├── utils.js             # Parsers and utility functions
│   │       └── vod.js               # On Demand page
│   ├── css/                         # Design tokens, component styles and the built Tailwind file
│   ├── sw.js                        # Service Worker for push notifications
│   └── index.html                   # Main HTML file
│
├── src/tailwind.css                 # Tailwind source file
├── server.js                        # Express app, API and stream/DVR orchestration
├── loginRateLimit.js                # In-memory login throttling
├── dbConfig.js                      # SQLite tuning and indexes
├── epgMatch.js                      # Channel-to-guide name matching
├── epgSuggest.js                    # Persisted suggestions and background matching
├── epgLlm.js                        # OpenRouter calls for AI matching
├── epgStream.js                     # Streaming XMLTV parser
├── epgPayload.js                    # Cached, permission-filtered EPG responses
├── vodProcessor.js                  # XC VOD catalogue refresh
├── vodStore.js                      # VOD database access
├── xtreamClient.js                  # Xtream Codes API client
├── ssrfGuard.js                     # SSRF protection for proxied URLs
├── test/                            # Node test suite and container smoke test
├── Dockerfile                       # Docker build instructions
├── docker-entrypoint.sh             # Volume permissions and privilege drop
├── docker-compose.yml               # Docker Compose configuration
├── package.json                     # Node.js dependencies and scripts
└── .env.example                     # Environment variables template (copy to .env)

```

### Styling

The look is called Signal Ink: colors, fonts and sizes live in `public/css/tokens.css` (dark by default, following the OS light/dark preference unless the user picks a theme), the component styles are the other files in `public/css/`, and `public/css/tailwind.css` is the prebuilt Tailwind file. After you add or change Tailwind classes in `public/index.html` or `public/js/`, run `npm run build:css` and commit the result.

On a TV the interface switches to a larger layout with a visible focus ring and remote-friendly navigation (arrows, OK, Back, number keys, CH +/-). It turns on by itself for TV browsers, or you can pick Auto, On or Off in the account menu. Press `?` anywhere to see the shortcuts.

---

## 🗺️ Roadmap

Upcoming features and fixes include:

-   On Demand support for M3U playlists and uploaded files (currently XC sources only).
-   Cache channel logos locally to speed up guide loads.

---

## ⚖️ License

ViniPlay is licensed under **CC BY-NC-SA 4.0**:

- **BY**: Give credit where credit is due.
- **NC**: No commercial use.
- **SA**: Share alike if you remix.

For full license details, see the [CC BY-NC-SA 4.0 license](https://creativecommons.org/licenses/by-nc-sa/4.0/).
