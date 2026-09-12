# dsh-codex-account

OpenAI-Codex-Konten (ChatGPT-Abo) über OAuth im DeepSeek Harness — mit
ausdrücklicher Kontowahl.

## Warum es dieses Plugin gibt

Die ausgelieferte Composition mountet `ctx.authorization` nicht, den Seam für
Credential-Flows, und die Web-Oberfläche hat keine Seite, die einen Login
startet. `dsh-llm-pi-ai` registriert seinen Login-Flow deshalb nie — und der
Codex-Provider ist in pi-ais Katalog der eine Provider, der ausschließlich per
OAuth authentisiert. Genau diese Lücke schließt das Plugin, ohne `settings.yaml`
anzufassen und ohne eine Zeile am Harness zu ändern.

## Was es tut

| Teil | Wirkung |
| --- | --- |
| `AccountStore` | `$DSH_HOME/codex-accounts.json` (`0600`, atomar, Dateisperre) hält ein Credential **je Account-Id** — ein persönliches und ein geschäftliches Konto stören sich nicht. |
| `login` / `import` / `status` / `logout` | Der OAuth-Flow kommt aus `@earendil-works/pi-ai` (PKCE, Callback auf `localhost:1455`, Device-Code). Nichts davon ist nachgebaut. |
| `CodexAccountAdapter` | Registriert je Konto eine Route als `LlmAdapter` auf `ctx.llm`: Codex-Modelle, Kontextgrößen, Denkstufen. |
| `/codex` | Mensch-Befehl im Web-GUI: `login`, `import`, `status`, `logout`. |
| `lib/login-cli.mjs` | Derselbe Code ohne laufenden Harness — headless und für den Login ohne Neustart. |
| `client.js` + `lib/control.js` | Eigene Seite **Settings → OpenAI Codex**: Konto-Id, Tarif, Token-Ablauf und die Knöpfe Anmelden, Aus Codex CLI übernehmen, Abmelden. |

## Die Einstellungsseite

`client.js` ist handgeschrieben im `window.__ModuleLoader__.load`-Format, ohne
JSX und ohne Bundler, und registriert sich in `settings.section` mit
`order: 11` — direkt hinter „Models".

Warum eine eigene Seite und keine Karte in der Model-Liste: der Slot
`settings.models.provider-card` wird mit `entryKey = settingsNs` **je
Verzeichnis-Eintrag** ausgeliefert, kann also nur Routen erweitern, die aus
`settings.yaml` verwaltet werden. Diese Route wird von der Composition
registriert; sie erscheint im Modellwähler, nicht in der Model-Liste.

Der Browser spricht über eine JSON-Route mit dem Host —
`/api/codex-account/control` (GET liest den Zustand, POST löst Aktionen aus).
Sie hängt an `connection.fetch.register`, **nicht** direkt am `webServer`: eine
Fetch-Route auf dem geteilten `/api`-Kanal wird laut Vertrag erst *nach* der
Vertrauens- und Authentisierungsprüfung des Trägers aufgerufen. Eine direkt
registrierte Route wäre ohne Sitzung erreichbar und würde Konto-Id und Tarif
herausgeben. Verifiziert: ohne Sitzungscookie antwortet die Route `401`.

Der Login läuft asynchron: der POST kehrt sofort zurück, die Karte fragt alle
zwei Sekunden den Zustand ab und zeigt währenddessen die Autorisierungs-URL als
Link. Ein Token wird nie an den Browser gegeben.

### Warum aus dem GUI kein Systembrowser geöffnet wird

`login()` öffnet den Desktop-Browser nur, wenn der Aufrufer `openBrowser: true`
setzt — das tut allein die CLI. Die Steuerroute setzt es **nicht**.

Der Grund ist ein realer Fehler der ersten Fassung: `xdg-open` startete aus dem
Web-GUI heraus Browserfenster mit frischem Profil auf dem Desktop des Nutzers.
Wer im Web-GUI klickt, ist bereits in einem Browser; die Karte zeigt die URL
stattdessen als Link mit `target="_blank"`.

### Port 1455 gehört dem Login

Der OAuth-Callback bindet `127.0.0.1:1455`. Läuft bereits eine zweite
Harness-Instanz, hält sie den Port und ein Login scheitert mit
„Address already in use" — deshalb ist eine Testinstanz auf einem anderen
`--port` **kein** ausreichendes Isolationsmittel für diesen Flow.

### Theme-Tokens — der Fehler der ersten Fassung

Das CSS benutzt ausschließlich `--dsw-alias-*`, die Alias-Ebene des Harness.
Die erste Fassung hatte eigene Hex-Werte mit `var(--text-primary, #202124)`
als Rückfall: den Token-Namen gibt es nicht, also griff immer der Rückfall und
die Seite rendete im dunklen Theme mit den Farben eines hellen Layouts.

Die echten Namen liefert `Theme.listTokens`; die hier benutzten:

| Zweck | Token |
| --- | --- |
| Text | `--dsw-alias-label-primary` / `-secondary` / `-tertiary` / `-caption` |
| Flächen | `--dsw-alias-bg-layer-1` (Karte), `-2` (Knopf) |
| Rahmen | `--dsw-alias-border-l1` / `-l2` |
| Zustand | `--dsw-alias-state-success-primary`, `-error-primary`, `-warn-primary` |
| Knopf | `--dsw-alias-button-primary-fill`, `-hover`, `--dsw-alias-label-primary-foreground` |

Ein erfundener Token-Name scheitert **nicht** — er fällt still auf einen
Browser-Default durch. Deshalb ist jeder benutzte Name gegen das Theme-Paket
geprüft und nicht aus dem Gedächtnis geschrieben.

## Welche Modelle ein ChatGPT-Konto wirklich bedient

pi-ais Modellkatalog ist die **Obermenge**. Gegen ein persönliches Plus-Konto
durchprobiert:

| Modell | Ergebnis |
| --- | --- |
| `gpt-6-astra`, `gpt-5.6-terra`, `gpt-5.6-sol`, `gpt-5.6-luna`, `gpt-5.5` | bedient |
| `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex-spark` | abgelehnt: „is not supported when using Codex with a ChatGPT account“ |

Die Vorgabe `models` listet deshalb nur die bedienten fünf. `models: []` hebt
den Filter auf und bietet den ganzen Katalog an — für Konten, die mehr dürfen.
Ein abgelehntes Modell kommt als `UNSUPPORTED_MODEL` zurück, nicht als
generische 400.

Bild-Eingabe ist in dieser Fassung abgeschaltet (`readImages: false`): die
Route führt Text und provider-neutrale Historie. Der Harness ersetzt Bilder in
einer text-only-Route durch einen Platzhalter, statt die Anfrage scheitern zu
lassen.

## Installation

```sh
dsh plugin --profile web add /pfad/zu/dsh-codex-account
```

Das Paket bringt sein eigenes `cordis.patch.yml` mit; `dsh` komponiert es über
`dsh.bundle.patch` als eigene Ebene. Ein Neustart des Profils lädt die Zeile.

## Anmelden

Ohne Neustart, mit demselben Store, den die Route liest:

```sh
node lib/login-cli.mjs login personal            # Browser-Flow
node lib/login-cli.mjs login personal --device   # headless
node lib/login-cli.mjs status
node lib/login-cli.mjs logout personal
```

Im laufenden Harness: `/codex login personal`.

**Wichtig bei zwei Abonnements:** im Browser das richtige Konto wählen. Der
Login zeigt danach Konto-Id und Tarif aus dem Token an — damit ist
nachprüfbar, welches Konto verbunden wurde.

`import` übernimmt einen vorhandenen Codex-CLI-Login (`~/.codex/auth.json`)
ohne Browser. Der Refresh-Token ist danach zwischen der CLI und diesem Plugin
geteilt; die CLI rotiert ihn bei ihrer nächsten Erneuerung. Für einen eigenen,
unabhängigen Token-Bestand ist der Browser-Login der richtige Weg.

## Konfiguration

Die Zeile ist über eine spätere Patch-Ebene (das Profil-`cordis.patch.yml`)
überschreibbar; eine Patch-Zeile ersetzt die `config` vollständig.

```yaml
- insert:
    - id: codex-account
      name: 'dsh-codex-account'
      config:
        accounts:
          - id: personal
            provider: codex-personal
            displayName: 'Codex (persönlich)'
          - id: business
            provider: codex-business
            displayName: 'Codex (geschäftlich)'
        transport: sse          # sse | websocket | websocket-cached | auto
        cacheRetention: long    # none | short | long
        readImages: false
        models:                 # leer = ganzer pi-ai-Katalog
          - gpt-6-astra
          - gpt-5.6-sol
        streamIdleTimeoutMs: 300000
```

Jedes Konto braucht eine eigene `provider`-Route: der Harness adressiert einen
Modellaufruf über `provider`/`model`, und die Route ist damit die
Auswahlfläche im Model-Picker.

## Fehlerbilder

| Meldung | Bedeutung |
| --- | --- |
| `INVALID_CREDENTIAL` mit „Could not parse your authentication token“ | Der Access-Token ist ungültig oder abgelaufen und ließ sich nicht erneuern — neu anmelden. |
| `INVALID_CREDENTIAL` mit „provider is not configured“ | Für diesen Account liegt kein Credential im Store. |
| `UNKNOWN_MODEL` | Das Modell steht nicht im pi-ai-Katalog dieser Installation **oder** ist durch `models` ausgefiltert. |
| `UNSUPPORTED_MODEL` | Der Katalog kennt das Modell, das Codex-Backend bedient es für dieses Konto aber nicht. |
| `UNSUPPORTED_CONTENT` | Die Historie enthält Bild-Blöcke; `readImages: false`. |
| `TIMEOUT` | Kein Provider-Ereignis innerhalb von `streamIdleTimeoutMs`. |
| „Credential-Datei ist für andere Benutzer lesbar“ | `chmod 600` auf `$DSH_HOME/codex-accounts.json`. |

## Abhängigkeiten

Alle Laufzeit-Abhängigkeiten sind `peerDependencies` und werden vom
Harness-Baum gedeckt: `@deepseek-ai/{cordis,dsh-llm,dsh-timeout,dsh-home-paths,dsh-atomic-write,dsh-commands,schemastery}`
und `@earendil-works/pi-ai`. `dsh-commands` ist optional — ohne das
Kommando-Flugzeug lädt das Plugin weiterhin und meldet einen fehlenden Login
nur ins Log. `@deepseek-ai/dsh-client-connection` ist ebenfalls optional: ohne
den Service mountet das Plugin, nur ohne Einstellungsseite.

### Entwicklung

Weil alle Abhängigkeiten Peers sind, löst Node sie beim direkten Aufruf aus
diesem Verzeichnis nicht auf. Für lokale Tests genügen Symlinks auf den
Harness-Baum:

```sh
DSH_NM=~/.local/share/mise/installs/node/24.16.0/lib/node_modules/@deepseek-ai/dsh/node_modules
for p in @earendil-works/pi-ai @deepseek-ai/dsh-llm @deepseek-ai/dsh-timeout \
         @deepseek-ai/dsh-home-paths @deepseek-ai/dsh-atomic-write \
         @deepseek-ai/schemastery @deepseek-ai/cordis @deepseek-ai/dsh-commands \
         @deepseek-ai/dsh-client-connection; do
  mkdir -p "node_modules/$(dirname "$p")"
  ln -sfn "$DSH_NM/$p" "node_modules/$p"
done
```

`node_modules/` ist in `.gitignore`; nach einem Harness-Update müssen die
Symlinks neu gesetzt werden.

## Lizenz

MIT. Die Konvertierung zwischen Harness- und pi-ai-Vokabular
(`lib/convert.js`) folgt dem Aufbau von `@deepseek-ai/dsh-llm-pi-ai`
(MIT, © DeepSeek AI).
