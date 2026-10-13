# AKARI-Brücke

Verbindet dein Home Assistant mit AKARI, ohne dass Home Assistant aus dem Internet
erreichbar sein muss: kein Tunnel, keine Portfreigabe, keine eigene Domain.

## So funktioniert es

Die Brücke baut von deinem Home Assistant aus eine verschlüsselte Verbindung **nach draußen**
zu AKARI auf und fragt dort laufend, ob es etwas zu tun gibt. AKARI kann deshalb Lampen schalten
und Werte lesen, obwohl niemand von außen an dein Home Assistant herankommt.

Die Brücke darf nur:

- Zustände und Grundeinstellungen lesen (Lampen, Sensoren, Fenster, Heizung …)
- Bereiche, Geräte und Entitäten lesen (für die Räume in AKARI)
- Lampen ein- und ausschalten und dimmen
- Szenen auslösen

Alles andere lehnt sie ab, zum Beispiel Schlösser, Alarmanlagen, Automationen oder den Verlauf,
auch wenn AKARI danach fragen sollte.

## Einrichten

1. In AKARI: **Einstellungen → Verbindungen → Home Assistant → Brücke einrichten**.
   AKARI zeigt dir einen Kopplungscode (beginnt mit `akb_`). Er wird nur einmal angezeigt.
2. Hier im Add-on unter **Konfiguration**:
   - **AKARI-Adresse**: die Adresse deines AKARI, z. B. `https://akari.lucidian.dev`
   - **Kopplungscode**: den Code aus AKARI einfügen
3. **Speichern** und das Add-on **starten**.

Im **Protokoll** steht danach „Verbunden mit …“, und AKARI springt von selbst auf „verbunden“.

## Häufige Meldungen

| Meldung im Protokoll | Was tun |
|---|---|
| „AKARI kennt diesen Kopplungscode nicht (mehr)“ | In AKARI einen neuen Code erzeugen und hier eintragen. Ein neuer Code macht den alten ungültig. |
| „Keine Verbindung zu AKARI …“ | Internet weg oder AKARI gerade nicht erreichbar. Die Brücke versucht es von selbst weiter. |
| „Nicht gestartet: …“ | Adresse oder Code fehlt oder ist falsch eingetragen. |

## Trennen

In AKARI auf **Trennen**: Der Code gilt sofort nicht mehr. Danach kannst du das Add-on stoppen
oder deinstallieren.

## Ohne Add-ons (Home Assistant Container)

Die Brücke läuft auch eigenständig mit Node.js 22 oder neuer, z. B. auf demselben Rechner:

```
AKARI_SERVER=https://akari.lucidian.dev \
AKARI_CODE=akb_… \
HA_URL=http://localhost:8123 \
HA_TOKEN=<langlebiges Zugriffstoken> \
node bridge.mjs
```

Das Token erstellst du in Home Assistant unter Profil → Sicherheit → Langlebige Zugriffstoken.
