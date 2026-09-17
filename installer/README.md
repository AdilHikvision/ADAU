# ProjectX Installer and Operations

## 0) Versioning

The installer version is stored in `installer/VERSION.txt` (single source of truth).
`setup.iss` reads it at compile time (`AppVersion` / `VersionInfoVersion`), names the
output `ADAU-Setup-<version>.exe`, and writes `DisplayVersion` to the
Windows uninstall registry key.

**Bump the version** by editing `installer/VERSION.txt` (e.g. `1.1.0` → `1.2.0`)
before building. Use semantic `MAJOR.MINOR.PATCH`.

When the installer is launched on a machine that already has ProjectX:

- **newer version** → prompt: **Update** / **Remove** / **Exit**
  (Update keeps the existing DB + JWT config — see `-PreserveConfig`)
- **same version** → prompt: **Reinstall** / **Remove** / **Exit**
- **older version** (downgrade) → blocked; offers to **Remove** the newer one

## 1) Build artifacts

From repository root:

```powershell
powershell -ExecutionPolicy Bypass -File .\installer\build-artifacts.ps1
```

Linux artifacts (example):

```powershell
powershell -ExecutionPolicy Bypass -File .\installer\build-artifacts.ps1 -Runtime linux-x64
```

This script:

- builds frontend (`npm ci`, `npm run build`)
- copies frontend `dist` to backend `wwwroot`
- publishes backend single-file (`win-x64`, self-contained)
- copies Hikvision native SDK dependencies to publish output:
  - `win-*` runtime: `*.dll` + `HCNetSDKCom`
  - `linux-*` runtime: `*.so*` + `HCNetSDKCom`
- places output to `artifacts\installer\backend-publish`

SDK source priority for copy:

1. `HIKVISION_SDK_PATH` environment variable (if set)
2. runtime-based repository path:
   - `win-*` -> `winSDK\lib`
   - `linux-*` -> `linuxSDK\lib`

## 2) Build Windows installer

Install Inno Setup 6, then:

```powershell
powershell -ExecutionPolicy Bypass -File .\installer\build-installer.ps1
```

Output installer:

- `artifacts\installer\ADAU-Setup-<version>.exe`
  (the version comes from `VERSION.txt` — see section 0)

## 3) Install flow

Installer wizard:

1. everything is automatic by default — the user enters nothing. PostgreSQL is
   installed locally, the app DB + user are created, the DB password and the JWT
   signing key are generated automatically. The options page only offers two
   checkboxes: "Make the app available on the local network (nginx)" and
   "Use my own PostgreSQL database (advanced)". The DB connection fields (and the
   only password prompt) appear **only** when the advanced checkbox is ticked.
2. on a fresh install (and only when "use my own database" is unchecked) it
   installs PostgreSQL **natively** (no Docker) and creates the app database +
   user — see section 2a
3. copies backend payload
4. generates `appsettings.Production.json`
5. installs Windows service `ProjectXBackend`
6. starts service
7. creates tray monitor icon (`ProjectX Tray Monitor`) with quick actions
8. optionally installs the nginx LAN reverse proxy (see section 3a)
9. optionally installs Npcap (checkbox, on by default) for the SADP device
   auto-discovery PCAP channel — `install-npcap.ps1`. Optional: without it SADP
   discovery still works over UDP. The free Npcap edition does not support fully
   silent install, so its short installer window may appear during setup.

Default URL after install:

- local (Kestrel, loopback): `http://localhost:5055`
- dashboard page: `http://localhost:5055/system`
- LAN (via nginx, if enabled): `http://<server-ip>` and `http://<server-ip>/system`

The backend (Kestrel) binds to `127.0.0.1:5055` only. LAN access is provided by an
nginx reverse proxy on port 80 — see section 3a.

### 2a) Native PostgreSQL (no Docker)

`install-postgres.ps1` installs PostgreSQL **directly on the server** — there is no
Docker involved anywhere in the install path:

- if a `postgresql*` service already exists, the engine install is skipped;
- otherwise it downloads the EDB Windows installer and runs it **unattended**
  (silent, registers the native `postgresql-x64-16` service on port 5432),
  falling back to `winget` if the download fails;
- then it creates the application **role** and **database** idempotently
  (`projectx_user` / `projectx`) using the superuser password, so the backend can
  connect immediately.

Run / re-run manually:

```powershell
powershell -ExecutionPolicy Bypass -File .\installer\install-postgres.ps1 `
  -DbName projectx -DbUser projectx_user -DbPassword "<app-pw>" `
  -SuperPassword "<postgres-pw>" -DbPort 5432
```

Override the PostgreSQL version/installer with `-Version 17` or
`-InstallerUrl <url>` (or the `POSTGRES_INSTALLER_URL` env var). Avoid `'` in
passwords.

> Note: `backend/docker-compose.yml` is a **development-only** convenience and is
> not used by the installer.

Tray monitor behavior:

- shows server state in Windows tray tooltip
- left click opens local service manager page
- context menu: `Start Server`, `Stop Server`, `Restart Server`, `Open Service Manager`

## 3a) LAN access via nginx

The backend listens on loopback only (`http://127.0.0.1:5055`). To make the app
reachable from other machines on the local network, an nginx reverse proxy is put
in front on port 80.

The installer wizard offers an **"Enable LAN access via nginx on port 80"** checkbox
(Security page, on by default). When checked, the installer runs `install-nginx.ps1`,
which:

- downloads nginx (Windows) + `nssm` (service wrapper) — needs internet on first run
- renders `nginx\projectx-nginx.conf` (substituting listen/backend ports) into
  `<install>\conf\nginx.conf`
- validates the config (`nginx -t`)
- registers the **`ProjectXNginx`** Windows service (auto-start)
- opens the Windows Firewall for inbound TCP 80
- starts the service

After install the app is reachable at `http://<server-ip>` from the LAN.

Run / re-run manually:

```powershell
powershell -ExecutionPolicy Bypass -File .\installer\install-nginx.ps1 `
  -BackendPort 5055 -ListenPort 80
```

Remove just the proxy:

```powershell
powershell -ExecutionPolicy Bypass -File .\installer\uninstall-nginx.ps1
```

Notes:

- WebSockets (SignalR `/hubs/devices`) and large uploads (photos) are handled by
  the proxy config.
- **Security:** with the proxy in front, the backend sees every request as coming
  from `127.0.0.1`, so the local service-control endpoints would treat LAN clients
  as local. Set a **Local Control Key** during install (and send it via the
  `X-Local-Control-Key` header) to protect Start/Stop/Restart over the LAN.
- For a non-standard port, pass `-ListenPort <port>` (the firewall rule follows it).

## 4) Update flow

1. Bump `installer/VERSION.txt`
2. Build new artifacts + installer
3. Run installer on target machine → choose **Update** when prompted
   (DB + Security pages are skipped; the existing `appsettings.Production.json` is
   preserved via `install-service.ps1 -PreserveConfig`)
4. Installer replaces payload and re-registers the service
5. Verify:
   - `GET /api/health`
   - `GET /api/health/db`
   - `GET /api/system/status`

## 5) Uninstall

```powershell
powershell -ExecutionPolicy Bypass -File .\installer\uninstall-service.ps1
```

This script stops/removes service and deletes installation directory.
It also removes tray monitor shortcuts from Startup and Start Menu.

The nginx proxy is removed separately (the installer's uninstaller does this
automatically):

```powershell
powershell -ExecutionPolicy Bypass -File .\installer\uninstall-nginx.ps1
```

## 6) Recovery / troubleshooting

- **Service not running**
  - `sc query ProjectXBackend`
  - `sc start ProjectXBackend`
- **DB auth failed**
  - check generated `appsettings.Production.json` in install dir
  - verify `Database.Username/Password`
- **Port busy**
  - change `ApiUrls` in `install-service.ps1` invocation (for example `http://localhost:5155`)
- **Local service control returns 403**
  - call from local machine only
  - if `SystemMonitor:LocalControlKey` configured, send `X-Local-Control-Key`
