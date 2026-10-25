<div align="center">

# ViniPlay

**A powerful, self-hosted IPTV player with a modern web interface.**

Stream your M3U playlists with EPG data, manage users, cast to your TV, and watch multiple channels at once.

Join my <a href="https://discord.gg/DXxvAw22Us">discord</a> to talk with the community.
<p>
    <img src="https://img.shields.io/badge/docker-ready-blue.svg?style=for-the-badge&logo=docker" alt="Docker Ready">
    <img src="https://img.shields.io/badge/platform-node-green.svg?style=for-the-badge&logo=node.js" alt="Node.js Backend">
</p>

</div>

---

ViniPlay transforms your M3U and EPG files into a polished, high-performance streaming experience. It's a full-featured IPTV solution that runs in a Docker container, providing a robust Node.js backend to handle streams and a sleek, responsive frontend for an exceptional user experience.

The server-side backend resolves common CORS and browser compatibility issues by proxying or transcoding streams with FFMPEG, while the feature-rich frontend provides a user experience comparable to premium IPTV services.

### Main User Interface Flow
![Main User Interface Flow](https://github.com/ardoviniandrea/ViniPlay/blob/main/images/viniplay-main%20ux-min.gif)

### Feature Snapshots

| TV Guide Page | Multi-View Page | Direct Player |
| :---: | :---: | :---: |
| ![TV Guide page](https://i.imgur.com/O7jk6X1.png) | ![Multi-View page](https://i.imgur.com/eE3R0Hr.png) <br> [View Animation](https://github.com/ardoviniandrea/ViniPlay/blob/main/images/multiview.gif) | ![Direct player](https://i.imgur.com/ftmxvss.png) |

| DVR & Recording | Admin Activity Monitoring | Push Notifications |
| :---: | :---: | :---: |
| ![DVR](https://i.imgur.com/XVhT1pH.png) <br> [View Animation](https://github.com/ardoviniandrea/ViniPlay/blob/main/images/DVR.gif) | ![Admin activity](https://i.imgur.com/4zaFF1v.png) | ![Notification](https://i.imgur.com/D4hFLoI.png) <br> [View Animation](https://github.com/ardoviniandrea/ViniPlay/blob/main/images/notification.gif) |

| Powerful Settings | Responsive Mobile View | Favorite Manager |
| :---: | :---: | :---: |
| ![Settings](https://i.imgur.com/FxOFq88.png) | ![Mobile TV Guide view](https://i.imgur.com/j8LjxSf.png) | ![Favorite manager](https://i.imgur.com/kKCnkFg.png) <br> [View Animation](https://github.com/ardoviniandrea/ViniPlay/blob/main/images/Favorites.gif) |


---

## ✨ Features

 - 👤 **Multi-User Management**: Secure the application with a dedicated admin account. Create, edit, and manage standard user accounts.
 - 📺 **Modern TV Guide**: A high-performance, virtualized EPG grid that handles thousands of channels and programs smoothly. Features include advanced search, channel favoriting, and a "Recents" category.
 - 🖼️ **Multi-View**: Drag, drop, and resize players on a grid to watch multiple streams simultaneously. Save and load custom layouts. "Immersive view" will hide all UI elements and only leave the players on the page to maximize the watching experience.
 - 🛜 **Chromecast Support**: Cast your streams directly to any Google Cast-enabled device on your network. (This will only work if your source signal is strong and correctly passed without package missing, due to Cast framework)
 - 🔔 **Push Notifications**: Set reminders for upcoming programs and receive push notifications in your browser, even when the app is closed.
 - ⚙️ **Powerful Transcoding - even with GPUs**: The backend uses FFMPEG to process streams, ensuring compatibility across all modern browsers and devices. Create custom stream profiles to tailor transcoding settings. GPU transcoding supported. (Nvidia, InterlQSV and Vaapi)
 - 📂 **Flexible Source Management**: Add M3U and EPG sources from either local files, XC code and remote URLs. Set automatic refresh intervals for URL-based sources to keep your guide data fresh.
 - 🧭 **EPG matching and manual fixes**: Channels get guide data by `tvg-id`, then by normalised name ("US: ESPN2 HD" finds "ESPN 2"). In **Settings → Channel EPG**, admins can see channels with no guide data, pick a guide channel by hand, review suggested matches, and optionally ask an AI about the hard ones.
 - 🚀 **High Performance UI**: The frontend is built with performance in mind, using UI virtualization for the guide and efficient state management to ensure a fast and responsive experience.
 - 🐳 **Dockerized Deployment**: The entire application is packaged in a single Docker container for simple, one-command deployment using Docker or Docker Compose.
 - ▶️ **Picture-in-Picture**: Pop out the player to keep watching while you work on other things.
 - 🎥 **DVR**: Record programs using FFMPEG. Schedule recording via the TV Guide, or set specific channels and time with ease.
 - 📽️ **Single player**: Play .m3u8 and .ts links directly from the browser, with detailed console logs and recorded history
 - 👥 **Admin monitoring page**: Monitor users watch stream in real time, store historical plays, and broadcast messages to all users.
 - 📺 **VODs support**: Play your VODs from your provider, divided cleanly in the UI with a scalable grid, with filters and tabs for Movies and Series (IMPORTANT: this only workd with XC API log in)
---


## 🚀 Getting Started

ViniPlay is designed for easy deployment using Docker.

### Prerequisites

-   Docker
-   Docker Compose (Recommended)
    
### Method 1: Using `docker-compose` (Recommended)

1.  **Create Project Files:** Create a directory for your ViniPlay setup and add a `docker-compose.yml` and a `.env` file. If you cloned the repository, copy the example first: `cp .env.example .env`.
    
    -   `docker-compose.yml`:
        
        ```
        version: "3.8"
        services:
          viniplay:
            image: ardovini/viniplay:latest
            container_name: viniplay
            ports:
              - "8998:8998"
            restart: unless-stopped
            volumes:
              - ./viniplay-data:/data
            env_file:
              - ./.env
        
        ```
        
    -   `.env` (copy `.env.example` and edit):
        
        ```
        # Replace this with a long, random, and secret string
        SESSION_SECRET=your_super_secret_session_key_here
        
        ```
        
        > **Security Note:** Your `SESSION_SECRET` should be a long, random string. If it is missing, too short, or still the example placeholder, ViniPlay generates a random secret and stores it in `/data/session-secret` (mode `0600`). Keep `.env` out of version control; it is ignored by git.

2.  **Build and Run the Container:**
    
    ```
    docker-compose up --build -d
    
    ```

### Running as a non-root user

The container drops root privileges at startup and runs ViniPlay (and every FFmpeg process it starts) as an unprivileged `viniplay` user, UID/GID `1000` by default. On startup it hands ownership of `/data` and `/dvr` to that user, so existing installs that were written as root keep working.

To match the owner of your host folders, set `PUID` and `PGID` in your `.env` file (for example `PUID=1001` and `PGID=1001`). If you map `/dev/dri` for Intel QSV / VA-API, the user is added to the group that owns the render device automatically. Setting `PUID=0` restores the old run-as-root behaviour, which is not recommended.

### Fetching images and validating URLs from your LAN

The image proxy (VOD posters) and the "test URL" button refuse to fetch internal addresses (loopback, link-local/cloud metadata, and private LAN ranges such as `192.168.x.x`) and only follow `http`/`https` redirects that pass the same checks. If your posters or sources live on your own network, add one of these to `.env`:

-   `SSRF_ALLOW_PRIVATE_NETWORKS=true` allows private LAN ranges (loopback and metadata addresses stay blocked).
-   `SSRF_ALLOWED_HOSTS=dispatcharr.lan,192.168.1.20` exempts specific hosts.

### Database notes

ViniPlay keeps users, sessions, DVR jobs, stream history and the VOD catalogue in SQLite (`/data/viniplay.db`). It runs in WAL mode, which makes writes much cheaper and lets reads proceed while a write is in progress. WAL keeps recent changes in two extra files next to the database, `viniplay.db-wal` and `viniplay.db-shm`, so when you back up `/data` by copying files, copy all three (or stop the container first).

WAL does not work reliably when `/data` is on a network share (NFS/SMB). In that case add `SQLITE_JOURNAL_MODE=DELETE` to `.env` to keep the classic rollback journal. Accepted values are `WAL` (default), `DELETE`, `TRUNCATE` and `PERSIST`.

Foreign keys are enforced, so deleting a user also removes their DVR jobs, notifications, push subscriptions, layouts and watch progress. If something on your install relies on the old behaviour, set `SQLITE_FOREIGN_KEYS=off`. Stream history older than 90 days and notifications older than 30 days are deleted nightly; set `STREAM_HISTORY_RETENTION_DAYS` to change the first (`0` keeps it forever).

### Method 2: Using `docker`

1.  **Build the Image:**
    
    ```
    docker build -t viniplay .
    
    ```
    
2.  **Run the Container:** Create a volume directory (`mkdir viniplay-data`) and a `.env` file first (`cp .env.example .env`, then edit it). Then run the container:
    
    ```
    docker run -d \
      -p 8998:8998 \
      --name viniplay \
      --env-file ./.env \
      -v "$(pwd)/viniplay-data":/data \
      viniplay
    
    ```
    
### Prebuilt Image (CI/CD)

Every push to `main` is tested and published by GitHub Actions (`.github/workflows/docker-image.yml`) to the GitHub Container Registry:

```
docker pull ghcr.io/mynameiscfed/viniplay:latest
```

Available tags: `latest` and `main` (latest `main`), `sha-<commit>` (a specific build), and `1.2.3` / `1.2` when a `v1.2.3` git tag is pushed. Pull requests are built and tested but not published.

To run the same checks locally: `npm test` (JavaScript syntax check) and `npm run test:container -- <image>` (boots the image and checks it responds).

### First-Time Setup

Once the container is running, open your browser and navigate to `http://localhost:8998`. You will be prompted to create your initial **admin account**. Passwords must be at least 12 characters, and repeated failed logins from one address are temporarily blocked. After creating the admin account, you can log in and start configuring your sources in the **Settings** tab.

---
## 🔧 Configuration

All configuration is done via the web interface in the **Settings** tab.

-   **Data Sources:** Add your M3U and EPG sources from remote URLs, XC Codes, uploaded files.
-   **Processing:** A new source is downloaded and merged as soon as you add it. Use the refresh button on a source's row to refresh just that source, or **Process Sources & View Guide** to download, parse, and merge all of them.
-   **Channel EPG (Admin):** Lists channels with no guide data. **Suggest matches** proposes guide channels by name; accept or dismiss each, or accept all confident ones at once. The pencil picks a guide channel by hand, and your choice always wins over automatic matching. Run **Process Sources** once after upgrading so the list of guide channels exists. Tick **Also ask AI** to put the doubtful channels to a small model on [OpenRouter](https://openrouter.ai): save your API key and pick a model (the list comes from OpenRouter, with prices) in **Settings → AI Matching**, and use **Save & test** to check them with a real request. The key is stored on the server only and never shown again. Only channel and guide-channel names are sent, and the model can only choose among matches ViniPlay already found.
-   **Player Settings:** Manage User-Agent strings and define `ffmpeg` stream profiles.
-   **User Management (Admin):** Admins can create, edit, and delete user accounts.

---
## 🏗️ Project Structure

The project is organized into a Node.js backend and a modular vanilla JavaScript frontend.

```
/
├── public/                          # Frontend static files
│   ├── js/
│   │   ├── main.js                  # Main application entry point
│   │   └── modules/                 # Modular JS components for each feature
│   │       ├── api.js               # Backend API communication
│   │       ├── auth.js              # Authentication flow
│   │       ├── cast.js              # Google Cast logic
│   │       ├── dvr.js               # DVR logic
│   │       ├── epgai.js             # Settings > AI Matching: OpenRouter key and model
│   │       ├── epgmap.js            # Settings > Channel EPG: manual and suggested EPG matches
│   │       ├── focus.js             # Keyboard and remote-control navigation
│   │       ├── guide.js             # TV Guide logic & rendering
│   │       ├── home.js              # Home page
│   │       ├── multiview.js         # Multi-View grid and players
│   │       ├── notification.js      # Push notification management
│   │       ├── osd.js               # Player now/next card and channel list
│   │       ├── palette.js           # Search (press /)
│   │       ├── player.js            # Video player (mpegts.js)
│   │       ├── settings.js          # Settings page logic
│   │       ├── state.js             # Shared application state
│   │       ├── ui.js                # Global UI functions (modals, etc.)
│   │       └── utils.js             # Utility functions (parsers)
│   ├── css/                         # Design tokens, component styles and the built Tailwind file
│   ├── sw.js                        # Service Worker for push notifications
│   └── index.html                   # Main HTML file
│
├── server.js                        # Node.js backend (Express.js)
├── Dockerfile                       # Docker build instructions
├── docker-compose.yml               # Docker Compose configuration
├── package.json                     # Node.js dependencies
└── .env.example                     # Environment variables template (copy to .env)

```

### Styling

The look is called Signal Ink: colors, fonts and sizes live in `public/css/tokens.css` (dark by default, with a light theme), the component styles are the other files in `public/css/`, and `public/css/tailwind.css` is a prebuilt Tailwind file. After you add or change Tailwind classes in `public/index.html` or `public/js/`, run `npm run build:css` and commit the result.

On a TV the interface switches to a larger layout with a visible focus ring and remote-friendly navigation (arrows, OK, Back, number keys, CH +/-). It turns on by itself for TV browsers, or you can pick Auto, On or Off in the account menu. Press `?` anywhere to see the shortcuts.

---
## 🏗️ Roadmap

Upcoming features and fixes include:

-   Add VODs support for M3U links and File uploads  
-   Making DVR .ts files seekable during recording.
-   Storing logos to improve load time.
-   Implementing full horizontal scroll in the TV Guide.

---
## ⚖️ License

ViniPlay is licensed under **CC BY-NC-SA 4.0**:

- **BY**: Give credit where credit’s due.
- **NC**: No commercial use.
- **SA**: Share alike if you remix.

For full license details, see [LICENSE](https://creativecommons.org/licenses/by-nc-sa/4.0/).

### Reverse proxies and `TRUST_PROXY`

ViniPlay ignores `X-Forwarded-For` unless you set `TRUST_PROXY` (same values as Express's `trust proxy`, e.g. `1` for one proxy hop). Without it, requests carrying a forwarded header are never treated as local-network for unauthenticated `/stream` access. Set it if you run behind Nginx, Traefik, or Cloudflare and want the real client IP in logs and local-network detection.
