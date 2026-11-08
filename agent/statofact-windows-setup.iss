#define AppVersion "1.0.0"

[Setup]
AppId={{09FEA053-0E18-4D47-91C0-60743824013A}
AppName=StatoFact Windows-Agent
AppVersion={#AppVersion}
DefaultDirName={autopf}\StatoFact Agent
DefaultGroupName=StatoFact Agent
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=admin
OutputDir=dist
OutputBaseFilename=StatoFact-Agent-Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName=StatoFact Windows-Agent
CloseApplications=no
RestartApplications=no

[Languages]
Name: "german"; MessagesFile: "compiler:Languages\German.isl"

[Files]
Source: "dist\statofact-agent-windows.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "dist\statofact-agent-service.exe"; DestDir: "{app}"; Flags: ignoreversion

[Code]
var
  SettingsPage: TInputQueryWizardPage;
  ExistingService: Boolean;

function ExecuteChecked(const FileName, Params: String): Integer;
var
  ResultCode: Integer;
begin
  if not Exec(FileName, Params, '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    RaiseException('Programm konnte nicht gestartet werden: ' + FileName);
  Result := ResultCode;
end;

function ServiceExists: Boolean;
begin
  Result := ExecuteChecked(ExpandConstant('{sys}\sc.exe'), 'query StatoFactAgent') = 0;
end;

function ServiceBelongsToInstall(const ServiceExe: String): Boolean;
var
  ImagePath: String;
begin
  Result := RegQueryStringValue(HKLM,
    'SYSTEM\CurrentControlSet\Services\StatoFactAgent', 'ImagePath', ImagePath) and
    ((CompareText(Trim(ImagePath), ServiceExe) = 0) or
     (CompareText(Trim(ImagePath), '"' + ServiceExe + '"') = 0));
end;

function InitializeSetup: Boolean;
begin
  Result := not WizardSilent;
  if not Result then
    MsgBox('Dieser Installer benötigt die interaktive Eingabe der Verbindungsdaten.', mbError, MB_OK);
end;

procedure InitializeWizard;
begin
  SettingsPage := CreateInputQueryPage(wpSelectDir, 'StatoFact-Verbindung',
    'Verbindungsdaten und Intervall', 'Geben Sie die Daten für den Windows-Dienst ein.');
  SettingsPage.Add('Server-URL (http:// oder https://):', False);
  SettingsPage.Add('Agent-Token (mindestens 16 Zeichen):', True);
  SettingsPage.Add('Intervall in Minuten (1–1440):', False);
  SettingsPage.Add('CI-Name (optional, Standard: Computername):', False);
  SettingsPage.Add('VirtualBox.xml (optional, vollständiger Pfad):', False);
  SettingsPage.Add('VMware-VM-Verzeichnis (optional, rekursiv):', False);
  SettingsPage.Values[0] := 'https://';
  SettingsPage.Values[2] := '15';
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Url, Token, Interval, Name: String;
  Minutes: Integer;
begin
  Result := True;
  if CurPageID <> SettingsPage.ID then exit;
  Url := Trim(SettingsPage.Values[0]);
  Token := SettingsPage.Values[1];
  Interval := Trim(SettingsPage.Values[2]);
  Name := Trim(SettingsPage.Values[3]);
  Minutes := StrToIntDef(Interval, 0);
  if (((Pos('http://', Lowercase(Url)) <> 1) or (Length(Url) <= 7)) and
      ((Pos('https://', Lowercase(Url)) <> 1) or (Length(Url) <= 8))) or
     (Pos(' ', Url) > 0) or (Pos(#13, Url) > 0) or (Pos(#10, Url) > 0) or
     (Pos('?', Url) > 0) or (Pos('#', Url) > 0) or (Pos('@', Url) > 0) then
  begin
    MsgBox('Bitte eine gültige HTTP(S)-Server-URL ohne Zugangsdaten, Query oder Fragment angeben.', mbError, MB_OK);
    Result := False;
  end
  else if (Length(Token) < 16) or (Trim(Token) <> Token) or
     (Pos(#13, Token) > 0) or (Pos(#10, Token) > 0) or
     (Token[1] = '"') or (Token[1] = '''') or
     (Token[Length(Token)] = '"') or (Token[Length(Token)] = '''') then
  begin
    MsgBox('Das Token muss mindestens 16 Zeichen lang sein und darf keine Zeilenumbrüche, umgebenden Leerzeichen oder Anführungszeichen enthalten.', mbError, MB_OK);
    Result := False;
  end
  else if (Minutes < 1) or (Minutes > 1440) then
  begin
    MsgBox('Das Intervall muss zwischen 1 und 1440 Minuten liegen.', mbError, MB_OK);
    Result := False;
  end
  else if (Length(Name) > 200) or (Pos(#13, Name) > 0) or (Pos(#10, Name) > 0) or
    ((Name <> '') and ((Name[1] = '"') or (Name[1] = '''') or
    (Name[Length(Name)] = '"') or (Name[Length(Name)] = ''''))) then
  begin
    MsgBox('Der CI-Name darf höchstens 200 Zeichen, keine Zeilenumbrüche und keine umgebenden Anführungszeichen enthalten.', mbError, MB_OK);
    Result := False;
  end
  else if (Pos(#13, SettingsPage.Values[4]) > 0) or (Pos(#10, SettingsPage.Values[4]) > 0) or
    (Pos(#13, SettingsPage.Values[5]) > 0) or (Pos(#10, SettingsPage.Values[5]) > 0) then
  begin
    MsgBox('Die VM-Pfade dürfen keine Zeilenumbrüche enthalten.', mbError, MB_OK);
    Result := False;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ConfigDir, ServiceExe, Params: String;
  Config: TArrayOfString;
begin
  ServiceExe := ExpandConstant('{app}\statofact-agent-service.exe');
  if CurStep = ssInstall then
  begin
    ExistingService := ServiceExists;
    if ExistingService then
    begin
      if not FileExists(ServiceExe) or not ServiceBelongsToInstall(ServiceExe) then
        RaiseException('Ein anderer Dienst mit diesem Namen ist bereits registriert. Bitte den bisherigen Installationsordner auswählen oder den bestehenden Dienst prüfen.');
      if ExecuteChecked(ServiceExe, '--stop') <> 0 then
        RaiseException('Der bestehende StatoFact-Dienst konnte nicht angehalten werden.');
    end;
  end;
  if CurStep = ssPostInstall then
  begin
    ConfigDir := ExpandConstant('{commonappdata}\StatoFact');
    if not ForceDirectories(ConfigDir) then
      RaiseException('Konfigurationsverzeichnis konnte nicht erstellt werden.');
    Params := '"' + ConfigDir + '" /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F"';
    if ExecuteChecked(ExpandConstant('{sys}\icacls.exe'), Params) <> 0 then
      RaiseException('Die Zugriffsrechte für die Konfiguration konnten nicht gesetzt werden.');
    if FileExists(ConfigDir + '\agent.conf') then
    begin
      Params := '"' + ConfigDir + '\agent.conf" /inheritance:r /grant:r "*S-1-5-18:F" "*S-1-5-32-544:F"';
      if ExecuteChecked(ExpandConstant('{sys}\icacls.exe'), Params) <> 0 then
        RaiseException('Die Zugriffsrechte der bestehenden Konfiguration konnten nicht gesetzt werden.');
    end;
    SetArrayLength(Config, 6);
    Config[0] := 'STATOFACT_URL=' + Trim(SettingsPage.Values[0]);
    Config[1] := 'STATOFACT_TOKEN=' + SettingsPage.Values[1];
    Config[2] := 'STATOFACT_INTERVAL_MINUTES=' + Trim(SettingsPage.Values[2]);
    Config[3] := 'STATOFACT_NAME=' + Trim(SettingsPage.Values[3]);
    Config[4] := 'STATOFACT_VIRTUALBOX_REGISTRY=' + Trim(SettingsPage.Values[4]);
    Config[5] := 'STATOFACT_VMWARE_DIRECTORY=' + Trim(SettingsPage.Values[5]);
    if not SaveStringsToUTF8File(ConfigDir + '\agent.conf', Config, False) then
      RaiseException('Konfiguration konnte nicht gespeichert werden.');
    SettingsPage.Values[1] := '';
    Config[1] := '';
    if ExistingService then
      Params := 'config StatoFactAgent binPath= "\"' + ServiceExe + '\"" start= auto'
    else
      Params := 'create StatoFactAgent binPath= "\"' + ServiceExe + '\"" start= auto DisplayName= "StatoFact Agent"';
    if ExecuteChecked(ExpandConstant('{sys}\sc.exe'), Params) <> 0 then
      RaiseException('Der StatoFact-Dienst konnte nicht registriert werden.');
    if ExecuteChecked(ExpandConstant('{sys}\sc.exe'), 'start StatoFactAgent') <> 0 then
      RaiseException('Der StatoFact-Dienst konnte nicht gestartet werden. Prüfen Sie die Konfiguration und das Windows-Ereignisprotokoll.');
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
  begin
    if ServiceExists then
    begin
      if not ServiceBelongsToInstall(ExpandConstant('{app}\statofact-agent-service.exe')) then
        RaiseException('Der registrierte Dienst gehört nicht zu dieser Installation und wird nicht entfernt.');
      if ExecuteChecked(ExpandConstant('{app}\statofact-agent-service.exe'), '--stop') <> 0 then
        RaiseException('Der StatoFact-Dienst konnte nicht angehalten werden.');
      if ExecuteChecked(ExpandConstant('{sys}\sc.exe'), 'delete StatoFactAgent') <> 0 then
        RaiseException('Der StatoFact-Dienst konnte nicht entfernt werden.');
    end;
  end;
end;
