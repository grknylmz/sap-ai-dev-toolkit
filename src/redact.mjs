// Shared credential redaction for every diagnostic lane (stderr, MCP log
// notifications, tool errors, relay responses). One implementation so a fix
// applies everywhere; the old per-file copies each missed a different case.
//
// Covered patterns:
// - authorization: Basic <base64> / Bearer <token> / proxy-authorization
// - cookie: a=b; c=d (the whole pair list, not just the first pair)
// - password=... / secret=... / token=... / x-csrf-token: ... style keys
// - URLs with embedded userinfo, https://user:pass@host
// Bare credential blobs without a recognizable key cannot be detected
// generically and are out of scope.
const URL_USERINFO = /([a-z][a-z0-9+.-]*:\/\/)([^\s/@:?=&]+):([^\s/@]+)@/gi;
const NAMED_VALUE = /((?:proxy-)?authorization|cookie|passwd|password|secret|token)\s*[:=]\s*(?:bearer\s+|basic\s+)?[^\s,;"']+/gi;
// Header-shaped values may carry lists (cookie pairs); after the first pass
// redacts the leading pair, this pass drops the remainder of the line.
const HEADER_TAIL = /^((?:proxy-)?authorization|cookie)\s*[:=].*$/gim;

export function redactText(value) {
  return String(value ?? '')
    .replace(URL_USERINFO, '$1[redacted]@')
    .replace(NAMED_VALUE, '$1=[redacted]')
    .replace(HEADER_TAIL, '$1=[redacted]');
}

// Redact, collapse whitespace, and clamp to a diagnostic-friendly length.
export function diagnosticText(value, limit = 500) {
  return redactText(value?.message || value || 'unknown error').replace(/\s+/g, ' ').trim().slice(0, limit);
}
