export function authTokenFromLink(url: string | null, queryToken?: string | string[]) {
  const fromQuery = Array.isArray(queryToken) ? queryToken[0] : queryToken;
  let candidate = fromQuery || '';
  const fragment = url?.split('#', 2)[1] || '';
  const match = fragment.match(/(?:^|&)token=([^&]+)/);
  if (match?.[1]) {
    try { candidate = decodeURIComponent(match[1]); } catch { candidate = ''; }
  }
  return /^[0-9a-f]{64}$/i.test(candidate) ? candidate : null;
}
