# statofact

Rechenzentrums-CMDB (Configuration Management Database) mit Next.js (App Router, TypeScript) und ArcadeDB als Storage.

## Datenmodell

Das Modell ist in `src/lib/model.ts` definiert und wird für Schema, Validierung und UI genutzt.

Alle CIs haben `name`, `status`, `owner`, `description`. Typen (Vertex-Typen, erben von `CI`):

| Typ | Zusatzfelder |
| --- | --- |
| Site (Standort) | code, address, country |
| Room (Raum) | floor, coolingKw |
| Rack | heightU, maxPowerW, maxWeightKg, row, position |
| Device (Gerät) | deviceType, vendor, model, serialNumber, assetTag, heightU, powerW, managementIp |
| VirtualMachine | vcpu, ramGb, diskGb, os |
| Application | version, environment |
| Software (Softwarepaket) | Name des Pakets, system- und versionsunabhängig |
| SoftwarePackage (Softwareinstallation) | packageName, version, architecture, hostId |
| Service | serviceKey, hostId, bindings, executables, discoverySource |
| Network | vlanId, cidr |

Beziehungen (Edge-Typ `Relation` mit Attribut `kind`; nur zulässige Typ-Kombinationen):

| Art | Regeln | Attribute |
| --- | --- | --- |
| `located_in` | Raum→Standort, Rack→Raum, Gerät→Rack/Raum (je höchstens eine) | unterste HE |
| `hosted_on` | VM→Gerät, Anwendung→VM/Gerät (je höchstens eine) | |
| `powered_by` | Gerät→Gerät | Strang, Steckdose |
| `connected_to` | Gerät→Gerät | Ports, Kabel-ID |
| `member_of` | Gerät/VM→Netzwerk | IP-Adresse |
| `depends_on` | Anwendung→Anwendung/Netzwerk, VM→VM, Softwareinstallation→Softwareinstallation | |
| `installed_on` | Softwareinstallation→Gerät/VM | |
| `installation_of` | Softwareinstallation→Softwarepaket | |
| `service_on` | Service→Gerät/VM | Erfassungsquelle |
| `provided_by` | Service→Softwareinstallation | Erfassungsquelle |

Beim Einbau in ein Rack werden Höhe und Kollisionen der Höheneinheiten (HE) geprüft. Container (Standort, Raum, Rack, Gerät mit VMs) lassen sich erst löschen, wenn sie leer sind.

## Funktionen

- StatoFact-Logo in der globalen Navigation
- CIs anlegen, suchen/filtern nach Typ, bearbeiten und löschen
- Startseite und Navigationsbaum laden CI-Einträge erst beim Aufklappen des Typs und zeigen höchstens 50 Einträge pro Seite. Die Suche auf der Startseite filtert die aufgeklappten Typen nach Namen.
- Detailseite mit Standortpfad, Rack-Belegung und Beziehungen (beide Richtungen)
- CI-Typen werden in Navigation und Ansichten durch lokal eingebundene Iconify-/Lucide-Icons gekennzeichnet.
- Softwarepakete zeigen ihre Installationen mit System, Version und Architektur auf der jeweiligen Detailseite. Installationen haben keinen eigenen Navigationspunkt; ihre Details sind weiterhin verlinkt. Beziehungsziele werden erst beim Öffnen des Beziehungsformulars geladen.

## Einrichtung

```bash
npm install
```

1. `.env.example` nach `.env.local` kopieren und ausfüllen.
2. ArcadeDB muss auf `ARCADEDB_URL` (Standard `http://localhost:2480`) laufen.
3. Schema anlegen (einmalig, benötigt Admin-Zugang `ARCADEDB_ADMIN_USER`/`ARCADEDB_ADMIN_PASSWORD`):

   ```bash
   npm run db:setup
   ```

4. Der App-Benutzer (`ARCADEDB_USER`) braucht nur Datenrechte (`createRecord`, `readRecord`, `updateRecord`, `deleteRecord`) auf der Datenbank, keine Schema-Rechte. Gruppen werden in ArcadeDB in `config/server-groups.json` definiert und dem Benutzer zugewiesen.

## Jobrunner

Unter `/jobs` lassen sich Jobs einmalig oder regelmäßig (Intervall in Minuten) planen, manuell auslösen, pausieren und löschen. Die Läufe samt Protokoll (Status, Dauer, Log) stehen auf der Detailseite.

- Jobs (`Job`) und Läufe (`JobRun`) liegen in ArcadeDB. Ein Scheduler im Next-Prozess (gestartet über `src/instrumentation.ts`) prüft alle 5 s auf fällige Jobs, führt höchstens 4 parallel aus (Timeout je Job: 5 min) und sichert sich jeden Job per atomarem Lease gegen doppelte Ausführung.
- Verpasste Termine (Server war aus) werden beim Start einmal nachgeholt, kein Nachlauf aller ausgefallenen Intervalle. Hängengebliebene Läufe werden beim Start als fehlgeschlagen markiert.
- Der Scheduler läuft nur, wenn der Server läuft (`npm run dev` / `npm start`). Mit `JOBRUNNER=off` lässt er sich in einem Prozess abschalten, z. B. bei mehreren Instanzen.
- Startzeit und einmalige Termine werden in der Ortszeit des Servers angegeben.

Job-Typen (`src/lib/jobs/handlers.ts`):

| Typ | Funktion |
| --- | --- |
| `import_json` | Lädt ein JSON-Array `[{"type":"Device","name":"srv1","heightU":2,…}]` von einer URL und legt CIs an bzw. aktualisiert sie (Schlüssel: Typ + Name; nur angegebene Felder, validiert gegen das Modell). |
| `agent_pull` | Ruft einen passiven Linux-Agenten über SSH ab und synchronisiert den vollständigen Agent-Report. |
| `tcp_check` | Prüft die Management-IP aller Geräte per TCP-Port und protokolliert die Erreichbarkeit. |
| `cleanup_runs` | Löscht alte Laufprotokolle. Empfehlung: als regelmäßigen Job anlegen. |

Neue Typen: Eintrag in `HANDLERS` ergänzen (Label, Parameter-Felder, `run`-Funktion mit `ctx.log`); ein Fehler (`throw`) markiert den Lauf als fehlgeschlagen. Nach dem Update einmal `npm run db:setup` ausführen (legt `Job` und `JobRun` an).

Sicherheitshinweis: `import_json` ruft beliebige http(s)-URLs vom Server aus ab. Die App hat keine Authentifizierung, sie gehört daher nur in ein vertrauenswürdiges Netz.

## Linux-Agent

Der Agent (`agent/statofact-agent.py`, Python 3, nur Standardbibliothek) läuft **auf dem Linux-Rechner**, liest Hostname, OS, vCPU, RAM, Disk, IPs sowie Hersteller/Modell/Seriennummer aus und schickt sie per `POST /api/agent/report` an Statofact. Virtualisierte Systeme (`systemd-detect-virt`) werden als `VirtualMachine`, physische als `Device` angelegt bzw. aktualisiert (Schlüssel: Typ + Name, Standard-Name = Hostname).

1. In `.env.local` des Servers ein Token setzen (mind. 16 Zeichen, z. B. `openssl rand -hex 20`) und den Server neu starten: `AGENT_TOKEN=…`. Ohne Token antwortet die API mit 503.
2. Server muss von außen erreichbar sein (`next dev -H 0.0.0.0` bzw. `next start -H 0.0.0.0`, Firewall für den Port öffnen).
3. Installation auf dem Linux-Rechner (Debian/Ubuntu) per Paket:
   ```
   python agent/build-deb.py            # erzeugt agent/dist/statofact-agent_<version>_all.deb (läuft auch unter Windows)
   sudo dpkg -i statofact-agent_0.6.0_all.deb
   sudoedit /etc/statofact-agent.conf    # STATOFACT_URL und STATOFACT_TOKEN setzen
   sudo systemctl start statofact-agent  # sofort einmal melden (sonst automatisch alle 15 min)
   ```
   Das Paket installiert `/usr/bin/statofact-agent`, die systemd-Units (Timer alle 15 min, startet nach 1 min nach dem Boot) und `/etc/statofact-agent.conf` (nur root lesbar, bleibt bei Updates erhalten, wird bei `purge` entfernt). Solange kein Token gesetzt ist, tut der Dienst nichts. Intervall ändern: `sudo systemctl edit statofact-agent.timer`. Version in `agent/build-deb.py` (`VERSION`) anheben.
   Alternativ ohne Paket: `sudo agent/install.sh http://STATOFACT-HOST:3000 TOKEN [INTERVALL_MIN]`.

   Auf RPM-basierten Systemen (z. B. Fedora) wird das RPM auf einem Linux-Buildsystem mit `rpmbuild` erstellt:
   ```
   sh agent/build-rpm.sh                # erzeugt agent/dist/statofact-agent-0.6.0-1.noarch.rpm
   sudo rpm -Uvh --nosignature ./statofact-agent-0.6.0-1.noarch.rpm
   sudoedit /etc/statofact-agent.conf    # STATOFACT_URL und STATOFACT_TOKEN setzen
   sudo systemctl start statofact-agent.service
   ```
   Das selbst gebaute RPM ist nicht signiert; `--nosignature` nur für vertrauenswürdig erzeugte und überprüfte Pakete verwenden. Das RPM erhält die Konfiguration bei Updates (`.rpmnew` bei Änderungen) und aktiviert den Timer bei Erstinstallation. Zum Bauen unter Windows kann WSL mit installiertem `rpmbuild` verwendet werden.

### Passiver Abruf über SSH

Der Standardmodus `STATOFACT_MODE=active` sendet weiterhin regelmäßig per HTTP. Alternativ `STATOFACT_MODE=passive` in `/etc/statofact-agent.conf` setzen; der Timer kann deaktiviert werden (`sudo systemctl disable --now statofact-agent.timer`). Im passiven Modus sendet der Agent nicht selbst, sondern liefert auf Abruf einmalig denselben Report über SSH. Ein zusätzlicher Netzwerkdienst ist nicht erforderlich. Bereits installierte Konfigurationsdateien bleiben bei Paketupdates erhalten; ohne `STATOFACT_MODE` gilt `active`.

1. Auf dem Hauptsystem OpenSSH installieren und für das Benutzerkonto des Next-/Jobrunner-Prozesses einen SSH-Schlüssel einrichten (z. B. über `ssh-agent` oder `~/.ssh/id_ed25519`). Den Hostschlüssel des Zielsystems unabhängig prüfen und in dessen `~/.ssh/known_hosts` eintragen. Der Job akzeptiert keine interaktiven Passwörter oder unbekannte Hostschlüssel.
2. Auf dem Agenten den öffentlichen Schlüssel einem dedizierten SSH-Benutzer zuordnen. Dieser benötigt ausschließlich passwortloses sudo für den exakten Befehl `/usr/bin/statofact-agent --pull`, z. B. per `visudo`:
   ```
   statofact ALL=(root) NOPASSWD: /usr/bin/statofact-agent --pull
   ```
   Den SSH-Zugang und sudo auf vertrauenswürdige Benutzer beschränken: Der Report enthält System-, Netzwerk- und Softwaredaten. Der Agent liest Modus und optional `STATOFACT_NAME` aus der root-geschützten Konfiguration und verweigert Abrufe im aktiven Modus.
3. Unter `/jobs` einen Job vom Typ **Passiven Agenten abrufen (SSH)** mit Host, SSH-Benutzer, Port und Intervall anlegen. Der Job verwendet die SSH-Konfiguration und Schlüssel des Serverkontos; Schlüssel und Passwörter werden nicht in Jobparametern gespeichert. Fehler beim Abruf oder Import erscheinen im Jobprotokoll. Firewallzugriff auf den SSH-Port ist erforderlich.

Die manuelle Installation über `install.sh` legt neue Installationen ebenfalls unter `/usr/bin` und `/etc/statofact-agent.conf` ab. Ältere manuell installierte Agenten mit `/usr/local/bin` und `/etc/statofact-agent.env` müssen dafür erneut installiert und ihre Einstellungen übernommen werden.

## Windows-Agent

Der Agent (`agent/statofact-agent-windows.py`) ermittelt mit PowerShell-CIM Hardware und Betriebssystem, Netzwerkadapter mit IP-Adressen, Standard-Gateway und DNS sowie installierte Programme aus den Registry-Deinstallationsschlüsseln. Erkannte Hypervisor-Systeme werden als `VirtualMachine`, andere als `Device` an `POST /api/agent/report` übertragen. Die Softwareinventur ist auf 5000 Einträge begrenzt; Programme werden nach Name und Architektur zusammengefasst.

### Installation als Windows-Dienst

`agent\dist\StatoFact-Agent-Setup.exe` auf dem Windows-x64-Zielsystem mit Administratorrechten starten. Der Inno-Setup-Assistent fragt Server-URL, `AGENT_TOKEN` (mindestens 16 Zeichen), Intervall in Minuten (1–1440, Standard 15) und optional den CI-Namen ab. Eine unbeaufsichtigte Installation ist nicht unterstützt. Der Installer registriert den automatisch startenden Dienst **StatoFact Agent** (`StatoFactAgent`) unter `LocalSystem` und startet ihn sofort. Ein angemeldeter Benutzer ist nicht erforderlich.

Der Dienst führt die vorhandene Agent-EXE unmittelbar und danach im gewählten Intervall nach Ende des letzten Laufs aus. Er benötigt Windows PowerShell, die Windows-CIM-/Netzwerk-Cmdlets und .NET Framework 4.x; Python wird auf dem Zielsystem nicht benötigt. Unter `LocalSystem` umfasst die benutzerspezifische Softwareinventur das Systemprofil, nicht die Profile angemeldeter Benutzer. Das tokenhaltige `C:\ProgramData\StatoFact\agent.conf` und das Dienstprotokoll `service.log` liegen in einem nur für Administratoren und SYSTEM zugänglichen Verzeichnis. Nach einer Konfigurationsänderung den Dienst neu starten. Beim Deinstallieren wird der Dienst entfernt; Konfiguration und Protokoll bleiben erhalten und müssen bei Bedarf manuell gelöscht werden.

Der Dienst ersetzt nicht automatisch eine zuvor mit `install-windows.ps1` eingerichtete geplante Aufgabe. Diese gegebenenfalls in der Windows-Aufgabenplanung deaktivieren oder entfernen, um doppelte Reports zu vermeiden. Durch den Wechsel zum Systemprofil können zuvor im Benutzerprofil inventarisierte Softwareinstallationen beim nächsten vollständigen Report aus der Host-Inventur entfernt werden. Der Installer ist nicht signiert. HTTPS wird empfohlen, damit das Token bei der Übertragung geschützt ist.

Den Installer unter Windows mit Inno Setup 7, Python, PyInstaller und dem .NET-Framework-C#-Compiler neu bauen:

```powershell
python -m pip install pyinstaller
.\agent\build-windows-setup.ps1
```

Falls Inno Setup an einem anderen Ort liegt, dessen Compilerpfad mit `-InnoCompiler` übergeben. Die ausführbaren Build-Ergebnisse liegen in `agent\dist`; bei Verwendung von Inno Setup sind dessen Lizenzbedingungen zu beachten.

### Einzelne EXE und geplante Aufgabe

Die eigenständige EXE wird unter Windows mit Python und PyInstaller gebaut:

```powershell
python -m pip install pyinstaller
.\agent\build-windows.ps1
```

Das Ergebnis liegt in `agent\dist\statofact-agent-windows.exe`. Die EXE enthält Python und benötigt auf dem Zielsystem keine Python-Installation; Windows PowerShell und die Windows-CIM-/Netzwerk-Cmdlets müssen verfügbar sein. Der Build ist für die Architektur des verwendeten Python-Interpreters bestimmt. Für die Verteilung können EXE und `install-windows.ps1` gemeinsam in einen Ordner kopiert werden.

Für den regelmäßigen Abruf PowerShell **als der Benutzer starten, unter dem der Agent laufen soll**, und im Projektordner ausführen:

```powershell
.\agent\install-windows.ps1 -ServerUrl "https://statofact.example"
```

Das Skript fragt das Server-Token verdeckt ab, legt die Konfiguration mit eingeschränkten Dateirechten im Benutzerprofil ab und richtet eine Windows-Aufgabe ein, die sofort und danach standardmäßig alle 15 Minuten läuft. Das Token wird nicht als Aufgabenargument übergeben. Mit `-IntervalMinutes 30` lässt sich das Intervall ändern. Der Installer verwendet bevorzugt die EXE neben dem Skript oder in `dist`; andernfalls die Python-Datei (dafür muss Python 3 über `python.exe` erreichbar sein). Mit `-AgentPath` kann eine bestimmte `.exe` oder `.py` gewählt werden. Die Aufgabe läuft im Kontext des installierenden Benutzers, solange dieser angemeldet ist; melden Sie den Benutzer ab, wird die Erfassung ausgesetzt und nach der nächsten Anmeldung fortgesetzt. Die Agent-Datei muss am registrierten Pfad bleiben.

Einen einzelnen Lauf bzw. die erfassten Daten vor dem Senden prüfen:

```powershell
.\agent\dist\statofact-agent-windows.exe --config "$env:LOCALAPPDATA\StatoFact\agent.conf" --dry-run
.\agent\dist\statofact-agent-windows.exe --config "$env:LOCALAPPDATA\StatoFact\agent.conf"
```

Das Installationsskript benötigt eine erreichbare StatoFact-URL und ein gültiges `AGENT_TOKEN` (mindestens 16 Zeichen) auf dem Server. Verwenden Sie für die Übertragung nach Möglichkeit HTTPS; der Agent sendet den Token als Bearer-Token.

**Netzwerkdaten** (Device/VirtualMachine): Der Agent liest per `ip -j` Schnittstellen (Name, MAC, Status, Geschwindigkeit, IPv4/IPv6 mit Prefix), Standard-Gateway und DNS-Server aus (virtuelle Schnittstellen wie `lo`, `docker*`, `veth*`, `br-*` werden ignoriert) und sendet sie als `network: {interfaces:[{name,mac,state,speedMbps,addresses:[{ip,prefix}]}], gateway, dns:[…]}`. Gespeichert in den Feldern `interfaces`, `gateway`, `dnsServers`; `managementIp` ist die erste IPv4 des Default-Route-Interfaces. Pro IPv4-Subnetz (Prefix 8–31) wird automatisch ein `Network`-CI (Name = CIDR) angelegt und per `member_of` (Attribut `ip`) verknüpft; veraltete automatisch erzeugte Beziehungen werden entfernt, manuell angelegte ohne `ip` bleiben. Nach einem Update einmal `npm run db:setup` ausführen (neue Felder).

**Debian-Pakete**: Auf Debian/Ubuntu liest der Agent installierte Pakete, Versionen, Architekturen und erfüllte `Depends`/`Pre-Depends` aus `dpkg-query` aus. Für jeden Paketnamen gibt es genau ein globales `Software`-CI, unabhängig von Version, Architektur und Host. Die einzelnen `SoftwarePackage`-CIs stellen dagegen Installationen dar und speichern Version, Architektur und Host. Sie sind über `installation_of` dem Software-CI, über `installed_on` dem Gerät bzw. der VM und über `depends_on` den installierten Abhängigkeiten zugeordnet. Beim nächsten Report werden Versionen aktualisiert und entfernte Installationen samt veralteten Beziehungen aus der Host-Inventur entfernt; das globale Software-CI bleibt bestehen. Der Report ist auf 5000 Installationen begrenzt.

**RPM-Pakete**: Auf RPM-basierten Systemen erfasst der Agent installierte Pakete mit Epoch, Version, Release und Architektur über `rpm`. Mehrere Versionen eines Pakets derselben Architektur werden gemeinsam im Versionsfeld der Installation aufgeführt. RPM-Abhängigkeiten werden noch nicht erfasst; bestehende Abhängigkeitsbeziehungen bleiben deshalb unverändert. RPM-Signaturschlüssel (`gpg-pubkey`) sind keine Softwareinstallationen und werden ausgelassen.

**Lauschende Services**: Der Agent erfasst mit `ss` lauschende TCP- und UDP-Sockets der lokalen Netzwerk-Namespace, einschließlich Bindungsadresse und Port. Er gruppiert Prozesse nach systemd-Service, ersatzweise Prozessname, und ordnet ihre ausführbaren Dateien über `dpkg-query -S` bzw. `rpm -qf` installierten Paket-CIs zu. Ein hostbezogenes `Service`-CI zeigt Bindungen und ausführbare Dateien; `service_on` verbindet es mit dem System und `provided_by` mit erkannten Softwareinstallationen. Vom Paket führt `installation_of` zum globalen Software-CI. Nicht eindeutig zuordenbare Listener bleiben ohne Paketbeziehung sichtbar; Socket-Aktivierung zeigt den tatsächlich lauschenden Prozess und nicht zwingend den späteren Dienst. Eine fehlende oder unlesbare Prozessdatei wird nicht geraten. Die Erfassung benötigt Root-Rechte (der installierte systemd-Dienst läuft standardmäßig als root); ohne diese wird das `services`-Feld ausgelassen und der bisherige Bestand nicht verändert. Schlägt `ss` fehl, wird der Report nicht gesendet. Beim nächsten vollständigen Report werden nicht mehr lauschende Services auf `Decommissioned` gesetzt und nur automatisch erfasste Paketbeziehungen entfernt; manuelle Beziehungen und CI-Daten bleiben erhalten.

Nach einem Update zuerst `npm run db:setup` und anschließend `npm run db:migrate-software` ausführen. Die Migration ergänzt Software-CIs und Zuordnungen für vorhandene Installationen, ohne deren IDs, Daten oder Beziehungen zu ändern. Sie kann erneut ausgeführt werden. Während der Migration sollten keine Agenten-Reports eintreffen; bei einem Fehler erneut ausführen. Für bestehende Referenzen bleibt der technische Typ `SoftwarePackage` erhalten, wird aber in der Oberfläche als „Softwareinstallation“ angezeigt. Das Agent-Reportformat bleibt unverändert.

Manuell: `statofact-agent --dry-run` zeigt die Daten, ohne zu senden. API: Header `Authorization: Bearer <AGENT_TOKEN>`, Body ein einzelnes `{"type","name",…Felder}` wie beim JSON-Import; Antworten 401 (Token falsch), 422 (Validierungsfehler), 503 (nicht konfiguriert). Ohne TLS wird das Token im Klartext übertragen, daher nur im vertrauenswürdigen Netz oder hinter HTTPS.

## Entwicklung

```bash
npm run dev
```

Die Anwendung ist unter [http://localhost:3000](http://localhost:3000) erreichbar, die Verbindung lässt sich unter [http://localhost:3000/api/db/health](http://localhost:3000/api/db/health) prüfen.

Für den Zugriff auf den Entwicklungsserver über die Netzwerkadresse ist `10.0.0.40` in `next.config.ts` unter `allowedDevOrigins` freigegeben. Ändert sich die Adresse oder wird ein Hostname verwendet, muss der Eintrag angepasst und der Entwicklungsserver neu gestartet werden. Nur vertrauenswürdige Entwicklungsadressen freigeben.

## Struktur

- `src/lib/arcadedb.ts`: ArcadeDB-HTTP-Client (`query`, `command`)
- `src/lib/model.ts`: Datenmodell (Typen, Felder, Beziehungsregeln)
- `src/lib/jobs/`: Jobrunner (`store.ts` Persistenz, `scheduler.ts` Ausführung, `handlers.ts` Job-Typen)
- `src/instrumentation.ts`: startet den Scheduler
- `src/lib/cmdb.ts`: CMDB-Datenzugriff mit Geschäftsregeln
- `src/app/actions.ts`: Server Actions mit Validierung
- `src/app/page.tsx`, `src/app/new/[type]/page.tsx`, `src/app/ci/[id]/page.tsx`: Liste, Anlegen, Detail
- `scripts/setup-db.mjs`: Schema-Setup und Migration (idempotent)

## Produktionsbuild

```bash
npm run build
npm start
```
