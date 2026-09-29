window.__ModuleLoader__.load({
  id: 'dsh-codex-account',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const URL_PATH = '/api/dsh-codex-account';
    const dict = {
      en: { title: 'Codex Account', summary: 'Manage your ChatGPT sign-in for Codex.',
        intro: 'Use your ChatGPT subscription with Codex models. Sign in securely through OpenAI to get started.',
        description: 'Your sign-in is stored by llm-pi-ai. This page never sees your credentials or sends a model request.',
        start: 'Sign in with ChatGPT', again: 'Sign in again', waiting: 'Waiting for authorization…', configuring: 'Adding openai-codex to Models…',
        open: 'Open sign-in page', code: 'Enter this code on that page:', answer: 'Submit response',
        cancel: 'Cancel sign-in', complete: 'Signed in; openai-codex is available in Models.',
        cancelled: 'Sign-in cancelled.', failed: 'Sign-in failed', absent: 'OAuth flow unavailable.',
        present: 'Signed in', missing: 'Not signed in', pending: 'Signing in',
        provider: 'Available in Models', noProvider: 'Not added yet',
        addProvider: 'Add to Models', providerFailed: 'Sign-in was saved, but the provider could not be added. Retry below.',
        prompt: 'Response', checking: 'Checking status…', unavailable: 'Status unavailable.', retry: 'Retry',
        authentication: 'Authentication', modelProvider: 'Model provider', storage: 'Credential storage',
        signout: 'Sign out', signingOut: 'Signing out…', signedOut: 'Signed out of ChatGPT on this host.',
        signoutNote: 'Sign-out removes the saved sign-in from this host. Your model configuration is kept.',
        externalFlow: 'A sign-in is already running. Finish or cancel it before changing this account.',
      },
      de: { title: 'Codex-Konto', summary: 'ChatGPT-Anmeldung für Codex verwalten.',
        intro: 'Nutze dein ChatGPT-Abonnement mit Codex-Modellen. Melde dich dafür sicher über OpenAI an.',
        description: 'Die Anmeldung wird von llm-pi-ai gespeichert. Diese Seite sieht keine Zugangsdaten und sendet keine Modellanfragen.',
        start: 'Mit ChatGPT anmelden', again: 'Erneut anmelden', waiting: 'Warte auf Autorisierung…', configuring: 'openai-codex wird zu Modelle hinzugefügt…',
        open: 'Anmeldeseite öffnen', code: 'Diesen Code dort eingeben:', answer: 'Antwort senden',
        cancel: 'Anmeldung abbrechen', complete: 'Angemeldet; openai-codex ist unter Modelle verfügbar.',
        cancelled: 'Anmeldung abgebrochen.', failed: 'Anmeldung fehlgeschlagen', absent: 'OAuth-Flow nicht verfügbar.',
        present: 'Angemeldet', missing: 'Nicht angemeldet', pending: 'Anmeldung läuft',
        provider: 'Unter Modelle verfügbar', noProvider: 'Noch nicht hinzugefügt',
        addProvider: 'Zu Modelle hinzufügen', providerFailed: 'Die Anmeldung wurde gespeichert, aber der Anbieter konnte nicht hinzugefügt werden. Bitte erneut versuchen.',
        prompt: 'Antwort', checking: 'Status wird geprüft…', unavailable: 'Status nicht verfügbar.', retry: 'Erneut versuchen',
        authentication: 'Anmeldung', modelProvider: 'Modellanbieter', storage: 'Speicherung der Zugangsdaten',
        signout: 'Abmelden', signingOut: 'Abmeldung läuft…', signedOut: 'Auf diesem Host von ChatGPT abgemeldet.',
        signoutNote: 'Beim Abmelden wird die gespeicherte Anmeldung auf diesem Host entfernt. Die Modellkonfiguration bleibt erhalten.',
        externalFlow: 'Eine Anmeldung läuft bereits. Schließe sie ab oder brich sie ab, bevor du dieses Konto änderst.',
      },
    };
    const CSS = `
      .codexAccount{max-width:720px;margin-top:16px;padding-bottom:24px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.6}
      .codexAccount *{box-sizing:border-box}
      .codexAccountIntro{margin:0 0 20px;color:var(--dsw-alias-label-secondary);line-height:1.75}
      .codexAccountCard{overflow:hidden;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-layer-1)}
      .codexAccountHead{display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:14px;padding:18px 20px 16px;border-bottom:1px solid var(--dsw-alias-border-l1)}
      .codexAccountIdentity{display:flex;align-items:center;gap:12px;min-width:0}
      .codexAccountIcon{display:grid;place-items:center;flex:none;width:40px;height:40px;border:1px solid var(--dsw-alias-border-l1);border-radius:11px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
      .codexAccountName{margin:0;font-size:15px;line-height:1.4;font-weight:650}
      .codexAccountMeta{margin:4px 0 0;color:var(--dsw-alias-label-tertiary);font-size:12px;overflow-wrap:anywhere}
      .codexAccountBadge{display:inline-flex;align-items:center;gap:7px;white-space:nowrap;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:4px 10px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}
      .codexAccountBadge.on{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
      .codexAccountBadge.wait{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}
      .codexAccountDot{width:7px;height:7px;border-radius:50%;background:currentColor;flex:none}
      .codexAccountBody{padding:20px}
      .codexAccountGrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px 24px;margin:0}
      .codexAccountRow{display:flex;flex-direction:column;gap:5px;min-width:0}
      .codexAccountKey{font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:var(--dsw-alias-label-caption)}
      .codexAccountValue{margin:0;font-size:14px;line-height:1.5;overflow-wrap:anywhere}
      .codexAccountSubvalue{display:block;margin-top:2px;color:var(--dsw-alias-label-tertiary);font-size:12px}
      .codexAccountActions{display:flex;flex-wrap:wrap;gap:9px;margin-top:22px}
      .codexAccountButton{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:36px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);padding:8px 14px;font-family:inherit;font-size:13px;font-weight:600;line-height:1.3;cursor:pointer;transition:background .15s,border-color .15s}
      .codexAccountButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
      .codexAccountButton:disabled{opacity:.45;cursor:not-allowed}
      .codexAccountButton.primary{border-color:var(--dsw-alias-button-primary-fill);background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
      .codexAccountButton.primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);border-color:var(--dsw-alias-button-primary-hover)}
      .codexAccountButton.danger{color:var(--dsw-alias-state-error-primary)}
      .codexAccountButton:focus-visible,.codexAccountInput:focus-visible,.codexAccountLink:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px}
      .codexAccountNote,.codexAccountError{margin:16px 0 0;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:11px 13px;color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:1.7;overflow-wrap:anywhere}
      .codexAccountError{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
      .codexAccountNote p{margin:0 0 6px}.codexAccountNote p:last-child{margin-bottom:0}
      .codexAccountLink{color:var(--dsw-alias-brand-primary);text-decoration:underline;overflow-wrap:anywhere}
      .codexAccountCode{display:inline-block;margin:8px 0 0;padding:5px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:15px;letter-spacing:.08em;user-select:all}
      .codexAccountForm{display:grid;gap:10px;margin-top:16px}.codexAccountForm button{justify-self:start}
      .codexAccountInput{display:block;width:100%;margin-top:6px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:9px 11px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit}
      .codexAccountFooter{padding:13px 20px;border-top:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.7}
      .codexAccountHint{margin:12px 0 0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.7}
      @media(max-width:620px){.codexAccountGrid{grid-template-columns:1fr}.codexAccountHead,.codexAccountBody{padding:16px}.codexAccountFooter{padding:12px 16px}}
    `;
    function Icon({ signout = false }) {
      return h('svg', { width: signout ? 15 : 22, height: signout ? 15 : 22, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        ...(signout
          ? [h('path', { key: 'door', d: 'M9 5H5v14h4M13 8l4 4-4 4M9 12h12' })]
          : [h('path', { key: 'left', d: 'm8 7-5 5 5 5' }), h('path', { key: 'right', d: 'm16 7 5 5-5 5' }),
              h('path', { key: 'slash', d: 'm14 4-4 16' })]));
    }
    async function request(method, body, id) {
      const endpoint = id ? `${URL_PATH}?id=${encodeURIComponent(id)}` : URL_PATH;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12000);
      try {
        const response = await fetch(endpoint, { method, credentials: 'include', cache: 'no-store', signal: controller.signal,
          ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
        const data = await response.json();
        if (!response.ok) throw new Error(data?.error || 'request-failed');
        return data;
      } finally { clearTimeout(timer); }
    }
    function LoginPage({ ctx }) {
      const locale = React.useSyncExternalStore(ctx.locale.subscribe.bind(ctx.locale), ctx.locale.getSnapshot.bind(ctx.locale));
      const t = dict[locale.active] || dict.en;
      const [ready, setReady] = React.useState(null);
      const [attempt, setAttempt] = React.useState(null);
      const [answer, setAnswer] = React.useState('');
      const [error, setError] = React.useState('');
      const [busy, setBusy] = React.useState('');
      const id = attempt?.id;
      const refresh = () => request('GET').then(setReady, () => setError(t.unavailable));
      React.useEffect(() => {
        let live = true;
        request('GET').then(value => { if (live) setReady(value); }, () => { if (live) setError(t.unavailable); });
        return () => { live = false; };
      }, []);
      React.useEffect(() => {
        if (!id || !['pending', 'configuring'].includes(attempt?.status)) return;
        let live = true;
        const timer = setInterval(() => request('GET', null, id).then(value => {
          if (!live) return;
          setAttempt({ id, ...value });
          if (value.status === 'authorized' || value.status === 'provider-error')
            request('GET').then(next => { if (live) setReady(next); }, () => {});
        }, () => { if (live) setError(t.unavailable); }), 1200);
        return () => { live = false; clearInterval(timer); };
      }, [id, attempt?.status]);
      const action = async body => {
        setError(''); setBusy(body.action);
        try {
          const next = await request('POST', body);
          if (body.action === 'start') setAttempt(next);
          else if (body.action === 'ensure-provider') { setReady(value => ({ ...value, providerPresent: next.providerPresent })); setAttempt(null); }
          else if (body.action === 'sign-out') {
            setAttempt(next); setAnswer('');
            setReady(value => ({ ...value, credentialPresent: false, inFlight: false }));
            await refresh();
          } else setAttempt({ id, ...next });
          if (body.action === 'answer') setAnswer('');
          if (next.status === 'authorized' || next.status === 'provider-error' || next.status === 'cancelled') await refresh();
        } catch (cause) { setError(cause.message || 'request-failed'); }
        finally { setBusy(''); }
      };
      const pending = attempt?.status === 'pending';
      const configuring = attempt?.status === 'configuring';
      const active = pending || configuring;
      const prompt = attempt?.prompt;
      const connected = !!ready?.credentialPresent;
      const blocked = !!busy || !!ready?.inFlight;
      const badge = active ? t.pending : ready ? connected ? t.present : t.missing : t.checking;
      const row = (label, value, subvalue) => h('div', { className: 'codexAccountRow' },
        h('dt', { className: 'codexAccountKey' }, label),
        h('dd', { className: 'codexAccountValue' }, value,
          subvalue && h('span', { className: 'codexAccountSubvalue' }, subvalue)));
      const button = (label, onClick, disabled, variant = '') => h('button', {
        type: 'button', className: `codexAccountButton ${variant}`, disabled: !!disabled, onClick,
      }, label);
      return h('section', { className: 'codexAccount', 'aria-label': t.title },
        h('style', null, CSS),
        h('p', { className: 'codexAccountIntro' }, t.intro),
        h('div', { className: 'codexAccountCard' },
          h('div', { className: 'codexAccountHead' },
            h('div', { className: 'codexAccountIdentity' },
              h('span', { className: 'codexAccountIcon' }, h(Icon)),
              h('div', null, h('h3', { className: 'codexAccountName' }, 'OpenAI Codex'),
                h('p', { className: 'codexAccountMeta' }, 'ChatGPT · openai-codex'))),
            h('span', { className: `codexAccountBadge${active ? ' wait' : connected ? ' on' : ''}`, role: 'status' },
              h('span', { className: 'codexAccountDot', 'aria-hidden': true }), badge)),
          h('div', { className: 'codexAccountBody' },
            h('dl', { className: 'codexAccountGrid' },
              row(t.authentication, ready ? connected ? t.present : t.missing : t.checking, `${t.storage}: llm-pi-ai`),
              row(t.modelProvider, ready ? ready.providerPresent ? t.provider : t.noProvider : t.checking, 'openai-codex')),
            !active && h('div', { className: 'codexAccountActions' },
              connected && !ready.providerPresent && button(t.addProvider, () => action({ action: 'ensure-provider' }), blocked, 'primary'),
              button(connected ? t.again : t.start, () => action({ action: 'start' }), blocked || !ready?.flowAvailable,
                connected ? '' : 'primary'),
              connected && button(h(React.Fragment, null, h(Icon, { signout: true }), busy === 'sign-out' ? t.signingOut : t.signout),
                () => action({ action: 'sign-out' }), blocked, 'danger')),
            connected && !active && h('p', { className: 'codexAccountHint' }, t.signoutNote),
            ready && !ready.flowAvailable && h('p', { className: 'codexAccountNote', role: 'status' }, t.absent),
            ready?.inFlight && !active && h('p', { className: 'codexAccountNote', role: 'status' }, t.externalFlow),
            configuring && h('p', { className: 'codexAccountNote', role: 'status' }, t.configuring),
            pending && h(React.Fragment, null,
              h('p', { className: 'codexAccountNote', role: 'status' }, t.waiting),
              ...(attempt.notices || []).map((item, index) => h('div', { key: index, className: 'codexAccountNote' },
                h('p', null, item.message),
                item.url && h('a', { href: item.url, target: '_blank', rel: 'noopener noreferrer', className: 'codexAccountLink' }, t.open),
                item.code && h('p', null, t.code, h('br'), h('code', { className: 'codexAccountCode' }, item.code)))),
              prompt && h('form', { onSubmit: event => { event.preventDefault(); action({ action: 'answer', id, value: answer }); },
                className: 'codexAccountForm' },
                h('label', null, prompt.message || t.prompt,
                  prompt.kind === 'select'
                    ? h('select', { value: answer, onChange: event => setAnswer(event.target.value), className: 'codexAccountInput' },
                        h('option', { value: '' }, '—'),
                        ...(prompt.options || []).map(option => h('option', { key: option.id, value: option.id }, option.label)))
                    : h('input', { type: prompt.kind === 'secret' ? 'password' : 'text',
                        autoComplete: 'off', value: answer, placeholder: prompt.placeholder,
                        onChange: event => setAnswer(event.target.value), className: 'codexAccountInput' })),
                h('button', { type: 'submit', className: 'codexAccountButton primary', disabled: !!busy || !answer }, t.answer)),
              h('div', { className: 'codexAccountActions' },
                button(t.cancel, () => action({ action: 'cancel', id }), busy))),
            ['authorized', 'cancelled', 'signed-out'].includes(attempt?.status) &&
              h('p', { className: 'codexAccountNote', role: 'status' },
                attempt.status === 'authorized' ? t.complete : attempt.status === 'signed-out' ? t.signedOut : t.cancelled),
            attempt?.status === 'provider-error' && h('p', { className: 'codexAccountError', role: 'alert' }, t.providerFailed),
            attempt?.status === 'failed' && h('p', { className: 'codexAccountError', role: 'alert' }, `${t.failed}: ${attempt.error}`),
            error && h('p', { className: 'codexAccountError', role: 'alert' }, error),
            error && h('div', { className: 'codexAccountActions' }, button(t.retry, () => { setError(''); refresh(); }, busy))),
          h('div', { className: 'codexAccountFooter' }, t.description)));
    }
    return { inject: ['slots', 'locale'], apply(ctx) {
      const t = () => (dict[ctx.locale.getSnapshot().active] || dict.en);
      function Entry({ view }) { return view === 'summary' ? t().summary : h(LoginPage, { ctx }); }
      ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
        name: 'plugins.bundle.config', key: 'dsh-codex-account',
      }, Entry));
    } };
  },
});
