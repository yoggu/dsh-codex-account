// OAuth provider failures can contain token-response JSON, redirect URLs or codes.
// Do not copy an upstream exception into an HTTP response, command transcript or log.
const localFailures = new WeakSet()
const FALLBACK = 'Vorgang fehlgeschlagen; bitte erneut versuchen oder den Host-Status prüfen (Details können Zugangsdaten enthalten)'

export function safeError(error) {
  try {
    // Only errors created here may supply their own text. Upstream errors could
    // otherwise spoof a public safeMessage property (or even code/name fields).
    if (error !== null && typeof error === 'object' && localFailures.has(error)) return error.message
    const code = error?.code
    if (code === 'EACCES' || code === 'EPERM') return 'Zugriff auf Credential-Datei verweigert; Dateirechte prüfen'
    if (code === 'ENOENT') return 'Credential-Datei nicht gefunden'
    if (code === 'EADDRINUSE') return 'OAuth-Callback-Port bereits belegt'
    if (error?.name === 'AbortError') return 'Vorgang abgebrochen'
  } catch {
    // A provider can throw an object with getters; never stringify that object.
  }
  return FALLBACK
}

export function safeFailure(message) {
  const error = new Error(message)
  localFailures.add(error)
  return error
}
