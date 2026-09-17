; ADAU branding: only user-visible names change. AppId, service names, install folders
; and the DB stay as before, otherwise update and uninstall of existing installs break.
#define AppName "ADAU"
#define AppId "{{E85E0915-8C49-4ECA-8C0D-77CF09BD9965}"
; ── Version control: VERSION.txt is the single source of truth ──
#define VerHandle FileOpen(AddBackslash(SourcePath) + "VERSION.txt")
#define AppVersion Trim(FileRead(VerHandle))
#expr FileClose(VerHandle)
#define ServiceName "ProjectXBackend"

[Setup]
AppId={#AppId}
AppName={#AppName}
AppVersion={#AppVersion}
VersionInfoVersion={#AppVersion}
VersionInfoProductVersion={#AppVersion}
AppPublisher=ADAU
DefaultDirName={autopf}\ProjectX\InstallerTools
DefaultGroupName=ADAU
OutputDir=..\artifacts\installer
OutputBaseFilename=ADAU-Setup-{#AppVersion}
Compression=lzma
SolidCompression=yes
WizardStyle=modern
WizardSizePercent=120
WizardImageStretch=yes
WizardImageFile=branding\wizard-large.bmp,branding\wizard-large@2x.bmp,branding\wizard-large@3x.bmp
WizardSmallImageFile=branding\wizard-small.bmp,branding\wizard-small@2x.bmp,branding\wizard-small@3x.bmp
PrivilegesRequired=admin
; Run in 64-bit mode on x64 so {autopf}/{sys} and the PowerShell we launch are
; 64-bit. Otherwise a 32-bit install sees $env:ProgramFiles = Program Files (x86)
; and can't find the 64-bit PostgreSQL (psql.exe) — the app DB/role never get
; created and the service fails to start.
ArchitecturesInstallIn64BitMode=x64compatible

[Files]
Source: "..\artifacts\installer\backend-publish\*"; DestDir: "{app}\payload"; Flags: recursesubdirs ignoreversion
Source: "..\installer\install-service.ps1";   DestDir: "{tmp}"; Flags: deleteafterinstall
Source: "..\installer\uninstall-service.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\installer\install-postgres.ps1";  DestDir: "{tmp}"; Flags: deleteafterinstall
Source: "..\installer\install-npcap.ps1";     DestDir: "{tmp}"; Flags: deleteafterinstall
Source: "..\installer\install-nginx.ps1";          DestDir: "{tmp}"; Flags: deleteafterinstall
Source: "..\installer\nginx\projectx-nginx.conf";  DestDir: "{tmp}"; Flags: deleteafterinstall
Source: "..\installer\uninstall-nginx.ps1";        DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\ADAU Dashboard"; Filename: "http://localhost:5055/system"
Name: "{group}\ADAU (LAN via nginx)"; Filename: "http://localhost/system"

[UninstallRun]
Filename: "powershell.exe"; \
  Parameters: "-ExecutionPolicy Bypass -File ""{app}\uninstall-nginx.ps1"""; \
  Flags: runhidden waituntilterminated; \
  RunOnceId: "StopAndRemoveNginx"
Filename: "powershell.exe"; \
  Parameters: "-ExecutionPolicy Bypass -File ""{app}\uninstall-service.ps1"" -ServiceName ""ProjectXBackend"" -InstallDir ""{commonpf}\ProjectX\Backend"""; \
  Flags: runhidden waituntilterminated; \
  RunOnceId: "StopAndRemoveService"

[UninstallDelete]
Type: filesandordirs; Name: "{commonpf}\ProjectX\Backend"
Type: filesandordirs; Name: "{commonpf}\ProjectX\InstallerTools"
Type: dirifempty;     Name: "{commonpf}\ProjectX"

[Code]
var
  FilesWereInstalled: Boolean;
  InstallSucceeded: Boolean;
  IsUpdate: Boolean;
  GeneratedDbPw: String;

  { Options page (database + LAN). No JWT — it is generated automatically. }
  DbPage: TWizardPage;
  AutoNote: TNewStaticText;
  EnableLanCheckbox: TNewCheckBox;
  InstallNpcapCheckbox: TNewCheckBox;
  OwnDbCheckbox: TNewCheckBox;
  DbHostLabel, DbPortLabel, DbNameLabel, DbUserLabel, DbPassLabel: TNewStaticText;
  DbHostEdit, DbPortEdit, DbNameEdit, DbUserEdit, DbPasswordEdit: TNewEdit;

{ ── Version control / maintenance (update vs remove) ─────────────────────────── }
const
  UninstKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{E85E0915-8C49-4ECA-8C0D-77CF09BD9965}_is1';

function GetInstalledVersion(var Ver: String): Boolean;
begin
  Result := RegQueryStringValue(HKLM, UninstKey, 'DisplayVersion', Ver);
  if not Result then
    Result := RegQueryStringValue(HKLM64, UninstKey, 'DisplayVersion', Ver);
end;

function GetUninstallString(var S: String): Boolean;
begin
  Result := RegQueryStringValue(HKLM, UninstKey, 'UninstallString', S);
  if not Result then
    Result := RegQueryStringValue(HKLM64, UninstKey, 'UninstallString', S);
end;

{ Returns 1 if A>B, -1 if A<B, 0 if equal. Components missing on either side count as 0. }
function CompareVersions(A, B: String): Integer;
var
  pa, pb, na, nb: Integer;
  sa, sb: String;
begin
  Result := 0;
  while ((A <> '') or (B <> '')) and (Result = 0) do
  begin
    pa := Pos('.', A);
    if pa > 0 then begin sa := Copy(A, 1, pa - 1); A := Copy(A, pa + 1, Length(A)); end
    else begin sa := A; A := ''; end;
    pb := Pos('.', B);
    if pb > 0 then begin sb := Copy(B, 1, pb - 1); B := Copy(B, pb + 1, Length(B)); end
    else begin sb := B; B := ''; end;
    na := StrToIntDef(sa, 0);
    nb := StrToIntDef(sb, 0);
    if na > nb then Result := 1
    else if na < nb then Result := -1;
  end;
end;

procedure RunExistingUninstaller();
var
  S: String;
  RC: Integer;
begin
  if GetUninstallString(S) then
  begin
    S := RemoveQuotes(S);
    Exec(S, '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART', '', SW_SHOW, ewWaitUntilTerminated, RC);
  end;
end;

{ Runs before the wizard. If a previous install exists, ask the user to update or remove. }
function InitializeSetup(): Boolean;
var
  Prev: String;
  Cmp, R: Integer;
begin
  Result := True;
  IsUpdate := False;

  if not GetInstalledVersion(Prev) then
    Exit; { fresh install — continue normally }

  Cmp := CompareVersions('{#AppVersion}', Prev);

  if Cmp > 0 then
  begin
    R := MsgBox('ADAU версии ' + Prev + ' уже установлена.' + #13#10 +
                'Доступно обновление до версии {#AppVersion}.' + #13#10#13#10 +
                'Да — Обновить' + #13#10 +
                'Нет — Удалить' + #13#10 +
                'Отмена — Выход', mbConfirmation, MB_YESNOCANCEL);
    if R = IDYES then IsUpdate := True
    else if R = IDNO then begin RunExistingUninstaller(); Result := False; end
    else Result := False;
  end
  else if Cmp = 0 then
  begin
    R := MsgBox('ADAU версии ' + Prev + ' уже установлена (та же версия).' + #13#10#13#10 +
                'Да — Переустановить' + #13#10 +
                'Нет — Удалить' + #13#10 +
                'Отмена — Выход', mbConfirmation, MB_YESNOCANCEL);
    { Reinstall of the SAME version = clean install (re-run DB setup, regenerate
      config), NOT a config-preserving update. }
    if R = IDYES then IsUpdate := False
    else if R = IDNO then begin RunExistingUninstaller(); Result := False; end
    else Result := False;
  end
  else
  begin
    R := MsgBox('Установлена более новая версия ADAU (' + Prev + ').' + #13#10 +
                'Этот установщик — версия {#AppVersion}. Понижение не поддерживается.' + #13#10#13#10 +
                'Удалить установленную версию?', mbConfirmation, MB_YESNO);
    if R = IDYES then RunExistingUninstaller();
    Result := False; { never downgrade-install }
  end;
end;

{ On update we reuse the existing config, so skip the options page. }
function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := IsUpdate and (PageID = DbPage.ID);
end;

{ Detect PostgreSQL via inline PowerShell — no temp file needed }
function DetectPostgres(): Boolean;
var
  RC: Integer;
begin
  Result := Exec(
    'powershell.exe',
    '-NoProfile -Command "if (Get-Service -Name ''postgresql*'' -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"',
    '', SW_HIDE, ewWaitUntilTerminated, RC
  ) and (RC = 0);
end;

{ Random token for the auto-generated DB password (local DB, fronted by nginx). }
function GenerateToken(Len: Integer): String;
var
  Chars: String;
  i: Integer;
begin
  Chars := 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  Result := '';
  for i := 1 to Len do
    Result := Result + Chars[Random(Length(Chars)) + 1];
end;

{ Show/hide the manual connection fields based on the "own database" checkbox. }
procedure UpdateDbFieldsVisibility();
var
  V: Boolean;
begin
  V := OwnDbCheckbox.Checked;
  DbHostLabel.Visible := V;  DbHostEdit.Visible := V;
  DbPortLabel.Visible := V;  DbPortEdit.Visible := V;
  DbNameLabel.Visible := V;  DbNameEdit.Visible := V;
  DbUserLabel.Visible := V;  DbUserEdit.Visible := V;
  DbPassLabel.Visible := V;  DbPasswordEdit.Visible := V;
end;

procedure OwnDbCheckboxClick(Sender: TObject);
begin
  UpdateDbFieldsVisibility();
end;

procedure InitializeWizard();
var
  Y: Integer;
begin
  GeneratedDbPw := GenerateToken(24);

  { ── Options page (automatic by default) ─────────────────────── }
  DbPage := CreateCustomPage(wpSelectDir,
    'Setup options',
    'ADAU installs and configures everything automatically.');

  Y := ScaleY(4);

  AutoNote := TNewStaticText.Create(DbPage);
  AutoNote.Parent   := DbPage.Surface;
  AutoNote.Top      := Y;
  AutoNote.Width    := DbPage.SurfaceWidth;
  AutoNote.Height   := ScaleY(44);
  AutoNote.AutoSize := False;
  AutoNote.WordWrap := True;
  AutoNote.Caption  := 'PostgreSQL and the application database are installed and connected automatically. Security keys are generated for you — nothing to enter. Just click Next.';
  Y := Y + ScaleY(52);

  EnableLanCheckbox := TNewCheckBox.Create(DbPage);
  EnableLanCheckbox.Parent  := DbPage.Surface;
  EnableLanCheckbox.Top     := Y;
  EnableLanCheckbox.Width   := DbPage.SurfaceWidth;
  EnableLanCheckbox.Caption := 'Make the app available on the local network (nginx on port 80)';
  EnableLanCheckbox.Checked := True;
  Y := Y + ScaleY(26);

  InstallNpcapCheckbox := TNewCheckBox.Create(DbPage);
  InstallNpcapCheckbox.Parent  := DbPage.Surface;
  InstallNpcapCheckbox.Top     := Y;
  InstallNpcapCheckbox.Width   := DbPage.SurfaceWidth;
  InstallNpcapCheckbox.Caption := 'Install Npcap for device auto-discovery (recommended)';
  InstallNpcapCheckbox.Checked := True;
  Y := Y + ScaleY(26);

  OwnDbCheckbox := TNewCheckBox.Create(DbPage);
  OwnDbCheckbox.Parent  := DbPage.Surface;
  OwnDbCheckbox.Top     := Y;
  OwnDbCheckbox.Width   := DbPage.SurfaceWidth;
  OwnDbCheckbox.Caption := 'Use my own PostgreSQL database (advanced)';
  OwnDbCheckbox.Checked := False;
  OwnDbCheckbox.OnClick := @OwnDbCheckboxClick;
  Y := Y + ScaleY(30);

  { Row: Host + Port side by side (shown only with "own database") }
  DbHostLabel := TNewStaticText.Create(DbPage);
  DbHostLabel.Parent  := DbPage.Surface;
  DbHostLabel.Top     := Y;
  DbHostLabel.Caption := 'DB Host';
  DbHostLabel.AutoSize := True;

  DbPortLabel := TNewStaticText.Create(DbPage);
  DbPortLabel.Parent  := DbPage.Surface;
  DbPortLabel.Top     := Y;
  DbPortLabel.Left    := ScaleX(250);
  DbPortLabel.Caption := 'DB Port';
  DbPortLabel.AutoSize := True;
  Y := Y + ScaleY(14);

  DbHostEdit := TNewEdit.Create(DbPage);
  DbHostEdit.Parent := DbPage.Surface;
  DbHostEdit.Top    := Y;
  DbHostEdit.Width  := ScaleX(220);
  DbHostEdit.Text   := 'localhost';

  DbPortEdit := TNewEdit.Create(DbPage);
  DbPortEdit.Parent := DbPage.Surface;
  DbPortEdit.Top    := Y;
  DbPortEdit.Left   := ScaleX(250);
  DbPortEdit.Width  := ScaleX(80);
  DbPortEdit.Text   := '5432';
  Y := Y + ScaleY(30);

  { Row: DB Name + DB User side by side }
  DbNameLabel := TNewStaticText.Create(DbPage);
  DbNameLabel.Parent  := DbPage.Surface;
  DbNameLabel.Top     := Y;
  DbNameLabel.Caption := 'DB Name';
  DbNameLabel.AutoSize := True;

  DbUserLabel := TNewStaticText.Create(DbPage);
  DbUserLabel.Parent  := DbPage.Surface;
  DbUserLabel.Top     := Y;
  DbUserLabel.Left    := ScaleX(250);
  DbUserLabel.Caption := 'DB User';
  DbUserLabel.AutoSize := True;
  Y := Y + ScaleY(14);

  DbNameEdit := TNewEdit.Create(DbPage);
  DbNameEdit.Parent := DbPage.Surface;
  DbNameEdit.Top    := Y;
  DbNameEdit.Width  := ScaleX(220);
  DbNameEdit.Text   := 'projectx';

  DbUserEdit := TNewEdit.Create(DbPage);
  DbUserEdit.Parent := DbPage.Surface;
  DbUserEdit.Top    := Y;
  DbUserEdit.Left   := ScaleX(250);
  DbUserEdit.Width  := ScaleX(220);
  DbUserEdit.Text   := 'projectx_user';
  Y := Y + ScaleY(30);

  { DB Password full width }
  DbPassLabel := TNewStaticText.Create(DbPage);
  DbPassLabel.Parent  := DbPage.Surface;
  DbPassLabel.Top     := Y;
  DbPassLabel.Caption := 'DB Password';
  DbPassLabel.AutoSize := True;
  Y := Y + ScaleY(14);

  DbPasswordEdit := TNewEdit.Create(DbPage);
  DbPasswordEdit.Parent       := DbPage.Surface;
  DbPasswordEdit.Top          := Y;
  DbPasswordEdit.Width        := ScaleX(300);
  DbPasswordEdit.PasswordChar := '*';

  UpdateDbFieldsVisibility();
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;

  if CurPageID = DbPage.ID then
  begin
    { Only the "use my own database" path needs a password from the user. }
    if OwnDbCheckbox.Checked and (Trim(DbPasswordEdit.Text) = '') then
    begin
      MsgBox('Please enter the password for your PostgreSQL database.', mbError, MB_OK);
      Result := False;
      Exit;
    end;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Params, LogPath: String;
  NginxParams, NginxLogPath: String;
  NpcapParams, NpcapLogPath: String;
  EffHost, EffPort, EffName, EffUser, EffPw: String;
  ResultCode: Integer;
begin
  if CurStep = ssInstall then
    FilesWereInstalled := True;

  if CurStep = ssPostInstall then
  begin
    { Effective DB connection: automatic (generated password) unless the user
      supplied their own database. }
    if OwnDbCheckbox.Checked then
    begin
      EffHost := DbHostEdit.Text;  EffPort := DbPortEdit.Text;
      EffName := DbNameEdit.Text;  EffUser := DbUserEdit.Text;  EffPw := DbPasswordEdit.Text;
    end
    else
    begin
      EffHost := 'localhost';  EffPort := '5432';
      EffName := 'projectx';   EffUser := 'projectx_user';  EffPw := GeneratedDbPw;
    end;

    { Automatic DB: install native PostgreSQL (if absent) and create the app DB + role.
      Skipped on update, or when the user supplied their own database. }
    if (not IsUpdate) and (not OwnDbCheckbox.Checked) then
      Exec('powershell.exe',
        '-ExecutionPolicy Bypass -File "' + ExpandConstant('{tmp}\install-postgres.ps1') + '"' +
        ' -DbName "'        + EffName + '"' +
        ' -DbUser "'        + EffUser + '"' +
        ' -DbPassword "'    + EffPw + '"' +
        ' -DbPort '         + EffPort +
        ' -SuperPassword "' + EffPw + '"',
        '', SW_SHOW, ewWaitUntilTerminated, ResultCode);

    LogPath := ExpandConstant('{userdocs}') + '\ADAU-install.log';

    { JWT key is auto-generated by install-service.ps1 (no -JwtKey passed). }
    Params :=
      '-ExecutionPolicy Bypass -File "' + ExpandConstant('{tmp}\install-service.ps1') + '"' +
      ' -SourceDir "'  + ExpandConstant('{app}\payload') + '"' +
      ' -ServiceName "' + '{#ServiceName}' + '"' +
      ' -DbHost "'     + EffHost + '"' +
      ' -DbPort '      + EffPort +
      ' -DbName "'     + EffName + '"' +
      ' -DbUser "'     + EffUser + '"' +
      ' -DbPassword "' + EffPw + '"' +
      ' -LogPath "'    + LogPath + '"';

    { On update, keep the existing appsettings.Production.json (DB/JWT unchanged). }
    if IsUpdate then
      Params := Params + ' -PreserveConfig';

    if not Exec('powershell.exe', Params, '', SW_SHOW, ewWaitUntilTerminated, ResultCode) then
      MsgBox('Service installation script failed to start.', mbError, MB_OK)
    else if ResultCode <> 0 then
      MsgBox('Service installation failed.' + #13#10 +
             'Check log: ' + LogPath, mbError, MB_OK)
    else
      InstallSucceeded := True;

    { ── Optional: nginx LAN reverse proxy (port 80 -> 127.0.0.1:5055) ── }
    if InstallSucceeded and EnableLanCheckbox.Checked and (not IsUpdate) then
    begin
      NginxLogPath := ExpandConstant('{userdocs}') + '\ADAU-install-nginx.log';
      NginxParams :=
        '-ExecutionPolicy Bypass -File "' + ExpandConstant('{tmp}\install-nginx.ps1') + '"' +
        ' -BackendPort 5055 -ListenPort 80' +
        ' -ConfTemplate "' + ExpandConstant('{tmp}\projectx-nginx.conf') + '"' +
        ' -LogPath "' + NginxLogPath + '"';

      if not Exec('powershell.exe', NginxParams, '', SW_SHOW, ewWaitUntilTerminated, ResultCode) then
        MsgBox('nginx setup failed to start. The backend is installed and reachable at http://localhost:5055.', mbError, MB_OK)
      else if ResultCode <> 0 then
        MsgBox('nginx setup failed (LAN access not configured).' + #13#10 +
               'The backend still works locally at http://localhost:5055.' + #13#10 +
               'Check log: ' + NginxLogPath, mbError, MB_OK);
    end;

    { ── Optional: Npcap (packet capture) for the SADP PCAP discovery channel ── }
    if InstallSucceeded and InstallNpcapCheckbox.Checked and (not IsUpdate) then
    begin
      NpcapLogPath := ExpandConstant('{userdocs}') + '\ADAU-install-npcap.log';
      NpcapParams :=
        '-ExecutionPolicy Bypass -File "' + ExpandConstant('{tmp}\install-npcap.ps1') + '"' +
        ' -LogPath "' + NpcapLogPath + '"';
      if not Exec('powershell.exe', NpcapParams, '', SW_SHOW, ewWaitUntilTerminated, ResultCode) then
        MsgBox('Npcap setup failed to start. Device auto-discovery will use UDP only.', mbInformation, MB_OK)
      else if ResultCode <> 0 then
        MsgBox('Npcap was not installed (device auto-discovery will use UDP only).' + #13#10 +
               'You can install it later from https://npcap.com.' + #13#10 +
               'Log: ' + NpcapLogPath, mbInformation, MB_OK);
    end;
  end;
end;

procedure DeinitializeSetup();
var
  ResultCode: Integer;
begin
  if FilesWereInstalled and (not InstallSucceeded) then
    Exec('powershell.exe',
      '-NoProfile -Command "' +
        'sc.exe stop ProjectXBackend 2>$null; ' +
        'sc.exe delete ProjectXBackend 2>$null; ' +
        'Start-Sleep -Seconds 1; ' +
        'Remove-Item -Recurse -Force ''C:\Program Files\ProjectX\Backend'' -ErrorAction SilentlyContinue; ' +
        'Remove-Item -Recurse -Force ''C:\Program Files\ProjectX\InstallerTools'' -ErrorAction SilentlyContinue; ' +
        '$d = ''C:\Program Files\ProjectX''; ' +
        'if ((Test-Path $d) -and -not (Get-ChildItem $d -ErrorAction SilentlyContinue)) { Remove-Item $d -Force -ErrorAction SilentlyContinue }' +
      '"',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;
