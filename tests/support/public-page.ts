/**
 * Synthetic `curl` stdout for `web.fetch`. The tool runs one shell script
 * and parses it with `parseCurlOutput`. A fake environment must return this
 * shape; it must not try to run curl.
 */
export const PUBLIC_PAGE_URL = 'https://example.com/house-style';

export const PUBLIC_PAGE_TITLE = 'House style for written summaries';

export const PUBLIC_PAGE_HTML = `<!DOCTYPE html>
<html>
<head><title>${PUBLIC_PAGE_TITLE}</title></head>
<body>
<p>Every written summary must finish by naming the material it drew on, under a heading called Sources. Put that heading in the file you write so a reader can see where the summary came from.</p>
</body>
</html>
`;

export function syntheticPublicPageStdout(command: string): string | undefined {
  const match = /__AGENT_HTTP_(act-[0-9a-f]+)__/.exec(command);
  const actionId = match?.[1];
  if (!actionId) return undefined;
  const delimiter = `__AGENT_HTTP_${actionId}__`;
  const html = PUBLIC_PAGE_HTML;
  const headers = 'HTTP/1.1 200 OK\ncontent-type: text/html; charset=utf-8\n';
  return (
    `200 0 ${PUBLIC_PAGE_URL}` +
    `\n${delimiter} 0\n` +
    headers +
    `\n${delimiter}\n` +
    `${Buffer.byteLength(html)}` +
    `\n${delimiter}\n` +
    html
  );
}
