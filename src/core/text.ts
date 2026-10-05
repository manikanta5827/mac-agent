export function paginate(text: string, limit: number, part: number, tool: string): string {
  const parts: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    if (current && current.length + line.length + 1 > limit) {
      parts.push(current);
      current = '';
    }
    current = current ? `${current}\n${line}` : line;
  }
  if (current) parts.push(current);
  if (parts.length <= 1) return parts[0] ?? '';

  const index = Math.min(Math.max(part, 1), parts.length) - 1;
  const more = index + 1 < parts.length ? ` For the next part, call ${tool} with part ${index + 2}.` : '';
  return `[part ${index + 1} of ${parts.length}.${more}]\n${parts[index]}`;
}
