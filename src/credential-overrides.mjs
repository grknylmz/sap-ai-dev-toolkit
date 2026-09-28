import { readCredentials, resolveCredentialsPath } from './credentials-store.mjs';

const CLOUD_FOUNDRY_KEY_PREFIX = 'cloud-foundry:';

function isBasicAuthentication(value) {
  return /^basic(?:authentication)?$/i.test(String(value || '').replace(/\s+/g, ''));
}

export function credentialKeyForDestination(destination = {}) {
  if (destination.source === 'cloud-foundry') {
    const serverName = String(destination.serverName || '').trim();
    return serverName ? `${CLOUD_FOUNDRY_KEY_PREFIX}${serverName}` : '';
  }
  return String(destination.name || '').trim();
}

export function credentialModeForDestination(destination = {}) {
  if (!isBasicAuthentication(destination.authentication)) return null;
  const proxyType = String(destination.proxyType || '').trim().toLowerCase();
  if (destination.source === 'cloud-foundry') {
    return proxyType === 'onpremise' ? 'cf-connectivity' : null;
  }
  if (proxyType === 'internet') return 'direct';
  if (proxyType === 'onpremise') return 'bas-tunnel';
  return null;
}

export function canPromptForCredentials(destination = {}) {
  const mode = credentialModeForDestination(destination);
  return Boolean(mode && (mode !== 'direct' || destination.backendUrl));
}

export async function enrichWithStoredCredentials(destinations, env = process.env, log = message => console.error(message)) {
  const needingCredentials = destinations.filter(destination => {
    const mode = credentialModeForDestination(destination);
    if (!mode || !canPromptForCredentials(destination)) return false;
    if (mode === 'cf-connectivity') return Boolean(destination.serverName);
    return Boolean(destination.url && String(destination.url).includes('.dest'));
  });
  if (!needingCredentials.length) return destinations;
  let stored;
  try {
    const path = await resolveCredentialsPath(env);
    stored = await readCredentials(path);
  } catch (error) {
    log(`[sap-ai-dev] stored credentials could not be read: ${String(error.message).slice(0, 200)}`);
    return destinations;
  }
  return destinations.map(destination => {
    const mode = credentialModeForDestination(destination);
    const key = credentialKeyForDestination(destination);
    const entry = key ? stored.destinations?.[key] : undefined;
    if (!mode || !entry?.user || !entry?.password) return destination;
    if (mode === 'cf-connectivity') {
      if (entry.mode !== mode || destination.source !== 'cloud-foundry') return destination;
      return {
        ...destination,
        childEnv: {
          ...(destination.childEnv || {}),
          SAP_USER: entry.user,
          SAP_PASSWORD: entry.password,
          SAP_VERBOSE: 'false'
        }
      };
    }
    if (mode === 'bas-tunnel') {
      if (entry.mode !== mode) return destination;
      return { ...destination, credentials: { user: entry.user, password: entry.password, mode } };
    }
    if (!destination.backendUrl || !destination.url || !String(destination.url).includes('.dest')) return destination;
    if (entry.mode && entry.mode !== 'direct') return destination;
    const host = entry.host || destination.backendUrl;
    return { ...destination, credentials: { host, user: entry.user, password: entry.password, mode: 'direct' } };
  });
}